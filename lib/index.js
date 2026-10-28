/**
 * dsh-voice-speak — plugin entry.
 *
 * Three contributions, nothing else:
 *   1. the `say` tool (`ctx.tools.register`), whose handler hands the sentence
 *      to the playback layer and returns at once;
 *   2. the `voice-speak` prompt section (`ctx.systemPrompt.section`), whose text
 *      lives in `prompt.js`;
 *   3. V3 automatic triggers (`triggers.js`) fed by durable session/job events:
 *      pending approvals, pending questions, long background jobs and long
 *      completed turns speak even when the model forgets.
 *
 * The tool definition is a registry-ready `ToolDefinition` written by hand: the
 * official `defineTool` helper lives in `@deepseek-ai/dsh-tools`, which does not
 * resolve from a `link:`-installed plugin (same reason `dsh-plugin-photoshop`
 * vendors its own equivalent).
 */
import { PROMPT } from './prompt.js'
import { play } from './tts.js'
import { announce, noteSpeechEnded } from './pet-bridge.js'
import { createSpeechTriggers } from './triggers.js'

export const name = 'tool-voice-speak'
export const inject = ['tools', 'systemPrompt']

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
 * Whether this event came from a delegated agent rather than the user's turn.
 * @param {{ header?: { origin?: unknown, delegationDepth?: unknown } }} [session] - event session.
 * @returns {boolean} true for subagent/workflow sessions.
 */
function isSubagent(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/**
 * Mount the tool, the prompt section and the automatic triggers.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ speak?: (text: string) => void }} [options] - test seam; DSH passes none.
 * @returns {void}
 */
export function apply(ctx, options = {}) {
  const warn = (message) => {
    try {
      ctx.logger('voice-speak').warn(message)
    } catch {
      // Logging must never break a tool call.
    }
  }

  // One sentence out: speech starts at once, the bubble shows the same text and
  // closes when the measured playback ends (tts.js reports `play_ms`).
  const speak = typeof options.speak === 'function'
    ? options.speak
    : (text) => {
        const token = announce(text)
        play(text, warn, () => noteSpeechEnded(token))
      }

  const triggers = createSpeechTriggers({ speak })

  ctx.tools.register({
    name: 'say',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : ''
      if (text.trim() !== '') {
        triggers.noteSpoken()
        speak(text)
      }
      return { status: 'queued', text }
    },
  })

  ctx.systemPrompt.section({
    name: 'voice-speak',
    order: 9000,
    text: PROMPT,
  })

  if (typeof ctx.on !== 'function') return

  // Sessions driven by an official schedule are automation, not the user's
  // desk round: their completion/approval belongs in email or WeChat, and a
  // spoken line at 03:00 would be noise. Marked per turn, cleared at its end.
  const automationTurns = new Set()

  // Automatic triggers. Every branch is event-driven and idempotent, so a
  // forgotten `say` cannot leave the user without a signal.
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (
      type !== 'turn/start'
      && type !== 'user/message'
      && type !== 'tool/call'
      && type !== 'approval/asked'
      && type !== 'turn/end'
    ) return
    if (isSubagent(session)) return
    const sessionId = session?.id
    const key = String(sessionId ?? '')
    if (type === 'user/message') {
      const source = event?.data?.source
      if (source?.kind === 'schedule') automationTurns.add(key)
      else automationTurns.delete(key)
      return
    }
    if (type === 'turn/start') {
      triggers.onTurnStart(sessionId)
      return
    }
    if (automationTurns.has(key)) {
      if (type === 'turn/end') automationTurns.delete(key)
      return
    }
    if (type === 'tool/call') {
      triggers.onToolCall(sessionId)
      if (event?.data?.name === 'ask_user_question') triggers.onAsk(sessionId, event.data)
      return
    }
    if (type === 'approval/asked') {
      triggers.onApproval(sessionId, event?.data)
      return
    }
    triggers.onTurnEnd(sessionId, event?.data?.reason)
  })

  // Long background jobs that settle without a waiter. Foreground calls are
  // `awaited`, so their result reaches the model directly and does not need a
  // spoken announcement on top.
  const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
  if (jobs !== undefined && typeof jobs?.events?.subscribe === 'function') {
    try {
      const dispose = jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event?.type !== 'settled' || event.awaited === true) return
        const job = event.job
        if (job === undefined || job === null) return
        triggers.onJobSettled({
          jobId: job.id,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          status: job.status,
          cause: event.cause,
        })
      })
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
    } catch (error) {
      warn(`jobs.events.subscribe 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
