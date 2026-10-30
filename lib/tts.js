/**
 * dsh-voice-speak — playback layer.
 *
 * Three engines behind one queue, in priority order:
 *   - `local`: the installed Xiaoxiao natural voice through `System.Speech`, the
 *     preferred sound; reports `unavailable` when the machine has no such voice.
 *   - `edge`: Microsoft's Edge read-aloud service (see `edge.js`), asked for PCM
 *     WAV so the resident worker can play it without a per-sentence device.
 *   - `sapi` (last resort): whatever SAPI voice the worker selected.
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
 * The resident device (see `worker.js`) is what all three engines end on: one
 * process and one open playback device for the whole session, rendering each
 * sentence to a wave file and feeding the PCM to that device. Two findings from
 * 2026-10-29 shape this. Live `Speak()` output through NaturalVoiceSAPIAdapter
 * loses the end of every sentence (the file rendering of the same text is
 * complete), and A2DP headphones drop whatever they have buffered the instant the
 * stream closes. So the stream has to outlive the sentence instead of being opened
 * per line.
 *
 * V3.2.2 closes the same hole for the other two engines: `sapi` is synthesized
 * into the same device, and Edge's MP3 is played by the same resident process with
 * a looping silent stream holding the endpoint open across the MCI close. So a
 * Bluetooth headset keeps its stream no matter which engine ends up speaking. The
 * per-sentence PowerShell child survives only as a last resort when the worker
 * cannot start at all.
 *
 * Diagnostics land in `%TEMP%\dsh-voice-speak.log`, one line per utterance.
 */
import { spawn } from 'node:child_process'
import { openSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { synthesize } from './edge.js'
import { LocalSpeaker } from './worker.js'

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
/**
 * Offline synthesis helper (V3.4.0). `bin/dsh-tts-helper.exe` is built from
 * `tools/tts-helper/*.cs` and calls the Microsoft Embedded Speech SDK directly,
 * so the local voice no longer needs a SAPI registration, the
 * NaturalVoiceSAPIAdapter DLL or admin rights. System.Speech stays as the
 * fallback for machines that still have the adapter installed.
 *
 * The SDK binaries and the voice model deliberately live outside the repository
 * (they are Microsoft's, and the model is decrypted with a key recovered from
 * its own files) — override DSH_VOICE_SPEAK_SDK / DSH_VOICE_SPEAK_VOICE_DIR
 * when they move. DSH_VOICE_SPEAK_NO_HELPER=1 disables the helper entirely.
 */
const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-tts-helper.exe')
const HELPER_SDK = process.env.DSH_VOICE_SPEAK_SDK ?? 'D:\\DSH_Project\\TTS\\SpeechSDK\\win-x64'
const HELPER_VOICE = process.env.DSH_VOICE_SPEAK_VOICE_DIR ?? 'D:\\DSH_Project\\TTS\\NaturalVoices\\Xiaoxiao'
const HELPER_ENABLED = process.env.DSH_VOICE_SPEAK_NO_HELPER !== '1'
/** The helper renders a sentence in ~0.3 s; anything past this is a wedged SDK. */
const HELPER_TIMEOUT_MS = 15_000
/**
 * Digital silence appended to every rendered sentence before the device sees it.
 * The synthesized audio only carries 140–160 ms of natural trailing silence
 * (measured 2026-10-29); this keeps a margin in front of any downstream buffer
 * that a device still decides to drop.
 */
const LOCAL_TAIL_PAD_MS = 400
/**
 * How long the resident worker keeps the playback device open after the last
 * sentence. A2DP headphones drop whatever they have buffered when the stream is
 * closed, so the stream has to outlive the sentence; only a real idle gap closes it.
 */
const LOCAL_IDLE_MS = 60_000

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

/**
 * How long a playing sentence may hold the host's event loop open.
 *
 * Measured on this machine (2026-10-29): a Node child is killed the instant its
 * Node parent exits — every spawn shape, including `detached` (which does not
 * even start here, see the header). So a sentence cannot outlive the host on its
 * own, and nothing inside the worker can save it: the process is gone before its
 * stdin ever reaches EOF. The only lever left is the host side — keep the event
 * loop alive while audio plays, which this timer does by simply not being
 * `unref()`ed. It caps the wait so a wedged worker cannot block shutdown forever.
 *
 * This covers a host that exits by draining its event loop. A host that calls
 * `process.exit()` or dies from a console close / `taskkill /T` still cuts the
 * sentence; nothing in user code can change that.
 */
const HOLD_HOST_MAX_MS = 10_000

/** Pending sentences, oldest first. One sentence plays at a time. */
const queue = []
let speaking = false
/** Non-unref'd timer that keeps the host alive while audio plays; null when idle. */
let holdTimer = null
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
 * Last-resort SAPI speaker: one child process, its own audio device. Kept only for
 * the case where the resident worker cannot start at all; text arrives as
 * `$env:DSH_SAY_TEXT`.
 */
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

const SAPI_COMMAND = Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64')

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
  if (process.env.DSH_VOICE_SPEAK_NO_HOLD !== '1') holdHost()
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
    if (queue.length === 0) releaseHost()
    void pump()
  }
}

