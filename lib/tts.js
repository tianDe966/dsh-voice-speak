/**
 * dsh-voice-speak — playback layer.
 *
 * Two engines behind one queue:
 *   - `edge` (default): synthesizes MP3 through Microsoft's Edge read-aloud
 *     service (see `edge.js`) and plays it with MCI's blocking `play … wait`, so
 *     the queue knows exactly when a sentence is over. This is the natural voice.
 *   - `sapi` (fallback): Windows `System.Speech` through PowerShell, used
 *     whenever Edge fails (offline, protocol change, timeout). Zero dependency.
 *
 * Sentences are serialized: one sentence plays at a time and later calls wait in
 * a queue of at most {@link MAX_QUEUE}, oldest waiting sentence dropped first.
 * Two concurrent calls used to overlap for 7.17 s and became unintelligible.
 *
 * `play()` never throws and never awaits the caller. Measured on this machine
 * (2026-10-27):
 *   - Edge: ~1.2 s to first sound for a 20-character sentence, then real duration.
 *   - SAPI: the PowerShell child dies with 0xC0000142 when all its std handles are
 *     NUL, so stdout always points at a real file descriptor.
 *   - `detached: true` is unusable here: every detached child exited 0 within
 *     ~150–250 ms without running its command. Children are `unref()`ed instead.
 *   - When the host exits, a running child dies with it: the sentence is cut off,
 *     and there is no orphan speech to clean up.
 *
 * The local natural voice is rendered to a WAV file and then played from that
 * file, never streamed live: the NaturalVoiceSAPIAdapter drops the tail of a
 * live utterance (measured 2026-10-29 — every sentence lost its last character,
 * while the very same synth written with `SetOutputToWaveFile` ends with 162 ms
 * of clean trailing silence and plays back intact).
 *
 * Diagnostics land in `%TEMP%\dsh-voice-speak.log`, one line per utterance.
 */
