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

  ctx.tools.register({
    name: 'say',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : ''
      play(text, warn)
      return { status: 'queued', text }
    },
  })

  ctx.systemPrompt.section({
    name: 'voice-speak',
    order: 9000,
    text: PROMPT,
  })
}
