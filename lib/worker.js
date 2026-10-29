/**
 * dsh-voice-speak — resident local speaker (V3.2.0).
 *
 * One PowerShell process stays alive for the whole plugin lifetime, opens the
 * default playback device exactly once with `waveOutOpen`, and never closes it
 * between sentences. That matters for Bluetooth headphones: A2DP drops whatever
 * the headset has buffered when the application closes the audio stream, so a
 * per-sentence child process cuts the last character off every line. Keeping the
 * stream open means the headset simply runs out of data and plays silence until
 * the next sentence arrives — nothing is discarded.
 *
 * The process is also a synthesizer: it keeps one `SpeechSynthesizer` selected on
 * the local Xiaoxiao voice and renders each sentence straight into a temporary
 * wave file, then feeds the PCM to the open device. One process spawn per
 * session instead of one per sentence.
 *
 * Protocol (one line each way, ASCII only):
 *   parent → child: `speak <base64 text> <base64 wav path>` | `quit`
 *   child → parent: `ready` | `unavailable` | `ok <audio ms>` | `err <message>`
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
            int opened = Open(22050, 1, 16);
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
 * @param {{ voiceMatch: string, pitch: string, rate: string, tailPadMs: number }} config - voice shape and padding.
 * @returns {string} PowerShell source.
 */
function buildScript(config) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cs = @'
${CSHARP}
'@
try { Add-Type -TypeDefinition $cs -Language CSharp } catch { }
try { [void][DshAudio]::Open(22050, 1, 16) } catch { }

Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voiceMatches = @($voice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like '*${config.voiceMatch}*' })
if ($voiceMatches.Count -eq 0) {
  [Console]::Out.WriteLine('unavailable')
  exit 4
}
try { $voice.SelectVoice($voiceMatches[0].VoiceInfo.Name) } catch { }
[Console]::Out.WriteLine('ready')

function Read-Wav([string]$path) {
  $b = [IO.File]::ReadAllBytes($path)
  $pos = 12
  $rate = 22050
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

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'quit') { break }
  $parts = $line -split ' '
  if ($parts.Count -lt 3 -or $parts[0] -ne 'speak') {
    [Console]::Out.WriteLine('err badline')
    continue
  }
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $wav = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
    $escaped = [System.Security.SecurityElement]::Escape($text)
    $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody pitch="${config.pitch}" rate="${config.rate}">' + $escaped + '</prosody></speak>'
    $voice.SetOutputToWaveFile($wav)
    try { $voice.SpeakSsml($ssml) } catch { $voice.Speak($text) }
    $voice.SetOutputToNull()
    $info = Read-Wav $wav
    $pcm = $info.pcm
    $stride = [int]($info.bits / 8) * $info.channels
    $padLen = [int]($info.rate * ${config.tailPadMs} / 1000) * $stride
    $audioMs = [int](1000.0 * $pcm.Length / $stride / $info.rate)
    $padded = [byte[]]::new($pcm.Length + $padLen)
    [Array]::Copy($pcm, 0, $padded, 0, $pcm.Length)
    $rc = [DshAudio]::Play($padded, 60000)
    Remove-Item $wav -ErrorAction SilentlyContinue
    if ($rc -eq 0) { [Console]::Out.WriteLine('ok ' + $audioMs) }
    else { [Console]::Out.WriteLine('err waveout-' + $rc) }
  } catch {
    $msg = $_.Exception.Message -replace '[^\x20-\x7E]', '?'
    [Console]::Out.WriteLine('err ' + $msg)
  }
}
try { [DshAudio]::Close() } catch { }
try { $voice.Dispose() } catch { }
`
}

/**
 * A resident synthesizer + player. One per plugin lifetime; recreated lazily
 * after a crash or an idle shutdown.
 */
export class LocalSpeaker {
  /**
   * @param {{ voiceMatch: string, pitch: string, rate: string, tailPadMs: number, idleMs?: number, logFd?: number|null, onLog?: (line: string) => void }} config - worker configuration.
   */
  constructor(config) {
    this.config = config
    this.child = null
    this.buffer = ''
    this.pending = null
    this.state = 'new'
    this.idleTimer = null
    this.readyWaiter = null
  }

  /**
   * Speak one sentence through the resident device.
   * @param {string} text - sentence to speak.
   * @returns {Promise<{ status: 'ok', audioMs: number } | { status: 'unavailable' } | { status: 'error', message: string }>} outcome.
   */
  async speak(text) {
    const started = Date.now()
    const wav = join(tmpdir(), `dsh-say-${randomUUID()}.wav`)
    const encodedText = Buffer.from(text, 'utf8').toString('base64')
    const encodedWav = Buffer.from(wav, 'utf8').toString('base64')
    const line = `speak ${encodedText} ${encodedWav}`
    const reply = await this.exchange(line)
    const elapsed = Date.now() - started
    if (reply === 'unavailable') {
      this.state = 'unavailable'
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
   * @returns {Promise<import('node:child_process').ChildProcess | null>} the child, or null when the voice is absent.
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
    if (line === 'ready') {
      this.state = 'ready'
      this.settleReady()
      return
    }
    if (line === 'unavailable') {
      this.state = 'unavailable'
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
