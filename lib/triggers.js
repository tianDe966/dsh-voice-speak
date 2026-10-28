/**
 * dsh-voice-speak — speech triggers (V3).
 *
 * The model still decides most of what is said, but four classes of moment are
 * too important to leave to a prompt:
 *
 *   - an approval is now waiting for the user;
 *   - a question is now waiting for the user;
 *   - a long turn or a long background job just finished.
 *
 * Those are detected from durable session/registry events here, so they speak
 * even when the model forgets. Everything else stays silent — the old
 * "every tool turn gets a done line" behaviour is gone.
 *
 * Balance rules: one automatic line per event, a quiet window after any speech
 * (including an explicit `say`), and a minimum duration before a completion is
 * worth announcing. All thresholds live at the top of this file.
 */

/** A completed turn shorter than this is routine work, not an outcome. */
const LONG_TURN_MS = 120_000
/** A long turn also has to have done real tool work. */
const LONG_TURN_MIN_TOOLS = 2
/** Do not say "done" when the user heard something this recently. */
const COMPLETION_QUIET_MS = 45_000
/** A background job shorter than this is not worth an announcement. */
const LONG_JOB_MS = 90_000
/** Automatic completion lines keep this much distance from any other speech. */
const AUTO_GAP_MS = 30_000
/** Approval/question/error lines are skipped when the model just spoke. */
const ECHO_MS = 10_000
/** Dedupe entries live this long; events never replay after hours. */
const RETENTION_MS = 6 * 60 * 60 * 1000

const FALLBACK_ENABLED = process.env.DSH_VOICE_SPEAK_FALLBACK !== 'off'

/**
 * Read a non-negative integer from the environment, falling back quietly.
 * @param {string} name - environment variable.
 * @param {number} fallback - default value.
 * @returns {number} threshold in milliseconds.
 */