/**
 * Keep the host's event loop alive while a sentence plays, so a host that exits
 * by draining its loop waits for the audio instead of killing the worker mid-word.
 *
 * Deliberately not `unref()`ed — that is the entire mechanism. Re-armed for every
 * sentence, capped by {@link HOLD_HOST_MAX_MS}.
 * @returns {void}
 */
function holdHost() {
  if (holdTimer !== null) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    holdTimer = null
    logLine(`hold timeout: 语音未在 ${HOLD_HOST_MAX_MS} ms 内结束，已放行宿主退出`)
  }, HOLD_HOST_MAX_MS)
}

/**
 * Stop holding the event loop once nothing is left to say.
 * @returns {void}
 */
function releaseHost() {
  if (holdTimer === null) return
  clearTimeout(holdTimer)
  holdTimer = null
}

/**
 * Synthesize with bounded retries: a dropped WebSocket is usually transient, and
 * retrying is far cheaper than falling back to a voice the user did not choose.
 * @param {string} text - the sentence.
 * @returns {Promise<Buffer>} PCM WAV bytes.
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
 * Edge synthesis plus playback inside the resident worker.
 *
 * V3.2.2 stops opening a per-sentence MCI child: the MP3 is played by the worker
 * that already owns the audio endpoint, and a looping silent stream keeps that
 * endpoint busy across the MCI close — the moment A2DP drops the tail it buffered.
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
    const played = await localSpeaker().playMci(file)
    const playMs = Date.now() - started
    if (played.status !== 'ok') {
      const detail = played.status === 'error' ? oneLine(played.message) : played.status
      logLine(`engine=edge voice=${EDGE_VOICE} len=${text.length} ERR ${detail}`)
      report(onError, new Error(`Edge 播放失败：${detail}`))
      return false
    }
    logLine(`engine=edge voice=${EDGE_VOICE} pitch=${EDGE_PITCH} rate=${EDGE_RATE} len=${text.length} synth_ms=${synthesized} play_ms=${playMs} OK`)
    notifyPlayed(onPlayed, { engine: 'edge', synthMs: synthesized, playMs })
    return true
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
 * The resident synthesizer + player. One process for the whole plugin lifetime,
 * one open playback device: closing it per sentence is what cuts the tail off on
 * Bluetooth headphones. Recreated lazily after an idle shutdown or a crash.
 */
let speaker = null

function localSpeaker() {
  if (speaker === null) {
    speaker = new LocalSpeaker({
      voiceMatch: LOCAL_VOICE_MATCH,
      pitch: LOCAL_PITCH,
      rate: LOCAL_RATE,
      tailPadMs: LOCAL_TAIL_PAD_MS,
      idleMs: LOCAL_IDLE_MS,
      logFd,
    })
  }
  return speaker
}

/**
 * Render one sentence to a WAV with the bundled offline helper (V3.4.0).
 *
 * Preferred local engine: the helper talks to the Microsoft Embedded Speech SDK
 * directly, so no SAPI registration, adapter DLL or admin rights are involved.
 * Any failure resolves to null, which sends the caller on to System.Speech and
 * then to the cloud voice — never a silent turn.
 *
 * @param {string} text - the sentence.
 * @returns {Promise<string|null>} the rendered WAV path, or null.
 */