import { spawn } from 'node:child_process'
import { openSync, writeFileSync, appendFileSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { synthesize } from './edge.js'

const IS_WINDOWS = process.platform === 'win32'
const POWERSHELL = 'powershell.exe'
const LOG_FILE = 'dsh-voice-speak.log'
const LOG_PATH = join(tmpdir(), LOG_FILE)
/**
 * Voice shape chosen for the 鲸鱼娘 persona (2026-10-27): Xiaoxiao lifted by
 * 10 Hz and slowed by 4% reads warmer and softer than her neutral news-anchor
 * delivery, while staying intelligible. Chosen by the user over Xiaoyi +12 Hz.
 */
const EDGE_VOICE = 'zh-CN-XiaoxiaoNeural'
const EDGE_PITCH = '+10Hz'
const EDGE_RATE = '-4%'
const PLAY_TIMEOUT_MS = 60_000

/**
 * Local counterpart of the Edge shape, installed through the Windows Narrator
 * natural voice "Microsoft Xiaoxiao" plus NaturalVoiceSAPIAdapter. SAPI 5 has no
 * numeric pitch, so the same lift is expressed in percent; both were A/B'd by
 * ear on 2026-10-28. If the voice is absent the script exits 4 and the cloud
 * path takes over.
 */
const LOCAL_VOICE_MATCH = 'Xiaoxiao'
const LOCAL_PITCH = '+10%'
const LOCAL_RATE = '-4%'
const LOCAL_UNAVAILABLE_EXIT = 4
/**
 * Digital silence appended to every rendered utterance before it is played.
 * The synthesized audio only carries 140–160 ms of natural trailing silence
 * (measured 2026-10-29), and the device path loses a slice of the tail when the
 * playback process closes the stream — enough to bite into the final character
 * on a sentence that ends abruptly. 400 ms of padding absorbs that loss (and
 * any future one up to the same order) without touching the speech itself.
 */
const LOCAL_TAIL_PAD_MS = 400
/** Wait this long after playback before the child exits and releases the device. */
const LOCAL_DRAIN_MS = 500

/**
 * The cloud path sometimes drops a fresh WebSocket (`read ECONNRESET`) and works
 * on the next attempt; retrying keeps the locked voice instead of degrading to the
 * built-in SAPI voice, which sounds noticeably older. Measured 2026-10-28: ~37% of
 * single attempts reset, so three attempts with growing backoff cut the fallback
 * rate to a few percent at the cost of ~1.6 s when every attempt fails.
 */
const SYNTH_ATTEMPTS = 3
const SYNTH_RETRY_DELAYS_MS = [400, 1200]

/**
 * Engine preference: `auto` (default) tries the installed local Xiaoxiao
 * natural voice first, then Edge, then built-in SAPI. `local` forces the local
 * voice, `edge` skips it, `sapi` skips both network and natural voices. The
 * local path is the one that works offline; Edge is kept as a fallback.
 */
const FORCED_ENGINE = process.env.DSH_VOICE_SPEAK_ENGINE ?? 'auto'

/** How many sentences may wait behind the one being spoken. */
const MAX_QUEUE = 3

/** Pending sentences, oldest first. One sentence plays at a time. */
const queue = []
let speaking = false
/** `unknown` until the first local attempt; `missing` skips the spawn afterwards. */
let localState = 'unknown'

/** The child's stdout sink: one fd for the whole plugin lifetime. */
let logFd = null
try {
  logFd = openSync(LOG_PATH, 'a')
} catch {
  logFd = null
}
const CHILD_STDIO = ['ignore', logFd ?? 'ignore', 'ignore']

/**
 * Play one MP3 file and block until MCI reports it finished.
 * The path travels in an environment variable, so Windows paths with spaces and
 * `$` need no escaping.
 */
const PLAY_SCRIPT = `$ErrorActionPreference = 'Stop'
$code = @'
[DllImport("winmm.dll", CharSet = CharSet.Auto)]
public static extern int mciSendString(string command, System.Text.StringBuilder returnValue, int returnLength, System.IntPtr callback);
'@
Add-Type -Namespace Dsh -Name Mci -MemberDefinition $code
$file = $env:DSH_SAY_FILE
$open = [Dsh.Mci]::mciSendString('open "' + $file + '" type mpegvideo alias dshsay', $null, 0, [IntPtr]::Zero)
if ($open -ne 0) { exit 2 }
$play = [Dsh.Mci]::mciSendString('play dshsay wait', $null, 0, [IntPtr]::Zero)
[void][Dsh.Mci]::mciSendString('close dshsay', $null, 0, [IntPtr]::Zero)
if ($play -ne 0) { exit 3 }
`

/** Windows `System.Speech` fallback; text arrives as `$env:DSH_SAY_TEXT`. */
const SAPI_SCRIPT = `$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP '${LOG_FILE}'
$t0 = Get-Date
try {
  Add-Type -AssemblyName System.Speech
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice.Speak($env:DSH_SAY_TEXT)
  $voice.Dispose()
  $outcome = 'OK'
} catch {
  $outcome = 'ERR ' + $_.Exception.Message
}
try {
  $ms = ((Get-Date) - $t0).TotalMilliseconds
  $line = '{0} engine=sapi mode={1} len={2} ms={3:N0} {4}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $ExecutionContext.SessionState.LanguageMode, $env:DSH_SAY_TEXT.Length, $ms, $outcome
  for ($i = 0; $i -lt 5; $i++) {
    try { Add-Content -Path $log -Value $line -Encoding utf8; break } catch { Start-Sleep -Milliseconds 50 }
  }
} catch {}
`

const PLAY_COMMAND = Buffer.from(PLAY_SCRIPT, 'utf16le').toString('base64')
const SAPI_COMMAND = Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64')

/**
 * Local natural-voice path. Exits 4 when the adapter is not installed, so the
 * queue can fall through to Edge without treating it as a failure. Text arrives
 * as `$env:DSH_SAY_TEXT`, never interpolated into the script.
 *
 * The utterance is rendered to `$env:DSH_SAY_WAV` and played from that file.
 * Live `Speak()` output through NaturalVoiceSAPIAdapter loses the end of every
 * sentence; the same synthesis written to a wave file is complete and plays
 * back unchanged. The 250 ms wait before exit keeps the child from releasing
 * the device while the last buffer is still draining.
 */
const LOCAL_SCRIPT = `$ErrorActionPreference = 'Stop'
function Add-TailSilence([string]$path, [int]$ms) {
  $b = [IO.File]::ReadAllBytes($path)
  $pos = 12
  $dataPos = -1
  $dataLen = 0
  $rate = 22050
  $ch = 1
  $bits = 16
  while ($pos -lt $b.Length - 8) {
    $id = [Text.Encoding]::ASCII.GetString($b, $pos, 4)
    $size = [BitConverter]::ToInt32($b, $pos + 4)
    if ($id -eq 'fmt ') {
      $ch = [BitConverter]::ToInt16($b, $pos + 10)
      $rate = [BitConverter]::ToInt32($b, $pos + 12)
      $bits = [BitConverter]::ToInt16($b, $pos + 22)
    }
    elseif ($id -eq 'data') { $dataPos = $pos; $dataLen = $size; break }
    if ($size -le 0) { break }
    $pos += 8 + $size
  }
  if ($dataPos -lt 0) { return }
  $stride = [int]($bits / 8) * $ch
  $pad = [byte[]]::new([int]($rate * $ms / 1000) * $stride)
  $end = $dataPos + 8 + $dataLen
  $out = [byte[]]::new($b.Length + $pad.Length)
  [Array]::Copy($b, 0, $out, 0, $end)
  [Array]::Copy($pad, 0, $out, $end, $pad.Length)
  [Array]::Copy([BitConverter]::GetBytes([int]($out.Length - 8)), 0, $out, 4, 4)
  [Array]::Copy([BitConverter]::GetBytes([int]($dataLen + $pad.Length)), 0, $out, ($dataPos + 4), 4)
  [IO.File]::WriteAllBytes($path, $out)
}
try {
  Add-Type -AssemblyName System.Speech
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voiceMatches = @($voice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like '*${LOCAL_VOICE_MATCH}*' })
  if ($voiceMatches.Count -eq 0) { $voice.Dispose(); exit ${LOCAL_UNAVAILABLE_EXIT} }
  $voice.SelectVoice($voiceMatches[0].VoiceInfo.Name)
  $text = $env:DSH_SAY_TEXT
  $escaped = [System.Security.SecurityElement]::Escape($text)
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody pitch="${LOCAL_PITCH}" rate="${LOCAL_RATE}">' + $escaped + '</prosody></speak>'
  $wav = $env:DSH_SAY_WAV
  $voice.SetOutputToWaveFile($wav)
  try { $voice.SpeakSsml($ssml) } catch { $voice.Speak($text) }
  $voice.SetOutputToNull()
  $voice.Dispose()
  if (-not (Test-Path $wav)) { exit 5 }
  Add-TailSilence $wav ${LOCAL_TAIL_PAD_MS}
  $player = New-Object System.Media.SoundPlayer $wav
  $player.PlaySync()
  Start-Sleep -Milliseconds ${LOCAL_DRAIN_MS}
  exit 0
} catch {
  try {
    $log = Join-Path $env:TEMP '${LOG_FILE}'
    $line = '{0} engine=local voice=${LOCAL_VOICE_MATCH} len={1} ERR {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $env:DSH_SAY_TEXT.Length, $_.Exception.Message
    Add-Content -Path $log -Value $line -Encoding utf8
  } catch {}
  exit 5
}
`
const LOCAL_COMMAND = Buffer.from(LOCAL_SCRIPT, 'utf16le').toString('base64')

/**
 * Queue one sentence and return immediately.
 * @param {string} text - the sentence to speak.
 * @param {(message: string) => void} [onError] - failure sink; never awaited.
 * @returns {void}
 */
export function play(text, onError, onPlayed) {
  if (!IS_WINDOWS) return
  const payload = typeof text === 'string' ? text : ''
  if (payload.trim() === '') return

  queue.push({ text: payload, onError, onPlayed })
  while (queue.length > MAX_QUEUE) queue.shift()
  void pump()
}

/**
 * Speak the next queued sentence, if nothing is speaking right now.
 * @returns {Promise<void>} resolved when the queue has been pumped once.
 */
async function pump() {
  if (speaking) return
  const next = queue.shift()
  if (next === undefined) return

  speaking = true
  try {
    let spoken = false
    if (FORCED_ENGINE !== 'sapi' && FORCED_ENGINE !== 'edge') {
      spoken = await speakWithLocal(next.text, next.onError, next.onPlayed)
    }
    if (!spoken && FORCED_ENGINE !== 'sapi') {
      spoken = await speakWithEdge(next.text, next.onError, next.onPlayed)
    }
    if (!spoken) await speakWithSapi(next.text, next.onError, next.onPlayed)
  } catch (error) {
    report(next.onError, error)
  } finally {
    speaking = false
    void pump()
  }
}

/**
 * Synthesize with bounded retries: a dropped WebSocket is usually transient, and
 * retrying is far cheaper than falling back to a voice the user did not choose.
 * @param {string} text - the sentence.
 * @returns {Promise<Buffer>} MP3 bytes.
 */
async function synthesizeWithRetry(text) {
  let lastError
  for (let attempt = 1; attempt <= SYNTH_ATTEMPTS; attempt += 1) {
    try {
      return await synthesize(text, { voice: EDGE_VOICE, pitch: EDGE_PITCH, rate: EDGE_RATE })
    } catch (error) {
      lastError = error
      logLine(`engine=edge attempt=${attempt} len=${text.length} ERR ${oneLine(error)}`)
      const delay = SYNTH_RETRY_DELAYS_MS[attempt - 1]
      if (attempt < SYNTH_ATTEMPTS && delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/**
 * Edge synthesis plus MCI playback.
 * @param {string} text - the sentence.
 * @param {(message: string) => void} [onError] - failure sink.
 * @param {(timing: { engine: string, synthMs: number, playMs: number }) => void} [onPlayed] - playback sink.
 * @returns {Promise<boolean>} true when the sentence was played.
 */
async function speakWithEdge(text, onError, onPlayed) {
  const started = Date.now()
  let file
  try {
    const audio = await synthesizeWithRetry(text)
    const synthesized = Date.now() - started
    file = join(tmpdir(), `dsh-say-${randomUUID()}.mp3`)
    writeFileSync(file, audio)
    const played = await runChild(POWERSHELL, PLAY_COMMAND, { DSH_SAY_FILE: file })
    logLine(`engine=edge voice=${EDGE_VOICE} pitch=${EDGE_PITCH} rate=${EDGE_RATE} len=${text.length} synth_ms=${synthesized} play_ms=${played.ms} ${played.code === 0 ? 'OK' : `ERR mci ${played.code}`}`)
    notifyPlayed(onPlayed, { engine: 'edge', synthMs: synthesized, playMs: played.ms })
    return played.code === 0
  } catch (error) {
    logLine(`engine=edge voice=${EDGE_VOICE} len=${text.length} ERR ${oneLine(error)}`)
    report(onError, error)
    return false
  } finally {
    if (file) {
      try {
        unlinkSync(file)
      } catch {
        // A leftover temp file is not worth reporting.
      }
    }
  }
}

/**
 * Play through the installed local Xiaoxiao natural voice.
 * @param {string} text - the sentence.
 * @param {(message: string) => void} [onError] - failure sink.
 * @param {(timing: { engine: string, synthMs: number, playMs: number }) => void} [onPlayed] - playback sink.
 * @returns {Promise<boolean>} true when the sentence was played locally.
 */
async function speakWithLocal(text, onError, onPlayed) {
  if (localState === 'missing') return false
  const wav = join(tmpdir(), `dsh-say-${randomUUID()}.wav`)
  try {
    const { code, ms } = await runChild(POWERSHELL, LOCAL_COMMAND, { DSH_SAY_TEXT: text, DSH_SAY_WAV: wav })
    if (code === LOCAL_UNAVAILABLE_EXIT) {
      localState = 'missing'
      logLine(`engine=local voice=${LOCAL_VOICE_MATCH} len=${text.length} UNAVAILABLE`)
      return false
    }
    if (code !== 0) {
      logLine(`engine=local voice=${LOCAL_VOICE_MATCH} len=${text.length} ERR exit ${code}`)
      return false
    }
    localState = 'ready'
    const audioMs = wavDurationMs(wav)
    logLine(`engine=local voice=${LOCAL_VOICE_MATCH} pitch=${LOCAL_PITCH} rate=${LOCAL_RATE} len=${text.length} audio_ms=${audioMs} play_ms=${ms} OK`)
    notifyPlayed(onPlayed, { engine: 'local', synthMs: 0, playMs: ms })
    return true
  } catch (error) {
    logLine(`engine=local voice=${LOCAL_VOICE_MATCH} len=${text.length} ERR ${oneLine(error)}`)
    return false
  } finally {
    try {
      unlinkSync(wav)
    } catch {
      // A leftover wav is not worth reporting.
    }
  }
}

/**
 * Duration of a PCM wave file in milliseconds, read from its own header.
 * Returns 0 when the file is missing or not a wave file it understands.
 * @param {string} path - wave file path.
 * @returns {number} duration in whole milliseconds.
 */
function wavDurationMs(path) {
  try {
    const bytes = readFileSync(path)
    let pos = 12
    let rate = 0
    let dataLen = 0
    while (pos + 8 <= bytes.length) {
      const id = bytes.toString('ascii', pos, pos + 4)
      const size = bytes.readInt32LE(pos + 4)
      if (id === 'fmt ') rate = bytes.readInt32LE(pos + 12)
      else if (id === 'data') {
        dataLen = size
        break
      }
      if (size <= 0) break
      pos += 8 + size
    }
    if (!rate || !dataLen) return 0
    return Math.round((dataLen / 2 / rate) * 1000)
  } catch {
    return 0
  }
}

/**
 * SAPI fallback through Windows `System.Speech`.
 * @param {string} text - the sentence.
 * @param {(message: string) => void} [onError] - failure sink.
 * @param {(timing: { engine: string, synthMs: number, playMs: number }) => void} [onPlayed] - playback sink.
 * @returns {Promise<void>} resolves when the PowerShell child exits.
 */
async function speakWithSapi(text, onError, onPlayed) {
  try {
    const { code, ms } = await runChild(POWERSHELL, SAPI_COMMAND, { DSH_SAY_TEXT: text })
    if (code !== 0) report(onError, new Error(`SAPI 播放进程退出码 ${code}`))
    else notifyPlayed(onPlayed, { engine: 'sapi', synthMs: 0, playMs: ms })
  } catch (error) {
    report(onError, error)
  }
}

/**
 * Hand the measured playback timing to the caller without ever throwing.
 * @param {((timing: { engine: string, synthMs: number, playMs: number }) => void) | undefined} onPlayed - sink.
 * @param {{ engine: string, synthMs: number, playMs: number }} timing - measured timings.
 * @returns {void}
 */
function notifyPlayed(onPlayed, timing) {
  if (typeof onPlayed !== 'function') return
  try {
    onPlayed(timing)
  } catch {
    // A consumer that throws must not break the speaker.
  }
}

/**
 * Run one PowerShell child and resolve when it exits.
 * The child is `unref()`ed so a host shutdown is never held back by a sentence.
 * @param {string} command - executable.
 * @param {string} encodedCommand - base64 UTF-16LE script.
 * @param {Record<string, string>} extraEnv - environment additions.
 * @returns {Promise<{ code: number|null, ms: number }>} exit code and duration.
 */
function runChild(command, encodedCommand, extraEnv) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let child
    try {
      child = spawn(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
        stdio: CHILD_STDIO,
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ms = Date.now() - started
      if (error) reject(error)
      else resolve({ code: result, ms })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish(null, new Error('播放超时'))
    }, PLAY_TIMEOUT_MS)
    child.on('error', (error) => finish(null, error))
    child.on('exit', (code) => finish(code, null))
    child.unref()
  })
}

/**
 * Append one diagnostic line without ever letting logging throw.
 * @param {string} line - the line body, prefixed with the current timestamp.
 * @returns {void}
 */
function logLine(line) {
  try {
    const now = new Date()
    const pad = (value, width = 2) => String(value).padStart(width, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
      + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
    appendFileSync(LOG_PATH, `${stamp} ${line}\n`, 'utf8')
  } catch {
    // The log is diagnostic only.
  }
}

/**
 * Collapse an error into one line.
 * @param {unknown} error - the error.
 * @returns {string} its message.
 */
function oneLine(error) {
  const text = error && error.message ? error.message : String(error)
  return text.replaceAll('\r', ' ').replaceAll('\n', ' ')
}

/**
 * Log a playback failure without ever letting the log itself throw.
 * @param {(message: string) => void} [onError] - failure sink.
 * @param {unknown} error - the failure.
 * @returns {void}
 */
function report(onError, error) {
  if (typeof onError !== 'function') return
  try {
    onError(`播放失败：${oneLine(error)}`)
  } catch {
    // A logger that throws must not break the tool handler.
  }
}
