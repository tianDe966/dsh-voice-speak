/**
 * dsh-voice-speak — resident speaker (V3.2.0, extended in V3.2.2).
 *
 * One PowerShell process stays alive for the whole plugin lifetime, opens the
 * default playback device exactly once with `waveOutOpen`, and never closes it
 * between sentences. That matters for Bluetooth headphones: A2DP drops whatever
 * the headset has buffered when the application closes the audio stream, so a
 * per-sentence child process cuts the last character off every line. Keeping the
 * stream open means the headset simply runs out of data and plays silence until
 * the next sentence arrives — nothing is discarded.
 *
 * The process is also a synthesizer: it keeps one `SpeechSynthesizer`, prefers the
 * local Xiaoxiao natural voice, and falls back to whichever SAPI voice the machine
 * has. Every engine therefore ends up on the same open device:
 *   - local  : `speak`      — Xiaoxiao only; reports `unavailable` when absent
 *   - sapi   : `saydefault` — whatever voice the synthesizer selected
 *   - edge   : `play`       — a WAV file rendered elsewhere (Edge returns PCM WAV)
 *
 * Protocol (one line each way, ASCII only):
 *   parent → child: `speak <b64 text> <b64 wav path>`
 *                   `saydefault <b64 text> <b64 wav path>`
 *                   `play <b64 wav path>` | `mciplay <b64 mp3 path>` | `quit`
 *   child → parent: `ready local|default|none` | `unavailable` | `ok <audio ms>` | `err <message>`
 *
 * `mciplay` exists because the Edge service refuses PCM/WAV and only returns MP3,
 * which `waveOut` cannot take. So the MP3 still goes through MCI, but from inside
 * this resident process: the endpoint is kept busy by a looping silent WAV while
 * the file plays and for half a second after MCI reports the end, so Bluetooth
 * A2DP never sees the endpoint go idle and keeps the tail it buffered.
 *
 * Both payloads are base64 because the console encoding of a redirected pipe is
 * the ANSI code page, not UTF-8: a temp path under a Chinese user name arrived
 * mangled and the synth failed with "Could not find a part of the path". Keeping
 * the protocol pure ASCII makes the channel encoding-proof.
 *
 * The child exits on its own when its stdin closes, so a dead host never leaves
 * an orphan speaker behind.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const POWERSHELL = 'powershell.exe'

/** How long a single sentence may take before the worker is considered wedged. */
const SPEAK_TIMEOUT_MS = 90_000
/** Idle time after which the device is closed and the process leaves. */
const DEFAULT_IDLE_MS = 60_000
/** Playback format every engine is normalised to, so the device is opened once. */
const DEVICE_RATE = 24_000

const CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshAudio
{
    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll")]
    static extern int waveOutOpen(out IntPtr h, uint deviceId, ref WAVEFORMATEX fmt, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")]
    static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, uint size);
    [DllImport("winmm.dll")]
    static extern int waveOutWrite(IntPtr h, IntPtr hdr, uint size);
    [DllImport("winmm.dll")]
    static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, uint size);
    [DllImport("winmm.dll")]
    static extern int waveOutReset(IntPtr h);
    [DllImport("winmm.dll")]
    static extern int waveOutClose(IntPtr h);

    const uint WAVE_MAPPER = 0xFFFFFFFF;
    const uint WHDR_DONE = 0x1;

    [DllImport("winmm.dll", CharSet = CharSet.Auto)]
    static extern int mciSendString(string command, System.Text.StringBuilder returnValue, int returnLength, IntPtr callback);

    /** Fire one MCI command and return its error code. */
    public static int Mci(string command)
    {
        return mciSendString(command, null, 0, IntPtr.Zero);
    }

    static IntPtr handle = IntPtr.Zero;
    static readonly int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));

    public static bool IsOpen()
    {
        return handle != IntPtr.Zero;
    }

    public static int Open(int rate, int channels, int bits)
    {
        if (handle != IntPtr.Zero) return 0;
        WAVEFORMATEX f = new WAVEFORMATEX();
        f.wFormatTag = 1;
        f.nChannels = (ushort)channels;
        f.nSamplesPerSec = (uint)rate;
        f.wBitsPerSample = (ushort)bits;
        f.nBlockAlign = (ushort)(channels * bits / 8);
        f.nAvgBytesPerSec = (uint)rate * f.nBlockAlign;
        f.cbSize = 0;
        return waveOutOpen(out handle, WAVE_MAPPER, ref f, IntPtr.Zero, IntPtr.Zero, 0);
    }

    public static int Play(byte[] data, int timeoutMs)
    {
        if (handle == IntPtr.Zero)
        {
            int opened = Open(24000, 1, 16);
            if (opened != 0) return opened;
        }
        IntPtr buf = Marshal.AllocHGlobal(data.Length);
        IntPtr hdr = Marshal.AllocHGlobal(hdrSize);
        try
        {
            Marshal.Copy(data, 0, buf, data.Length);
            WAVEHDR h = new WAVEHDR();
            h.lpData = buf;
            h.dwBufferLength = (uint)data.Length;
            h.dwFlags = 0;
            Marshal.StructureToPtr(h, hdr, false);
            int rc = waveOutPrepareHeader(handle, hdr, (uint)hdrSize);
            if (rc != 0) return rc;
            rc = waveOutWrite(handle, hdr, (uint)hdrSize);
            if (rc != 0)
            {
                waveOutUnprepareHeader(handle, hdr, (uint)hdrSize);
                return rc;
            }
            int waited = 0;
            while (true)
            {
                WAVEHDR cur = (WAVEHDR)Marshal.PtrToStructure(hdr, typeof(WAVEHDR));
                if ((cur.dwFlags & WHDR_DONE) != 0) break;
                Thread.Sleep(10);
                waited += 10;
                if (waited > timeoutMs) break;
            }
            waveOutUnprepareHeader(handle, hdr, (uint)hdrSize);
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(hdr);
            Marshal.FreeHGlobal(buf);
        }
    }

    public static void Close()
    {
        if (handle != IntPtr.Zero)
        {
            waveOutReset(handle);
            waveOutClose(handle);
            handle = IntPtr.Zero;
        }
    }
}
`

/**
 * Build the resident worker script. Parameters are interpolated here (never at
 * runtime from user text), so the text always travels through stdin as base64.
 * @param {{ voiceMatch: string, pitch: string, rate: string, tailPadMs: number, deviceRate?: number }} config - voice shape and padding.
 * @returns {string} PowerShell source.
 */
function buildScript(config) {
  const deviceRate = config.deviceRate ?? DEVICE_RATE
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cs = @'
${CSHARP}
'@
try { Add-Type -TypeDefinition $cs -Language CSharp } catch { }
try { [void][DshAudio]::Open(${deviceRate}, 1, 16) } catch { }

Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voiceKind = 'none'
$voiceMatches = @($voice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like '*${config.voiceMatch}*' })
if ($voiceMatches.Count -gt 0) {
  try { $voice.SelectVoice($voiceMatches[0].VoiceInfo.Name); $voiceKind = 'local' } catch { }
}
if ($voiceKind -ne 'local') {
  $fallbacks = @($voice.GetInstalledVoices() | Where-Object { $_.Enabled })
  if ($fallbacks.Count -gt 0) {
    try { $voice.SelectVoice($fallbacks[0].VoiceInfo.Name); $voiceKind = 'default' } catch { }
  }
}
$waveFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${deviceRate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

function New-SilenceWav([string]$path, [int]$rate) {
  $dataLen = $rate * 2
  $b = [byte[]]::new(44 + $dataLen)
  [Text.Encoding]::ASCII.GetBytes('RIFF').CopyTo($b, 0)
  [BitConverter]::GetBytes([int](36 + $dataLen)).CopyTo($b, 4)
  [Text.Encoding]::ASCII.GetBytes('WAVEfmt ').CopyTo($b, 8)
  [BitConverter]::GetBytes([int]16).CopyTo($b, 16)
  [BitConverter]::GetBytes([int16]1).CopyTo($b, 20)
  [BitConverter]::GetBytes([int16]1).CopyTo($b, 22)
  [BitConverter]::GetBytes([int]$rate).CopyTo($b, 24)
  [BitConverter]::GetBytes([int]($rate * 2)).CopyTo($b, 28)
  [BitConverter]::GetBytes([int16]2).CopyTo($b, 32)
  [BitConverter]::GetBytes([int16]16).CopyTo($b, 34)
  [Text.Encoding]::ASCII.GetBytes('data').CopyTo($b, 36)
  [BitConverter]::GetBytes([int]$dataLen).CopyTo($b, 40)
  [IO.File]::WriteAllBytes($path, $b)
}

# A looping silent stream keeps the playback endpoint busy across an MCI file
# close, which is the moment A2DP drops whatever the headset still buffered.
$keepFile = Join-Path $env:TEMP ('dsh-keepalive-' + [Guid]::NewGuid().ToString('N') + '.wav')
$keepAlias = $false
try {
  New-SilenceWav $keepFile 8000
  $keepAlias = ([DshAudio]::Mci('open "' + $keepFile + '" type waveaudio alias dshkeep') -eq 0)
} catch { }

[Console]::Out.WriteLine('ready ' + $voiceKind)

function Read-Wav([string]$path) {
  $b = [IO.File]::ReadAllBytes($path)
  $pos = 12
  $rate = ${deviceRate}
  $ch = 1
  $bits = 16
  $dataOff = -1
  $dataLen = 0
  while ($pos -lt $b.Length - 8) {
    $id = [Text.Encoding]::ASCII.GetString($b, $pos, 4)
    $size = [BitConverter]::ToInt32($b, $pos + 4)
    if ($id -eq 'fmt ') {
      $ch = [BitConverter]::ToInt16($b, $pos + 10)
      $rate = [BitConverter]::ToInt32($b, $pos + 12)
      $bits = [BitConverter]::ToInt16($b, $pos + 22)
    }
    elseif ($id -eq 'data') { $dataOff = $pos + 8; $dataLen = $size; break }
    if ($size -le 0) { break }
    $pos += 8 + $size
  }
  if ($dataOff -lt 0) { throw 'no data chunk' }
  $len = [Math]::Min($dataLen, $b.Length - $dataOff)
  $pcm = [byte[]]::new($len)
  [Array]::Copy($b, $dataOff, $pcm, 0, $len)
  return @{ pcm = $pcm; rate = $rate; channels = $ch; bits = $bits }
}

function Play-Wav([string]$path) {
  $info = Read-Wav $path
  $stride = [int]($info.bits / 8) * $info.channels
  $audioMs = [int](1000.0 * $info.pcm.Length / $stride / $info.rate)
  $padLen = [int]($info.rate * ${config.tailPadMs} / 1000) * $stride
  $padded = [byte[]]::new($info.pcm.Length + $padLen)
  [Array]::Copy($info.pcm, 0, $padded, 0, $info.pcm.Length)
  $rc = [DshAudio]::Play($padded, 60000)
  if ($rc -ne 0) { throw ('waveout-' + $rc) }
  return $audioMs
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'quit') { break }
  $parts = $line -split ' '
  $cmd = $parts[0]
  try {
    if ($cmd -eq 'mciplay') {
      if ($parts.Count -lt 2) { [Console]::Out.WriteLine('err badline'); continue }
      $mp3 = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
      if ($keepAlias) { [void][DshAudio]::Mci('play dshkeep repeat') }
      $open = [DshAudio]::Mci('open "' + $mp3 + '" type mpegvideo alias dshsay')
      if ($open -ne 0) {
        if ($keepAlias) { [void][DshAudio]::Mci('stop dshkeep') }
        [Console]::Out.WriteLine('err mci-open-' + $open)
        continue
      }
      [void][DshAudio]::Mci('play dshsay wait')
      Start-Sleep -Milliseconds 500
      if ($keepAlias) { [void][DshAudio]::Mci('stop dshkeep') }
      [void][DshAudio]::Mci('close dshsay')
      [Console]::Out.WriteLine('ok 0')
      continue
    }
    if ($cmd -eq 'play') {
      if ($parts.Count -lt 2) { [Console]::Out.WriteLine('err badline'); continue }
      $wavPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
      $ms = Play-Wav $wavPath
      [Console]::Out.WriteLine('ok ' + $ms)
      continue
    }
    if ($cmd -eq 'speak' -or $cmd -eq 'saydefault') {
      if ($parts.Count -lt 3) { [Console]::Out.WriteLine('err badline'); continue }
      if ($voiceKind -eq 'none') { [Console]::Out.WriteLine('unavailable'); continue }
      if ($cmd -eq 'speak' -and $voiceKind -ne 'local') { [Console]::Out.WriteLine('unavailable'); continue }
      $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
      $wav = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
      $voice.SetOutputToWaveFile($wav, $waveFormat)
      try {
        if ($cmd -eq 'speak') {
          $escaped = [System.Security.SecurityElement]::Escape($text)
          $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody pitch="${config.pitch}" rate="${config.rate}">' + $escaped + '</prosody></speak>'
          $voice.SpeakSsml($ssml)
        } else {
          $voice.Speak($text)
        }
      } catch {
        $voice.Speak($text)
      }
      $voice.SetOutputToNull()
      $ms = Play-Wav $wav
      Remove-Item $wav -ErrorAction SilentlyContinue
      [Console]::Out.WriteLine('ok ' + $ms)
      continue
    }
    [Console]::Out.WriteLine('err badline')
  } catch {
    $msg = $_.Exception.Message -replace '[^\x20-\x7E]', '?'
    [Console]::Out.WriteLine('err ' + $msg)
  }
}
try { [DshAudio]::Close() } catch { }
try {
  if ($keepAlias) {
    [void][DshAudio]::Mci('stop dshkeep')
    [void][DshAudio]::Mci('close dshkeep')
  }
} catch { }
try { Remove-Item $keepFile -ErrorAction SilentlyContinue } catch { }
try { $voice.Dispose() } catch { }
`
}

