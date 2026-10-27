/**
 * dsh-voice-speak — plugin entry.
 *
 * Two contributions, nothing else:
 *   1. the `say` tool (`ctx.tools.register`), whose handler hands the sentence
 *      to the playback layer and returns at once;
 *   2. the `voice-speak` prompt section (`ctx.systemPrompt.section`), whose text
 *      lives in `prompt.js`.
 *
 * The tool definition is a registry-ready `ToolDefinition` written by hand: the
 * official `defineTool` helper lives in `@deepseek-ai/dsh-tools`, which does not
 * resolve from a `link:`-installed plugin (same reason `dsh-plugin-photoshop`
 * vendors its own equivalent).
 */
import { PROMPT } from './prompt.js'
import { play } from './tts.js'
import { announce, noteSpeechEnded } from './pet-bridge.js'

export const name = 'tool-voice-speak'
export const inject = ['tools', 'systemPrompt']

/**
 * Turn-end fallback phrase. Short on purpose: it only fires on a completed turn
 * that did real tool work yet stayed silent, so it must never feel like a summary.
 */
const FALLBACK_TEXT = '老大，这轮跑完了。'
/** `DSH_VOICE_SPEAK_FALLBACK=off` disables the fallback without touching `say`. */
const FALLBACK_ENABLED = process.env.DSH_VOICE_SPEAK_FALLBACK !== 'off'

/** When `say` last ran, when the current turn started, and whether it used any tool. */
let lastSayAt = 0
let turnStartedAt = 0
let turnHadToolCall = false

/** Model-facing contract: speak asynchronously, so never wait and never retry. */
const DESCRIPTION =
  '把一句话念给用户听（异步播放）。调用后立即返回，不要等待播放结束，也不要因为没立刻听到反馈就重复调用。' +
  '什么时候该用、该怎么说，见系统提示词里的「语音开口」一节。'

const PARAMETERS = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: '要对用户说的那一句话，口语，一句话。',
    },
  },
  required: ['text'],
  additionalProperties: false,
}

const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['queued'] },
      text: { type: 'string' },
    },
    required: ['status', 'text'],
    additionalProperties: false,
  },
  render: () => [{ type: 'text', text: '已交给语音播报' }],
}

/**
 * Mount the tool and the prompt section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx.logger('voice-speak').warn(message)
    } catch {
      // Logging must never break a tool call.
    }
  }

  // One sentence out: speech starts at once, the bubble shows the same text and
  // closes when the measured playback ends (tts.js reports `play_ms`).
  const speak = (text) => {
    const token = announce(text)
    play(text, warn, () => noteSpeechEnded(token))
  }

  ctx.tools.register({
    name: 'say',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : ''
      lastSayAt = Date.now()
      speak(text)
      return { status: 'queued', text }
    },
  })

  ctx.systemPrompt.section({
    name: 'voice-speak',
    order: 9000,
    text: PROMPT,
  })

  // Turn-end fallback: a work turn that never called `say` still gets one short
  // line, so "the round finished" is guaranteed by the plugin rather than by the
  // model remembering. It is a fallback, not the main path: any `say` wins, and
  // pure question-and-answer turns stay silent.
  if (typeof ctx.on !== 'function') return
  ctx.on('session/event', (session, event) => {
    if (!FALLBACK_ENABLED) return
    const type = event?.type
    if (type === 'turn/start') {
      turnStartedAt = Date.now()
      turnHadToolCall = false
      return
    }
    if (type === 'tool/call') {
      turnHadToolCall = true
      return
    }
    if (type !== 'turn/end') return
    // Subagent turns end constantly and are not the user's round.
    const header = session?.header
    if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return
    // Only a completed turn means "the round finished"; aborted/errored turns do not.
    const reason = event?.data?.reason?.kind
    if (reason !== undefined && reason !== 'completed') return
    // Option 1: only turns that did real tool work earn the fallback line.
    if (!turnHadToolCall) return
    // A known turn start plus a later `say` means the turn already spoke. An
    // unknown start (plugin reloaded mid-turn) must not count as "spoke".
    if (turnStartedAt > 0 && lastSayAt >= turnStartedAt) return
    speak(FALLBACK_TEXT)
  })
}