function envMs(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Create the trigger controller used by the plugin entry.
 * @param {object} options - dependencies.
 * @param {(text: string) => void} options.speak - playback sink; called at most once per event.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {() => boolean} [options.isSilenced] - true while remote mode is active.
 * @returns {object} trigger methods.
 */
export function createSpeechTriggers({ speak, now = Date.now, isSilenced = () => false } = {}) {
  const silenced = () => {
    try {
      return isSilenced() === true
    } catch {
      return false
    }
  }

  const longTurnMs = envMs('DSH_VOICE_SPEAK_LONG_TURN_MS', LONG_TURN_MS)
  const longJobMs = envMs('DSH_VOICE_SPEAK_LONG_JOB_MS', LONG_JOB_MS)
  const autoGapMs = envMs('DSH_VOICE_SPEAK_AUTO_GAP_MS', AUTO_GAP_MS)

  /** Last time anything was said, explicit `say` included. */
  let lastSpokenAt = 0
  /** Per-session turn state, keyed by session id. */
  const turns = new Map()
  /** Dedupe sets for approvals, questions and jobs. */
  const approvals = new Map()
  const asks = new Map()
  const jobs = new Map()

  /**
   * Speak one automatic line, unless the sink fails.
   * @param {string} text - the sentence.
   * @returns {boolean} whether it was handed to playback.
   */
  const say = (text) => {
    if (silenced()) return false
    if (typeof speak !== 'function' || typeof text !== 'string' || text.trim() === '') return false
    try {
      speak(text)
    } catch {
      return false
    }
    lastSpokenAt = now()
    return true
  }

  /**
   * Remember a dedupe key and prune old entries when the map grows.
   * @param {Map<string, number>} map - dedupe map.
   * @param {string} key - event identity.
   * @returns {boolean} false when the key was already present.
   */
  const firstTime = (map, key) => {
    if (map.has(key)) return false
    map.set(key, now())
    if (map.size > 200) {
      const cutoff = now() - RETENTION_MS
      for (const [entry, at] of map) if (at < cutoff) map.delete(entry)
    }
    return true
  }

  /**
   * A pending question or approval matters even at the desk, but not twice.
   * @param {string} line - sentence to speak.
   * @returns {boolean} whether it spoke.
   */
  const alert = (line) => {
    if (now() - lastSpokenAt < ECHO_MS) return false
    return say(line)
  }

  return {
    /** The model called `say` itself; keep automatic lines out of its echo. */
    noteSpoken() {
      if (!silenced()) lastSpokenAt = now()
    },

    /**
     * Open a turn. Subagent turns are filtered by the caller.
     * @param {string|undefined} sessionId - session identity.
     */
    onTurnStart(sessionId) {
      const id = String(sessionId ?? '')
      if (id === '' || !FALLBACK_ENABLED) return
      if (turns.size > 100) {
        const cutoff = now() - RETENTION_MS
        for (const [key, turn] of turns) if (turn.startedAt < cutoff) turns.delete(key)
      }
      turns.set(id, { startedAt: now(), tools: 0 })
    },

    /**
     * Count one tool call in the current turn.
     * @param {string|undefined} sessionId - session identity.
     */
    onToolCall(sessionId) {
      const turn = turns.get(String(sessionId ?? ''))
      if (turn !== undefined) turn.tools += 1
    },

    /**
     * Announce a real approval request. Auto-review is not installed here, so
     * an `approval/asked` event always means the user is the answerer.
     * @param {string|undefined} sessionId - session identity.
     * @param {{ id?: unknown, toolName?: unknown, callId?: unknown }} [data] - audit event payload.
     */
    onApproval(sessionId, data) {
      if (!FALLBACK_ENABLED) return
      const id = String(sessionId ?? '')
      const key = data?.id !== undefined
        ? `approval:${String(data.id)}`
        : `approval:${id}:${String(data?.toolName ?? '')}:${String(data?.callId ?? '')}:${Math.floor(now() / 60_000)}`
      if (!firstTime(approvals, key)) return
      alert('老大，有个操作要你批一下。')
    },

    /**
     * Announce a pending `ask_user_question` call.
     * @param {string|undefined} sessionId - session identity.
     * @param {{ callId?: unknown }} [data] - tool/call payload.
     */
    onAsk(sessionId, data) {
      if (!FALLBACK_ENABLED) return
      const id = String(sessionId ?? '')
      const key = `ask:${id}:${String(data?.callId ?? '') || Math.floor(now() / 60_000)}`
      if (!firstTime(asks, key)) return
      alert('老大，有个问题要你定。')
    },

    /**
     * Announce a long background job that settled without a waiter.
     * @param {{ jobId?: unknown, startedAt?: unknown, finishedAt?: unknown, status?: unknown, cause?: unknown }} [job] - job facts.
     */
    onJobSettled(job) {
      if (!FALLBACK_ENABLED || job === undefined || job === null) return
      if (job.cause === 'teardown') return
      const startedAt = Number(job.startedAt)
      const finishedAt = Number(job.finishedAt)
      if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return
      if (finishedAt - startedAt < longJobMs) return
      const key = `job:${String(job.jobId ?? '')}`
      if (!firstTime(jobs, key)) return
      if (now() - lastSpokenAt < autoGapMs) return
      if (job.status === 'completed') say('老大，后台任务跑完了。')
      else if (job.status === 'failed') say('老大，后台任务失败了。')
    },

    /**
     * Close a turn: only long, completed work earns a "done" line; errors and
     * blockers are announced because the user has to look.
     * @param {string|undefined} sessionId - session identity.
     * @param {{ kind?: unknown }} [reason] - turn end reason.
     */
    onTurnEnd(sessionId, reason) {
      if (!FALLBACK_ENABLED) return
      const id = String(sessionId ?? '')
      const turn = turns.get(id)
      if (turn === undefined) return
      turns.delete(id)

      const kind = reason && typeof reason === 'object' ? reason.kind : undefined
      if (kind === 'error') {
        alert('老大，这轮出错了。')
        return
      }
      if (kind === 'blocked') {
        alert('老大，这轮卡住了。')
        return
      }
      if (kind !== 'completed') return

      const elapsed = now() - turn.startedAt
      if (elapsed < longTurnMs || turn.tools < LONG_TURN_MIN_TOOLS) return
      if (now() - lastSpokenAt < COMPLETION_QUIET_MS) return
      say('老大，这轮跑完了。')
    },
  }
}