/**
 * A resident synthesizer + player. One per plugin lifetime; recreated lazily
 * after a crash or an idle shutdown.
 */
export class LocalSpeaker {
  /**
   * @param {{ voiceMatch: string, pitch: string, rate: string, tailPadMs: number, deviceRate?: number, idleMs?: number, logFd?: number|null }} config - worker configuration.
   */
  constructor(config) {
    this.config = config
    this.child = null
    this.buffer = ''
    this.pending = null
    this.state = 'new'
    this.voiceKind = 'unknown'
    this.idleTimer = null
    this.readyWaiter = null
  }

  /**
   * Speak one sentence through the resident device with the local natural voice.
   * @param {string} text - sentence to speak.
   * @returns {Promise<{ status: 'ok', audioMs: number } | { status: 'unavailable' } | { status: 'error', message: string }>} outcome.
   */
  async speak(text) {
    return this.run(`speak ${b64(text)} ${b64(this.tempWav())}`)
  }

  /**
   * Speak one sentence with whichever SAPI voice the worker selected.
   * @param {string} text - sentence to speak.
   * @returns {Promise<{ status: 'ok', audioMs: number } | { status: 'unavailable' } | { status: 'error', message: string }>} outcome.
   */
  async sayDefault(text) {
    return this.run(`saydefault ${b64(text)} ${b64(this.tempWav())}`)
  }