function renderWithHelper(text) {
  if (!HELPER_ENABLED) return Promise.resolve(null)
  const wav = join(tmpdir(), `dsh-helper-${randomUUID()}.wav`)
  const args = [
    '--sdk', HELPER_SDK,
    '--voice', HELPER_VOICE,
    '--out', wav,
    '--text-b64', Buffer.from(text, 'utf8').toString('base64'),
    '--pitch', LOCAL_PITCH,
    '--rate', LOCAL_RATE,
    '--timeout-ms', String(HELPER_TIMEOUT_MS),
  ]
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(HELPER_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      logLine(`engine=local via=helper spawn ERR ${oneLine(error)}`)
      resolve(null)
      return
    }
    let output = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }, HELPER_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      logLine(`engine=local via=helper ERR ${oneLine(error)}`)
      resolve(null)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        logLine(`engine=local via=helper exit=${code} ${oneLine(output.trim())}`)
        resolve(null)
        return
      }
      // The helper decides where the WAV really landed: the SDK refuses to open
      // output paths containing non-ASCII characters, so it may have rendered to
      // an ASCII scratch folder instead of the path we asked for.
      const match = /(?:^|\s)out=(\S+)/.exec(output)
      const landed = match === null ? wav : match[1]
      if (landed !== wav) {
        logLine(`engine=local via=helper out-path-remapped ${oneLine(landed)}`)
      }
      resolve(landed)
    })
    if (child.unref) child.unref()
  })
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
  const started = Date.now()

  const wav = await renderWithHelper(text)
  if (wav !== null) {
    const synthMs = Date.now() - started
    let played
    try {
      played = await localSpeaker().playFile(wav)
    } catch (error) {
      played = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    try {
      unlinkSync(wav)
    } catch {
      // A leftover temp file is not worth reporting.
    }
    if (played.status === 'ok') {
      localState = 'ready'
      const playMs = Date.now() - started
      logLine(`engine=local voice=${LOCAL_VOICE_MATCH} via=helper pitch=${LOCAL_PITCH} rate=${LOCAL_RATE} len=${text.length} synth_ms=${synthMs} audio_ms=${played.audioMs} play_ms=${playMs} OK`)
      notifyPlayed(onPlayed, { engine: 'local', synthMs, playMs })
      return true
    }
    logLine(`engine=local via=helper len=${text.length} ${played.status} ${oneLine(played.message)}`)
  }

  let result
  try {
    result = await localSpeaker().speak(text)
  } catch (error) {
    logLine(`engine=local voice=${LOCAL_VOICE_MATCH} len=${text.length} ERR ${oneLine(error)}`)
    return false
  }
  if (result.status === 'unavailable') {
    localState = 'missing'
    logLine(`engine=local voice=${LOCAL_VOICE_MATCH} len=${text.length} UNAVAILABLE`)
    return false
  }
  if (result.status !== 'ok') {
    logLine(`engine=local voice=${LOCAL_VOICE_MATCH} len=${text.length} ERR ${oneLine(result.message)}`)
    return false
  }
  localState = 'ready'
  const playMs = Date.now() - started
  logLine(`engine=local voice=${LOCAL_VOICE_MATCH} pitch=${LOCAL_PITCH} rate=${LOCAL_RATE} len=${text.length} audio_ms=${result.audioMs} play_ms=${playMs} OK`)
  notifyPlayed(onPlayed, { engine: 'local', synthMs: 0, playMs })
  return true
}

/**
 * SAPI fallback through the resident worker's selected voice.
 *
 * The per-sentence PowerShell child is kept as the last resort, only for the case
 * where the worker itself cannot start: it speaks through its own device, which is
 * exactly the path that truncates on Bluetooth.
 * @param {string} text - the sentence.
 * @param {(message: string) => void} [onError] - failure sink.
 * @param {(timing: { engine: string, synthMs: number, playMs: number }) => void} [onPlayed] - playback sink.
 * @returns {Promise<void>} resolves when the sentence finished or gave up.
 */
async function speakWithSapi(text, onError, onPlayed) {
  const started = Date.now()
  const direct = await localSpeaker().sayDefault(text)
  if (direct.status === 'ok') {
    const playMs = direct.elapsed ?? (Date.now() - started)
    logLine(`engine=sapi device=resident voice=default len=${text.length} audio_ms=${direct.audioMs} play_ms=${playMs} OK`)
    notifyPlayed(onPlayed, { engine: 'sapi', synthMs: 0, playMs })
    return
  }
  if (direct.status === 'error') {
    logLine(`engine=sapi device=resident len=${text.length} ERR ${oneLine(direct.message)}`)
  }
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
export function logLine(line) {
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
