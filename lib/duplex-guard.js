/**
 * dsh-voice-speak — full-duplex interlock.
 *
 * `@dsh-voice/voice` runs a conversation loop of its own: it listens on
 * `agent/assistant-stream` and speaks every assistant sentence by itself. It has
 * no idea this plugin's `say` exists, so a `say` issued during that loop lands on
 * top of its own voice — two engines, one sentence, twice. The interlock asks
 * voice's own status endpoint whether a full-duplex session is attached and mutes
 * this plugin while one is. Voice keeps its own mouth; we keep ours shut.
 *
 * Facts this file depends on (measured 2026-11-14):
 *   - `GET /voice/status` on the host's own web server answers **200 with no
 *     token**: `{ ready, provider, sessions: [agentId, ...] }`. `sessions` is
 *     non-empty exactly while a client holds the voice socket open, so it is a
 *     better signal than `ready` (models load lazily, `ready` is false even when
 *     a session is live).
 *   - The endpoint lives on the same web server the GUI is served from, so its
 *     port comes from the `webServer` service. The port changes when the host
 *     picks a new one, so it is re-read instead of cached forever.
 *   - Every failure — no `webServer` service, voice not installed, timeout, 404,
 *     non-JSON body — means "no duplex". A broken voice plugin must never be able
 *     to mute ordinary speech.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Voice's route base inside the host web server (`lib/index.js` BASE_PATH). */
const VOICE_STATUS_PATH = '/voice/status'

/** How long one status answer stays trusted. */
const CACHE_MS = 1200

/** A wedged host must not hold a `say` open longer than this. */
const TIMEOUT_MS = 250

/** Where the launcher records the URL of the running GUI, as a port fallback. */
const LAST_URL_FILE = join(homedir(), '.dsh', 'tools', 'dsh-last-url.txt')

/** A `host` value that is a bind address rather than something fetchable. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*'])

/**
 * Turn a server bind host into something a loopback fetch can use.
 * @param {unknown} host - `webServer.host`, usually `127.0.0.1`.
 * @returns {string} a fetchable host.
 */
function fetchableHost(host) {
  const text = typeof host === 'string' ? host.trim() : ''
  if (text === '' || WILDCARD_HOSTS.has(text)) return '127.0.0.1'
  return text
}

/**
 * Read the port out of the launcher's URL record.
 * @returns {number | null} a TCP port, or null when the file is missing/unusable.
 */
function portFromLastUrl() {
  try {
    if (!existsSync(LAST_URL_FILE)) return null
    const url = new URL(readFileSync(LAST_URL_FILE, 'utf8').trim())
    const port = Number(url.port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/**
 * Resolve the base URL of the host's own web server.
 * @param {object} ctx - plugin context.
 * @returns {string | null} e.g. `http://127.0.0.1:3080`, or null when unknown.
 */
function resolveBaseUrl(ctx) {
  try {
    const web = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
    const port = Number(web?.port)
    if (Number.isInteger(port) && port > 0) {
      const protocol = web?.protocol === 'https:' ? 'https:' : 'http:'
      return `${protocol}//${fetchableHost(web?.host)}:${port}`
    }
  } catch {
    // Fall through to the URL record.
  }
  const port = portFromLastUrl()
  return port === null ? null : `http://127.0.0.1:${port}`
}

/**
 * Whether a full-duplex voice session is attached right now.
 * @param {string} baseUrl - host web server root.
 * @param {AbortSignal} signal - timeout signal.
 * @returns {Promise<boolean>} true when voice reports a live session.
 */
async function probe(baseUrl, signal) {
  const response = await fetch(`${baseUrl}${VOICE_STATUS_PATH}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return false
  const body = await response.json()
  const sessions = body?.sessions
  return Array.isArray(sessions) && sessions.length > 0
}

/**
 * Create the interlock.
 *
 * `isActive()` is safe to call on every utterance: it answers from a short-lived
 * cache, and any error — including a timeout — resolves to false.
 *
 * @param {object} options - wiring.
 * @param {object} options.ctx - plugin context, used to find the web server port.
 * @param {(message: string) => void} [options.log] - one-line logger.
 * @param {boolean} [options.enabled] - `false` disables the interlock entirely.
 * @param {() => string | null} [options.resolveBase] - test seam for the base URL.
 * @returns {{ isActive: () => Promise<boolean>, resolveBaseUrl: () => string | null }} the guard.
 */
export function createDuplexGuard(options = {}) {
  const { ctx } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const enabled = options.enabled !== false
  const base = typeof options.resolveBase === 'function'
    ? options.resolveBase
    : () => resolveBaseUrl(ctx)

  let cachedAt = 0
  let cachedValue = false
  let warnedNoBase = false

  return {
    resolveBaseUrl: base,

    async isActive() {
      if (!enabled) return false
      const now = Date.now()
      if (now - cachedAt < CACHE_MS) return cachedValue

      const baseUrl = base()
      if (baseUrl === null) {
        if (!warnedNoBase) {
          warnedNoBase = true
          log('全双工互斥：找不到宿主 web 端口，按「未开全双工」处理')
        }
        cachedAt = now
        cachedValue = false
        return false
      }

      let active = false
      try {
        active = await probe(baseUrl, AbortSignal.timeout(TIMEOUT_MS))
      } catch {
        // Timeout, refused, 404, bad JSON: voice is not there, so not duplex.
        active = false
      }
      cachedAt = Date.now()
      cachedValue = active
      return active
    },
  }
}