  /**
   * Play an existing WAV file through the resident device, without closing it.
   * @param {string} path - WAV file path.
   * @returns {Promise<{ status: 'ok', audioMs: number } | { status: 'unavailable' } | { status: 'error', message: string }>} outcome.
   */
  async playFile(path) {
    return this.run(`play ${b64(path)}`)
  }

  /**
   * Play an MP3 file through MCI inside the resident process, with the silent
   * keep-alive stream running so the endpoint never goes idle mid-close.
   * @param {string} path - MP3 file path.
   * @returns {Promise<{ status: 'ok', audioMs: number } | { status: 'unavailable' } | { status: 'error', message: string }>} outcome.
   */
  async playMci(path) {
    return this.run(`mciplay ${b64(path)}`)
  }

  /** @returns {string} a fresh temp WAV path. */
  tempWav() {
    return join(tmpdir(), `dsh-say-${randomUUID()}.wav`)
  }

  /**
   * Send one request and normalise the reply.
   * @param {string} line - request line.
   * @returns {Promise<{ status: 'ok', audioMs: number } | { status: 'unavailable' } | { status: 'error', message: string }>} outcome.
   */
  async run(line) {
    const started = Date.now()
    const reply = await this.exchange(line)
    const elapsed = Date.now() - started
    if (reply === 'unavailable') {
      if (this.voiceKind === 'none') this.state = 'unavailable'
      return { status: 'unavailable' }
    }
    if (reply.startsWith('ok ')) {
      const audioMs = Number.parseInt(reply.slice(3), 10)
      return { status: 'ok', audioMs: Number.isFinite(audioMs) ? audioMs : 0, elapsed }
    }
    return { status: 'error', message: reply.replace(/^err ?/, '') || 'worker error' }
  }

  /**
   * Send one request line and resolve with the worker's reply.
   * @param {string} line - request.
   * @returns {Promise<string>} reply, or `err …` on failure/timeout.
   */
  async exchange(line) {
    this.clearIdle()
    let child
    try {
      child = await this.ensure()
    } catch (error) {
      return `err ${error instanceof Error ? error.message : String(error)}`
    }
    if (child === null) return 'unavailable'
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null
        this.kill()
        resolve('err timeout')
      }, SPEAK_TIMEOUT_MS)
      if (timer.unref) timer.unref()
      this.pending = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      try {
        child.stdin.write(`${line}\n`)
      } catch (error) {
        this.pending = null
        clearTimeout(timer)
        resolve(`err ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    this.armIdle()
    return answer
  }

  /**
   * Spawn the worker if needed and wait for its readiness line.
   * @returns {Promise<import('node:child_process').ChildProcess | null>} the child, or null when no voice exists at all.
   */
  async ensure() {
    if (this.child !== null && this.child.exitCode === null && this.state === 'ready') return this.child
    if (this.state === 'unavailable') return null
    if (this.child !== null && this.child.exitCode === null) {
      await this.waitReady()
      return this.state === 'ready' ? this.child : null
    }

    const script = buildScript(this.config)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', this.config.logFd ?? 'ignore'],
      windowsHide: true,
    })
    this.child = child
    this.buffer = ''
    this.state = 'starting'

    const ready = new Promise((resolve) => {
      this.readyWaiter = resolve
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.on('error', () => {
      this.state = 'dead'
      this.settleReady()
      this.failPending('err spawn-failed')
    })
    child.on('exit', (code) => {
      this.child = null
      if (this.state !== 'unavailable') this.state = 'dead'
      this.settleReady()
      this.failPending(`err worker-exit-${code ?? 'signal'}`)
    })
    if (typeof child.unref === 'function') child.unref()

    await ready
    if (this.state === 'unavailable') return null
    return this.state === 'ready' ? this.child : null
  }

  /**
   * Handle one stdout chunk, splitting it into protocol lines.
   * @param {string} chunk - decoded stdout.
   * @returns {void}
   */
  onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  /**
   * Dispatch one protocol line.
   * @param {string} line - reply line.
   * @returns {void}
   */
  onLine(line) {
    if (line === 'ready' || line.startsWith('ready ')) {
      this.voiceKind = line.split(' ')[1] ?? 'local'
      this.state = 'ready'
      this.settleReady()
      return
    }
    if (line === 'unavailable') {
      this.settleReady()
      return
    }
    const pending = this.pending
    this.pending = null
    if (pending !== null) pending(line)
  }

  /** Release a waiting readiness promise. */
  settleReady() {
    const waiter = this.readyWaiter
    this.readyWaiter = null
    if (waiter !== null) waiter()
  }

  /**
   * Resolve a pending request after the worker died.
   * @param {string} line - failure line.
   * @returns {void}
   */
  failPending(line) {
    const pending = this.pending
    this.pending = null
    if (pending !== null) pending(line)
  }

  /** Wait until the worker reports ready or unavailable. */
  async waitReady() {
    if (this.state === 'ready' || this.state === 'unavailable') return
    await new Promise((resolve) => {
      const previous = this.readyWaiter
      this.readyWaiter = () => {
        if (previous !== null) previous()
        resolve()
      }
      setTimeout(resolve, 10_000)
    })
  }

  /** Start the idle countdown towards closing the device. */
  armIdle() {
    this.clearIdle()
    const idleMs = this.config.idleMs ?? DEFAULT_IDLE_MS
    this.idleTimer = setTimeout(() => this.shutdown(), idleMs)
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  /** Stop the idle countdown. */
  clearIdle() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /**
   * Ask the worker to close the device and exit, then drop the handle.
   * @returns {void}
   */
  shutdown() {
    this.clearIdle()
    const child = this.child
    if (child === null) return
    try {
      child.stdin.write('quit\n')
    } catch {
      // A closed stdin means the worker is already gone.
    }
    setTimeout(() => this.kill(), 2000)
  }

  /** Force the worker down. */
  kill() {
    const child = this.child
    this.child = null
    this.state = 'dead'
    if (child === null) return
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
}

/**
 * Base64-encode a protocol payload.
 * @param {string} value - text or path.
 * @returns {string} ASCII-safe payload.
 */
function b64(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}
