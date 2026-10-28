import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../lib/index.js'

/** Load the plugin against a fake cordis context and capture speech. */
function mount({ isSilenced = () => false } = {}) {
  const spoken = []
  const handlers = new Map()
  let tool
  let section
  let jobListener
  const ctx = {
    tools: {
      register(definition) {
        tool = definition
      },
    },
    systemPrompt: {
      section(definition) {
        section = definition
        return () => {}
      },
    },
    on(event, listener) {
      handlers.set(event, listener)
      return () => {}
    },
    get(service) {
      if (service !== 'jobs') return undefined
      return {
        events: {
          subscribe(_filter, listener) {
            jobListener = listener
            return () => {}
          },
        },
      }
    },
    effect(callback) {
      callback()
      return () => {}
    },
    logger() {
      return { warn() {} }
    },
  }
  apply(ctx, { speak: (text) => spoken.push(text), isSilenced })
  return {
    spoken,
    tool,
    section,
    emit(event) {
      handlers.get('session/event')({ id: 's1', header: {} }, event)
    },
    emitFrom(session, event) {
      handlers.get('session/event')(session, event)
    },
    settleJob(event) {
      jobListener(event)
    },
  }
}

test('plugin registers the say tool and the prompt section', () => {
  const m = mount()
  assert.equal(name, 'tool-voice-speak')
  assert.equal(m.tool.name, 'say')
  assert.equal(m.section.name, 'voice-speak')
  assert.match(m.section.text, /语音开口/)
})

test('say hands the sentence to the speaker', async () => {
  const m = mount()
  const result = await m.tool.execute({ text: '老大，测试。' })
  assert.deepEqual(result, { status: 'queued', text: '老大，测试。' })
  assert.deepEqual(m.spoken, ['老大，测试。'])
})

test('pending approval speaks automatically', () => {
  const m = mount()
  m.emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c1' } })
  assert.deepEqual(m.spoken, ['老大，有个操作要你批一下。'])
})

test('ask_user_question speaks automatically', () => {
  const m = mount()
  m.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'c9' } })
  assert.deepEqual(m.spoken, ['老大，有个问题要你定。'])
})

test('error turn speaks automatically', () => {
  const m = mount()
  m.emit({ type: 'turn/start', data: { turn: 1 } })
  m.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.deepEqual(m.spoken, ['老大，这轮出错了。'])
})

test('subagent events never speak', () => {
  const m = mount()
  const session = { id: 'sub', header: { origin: 'subagent' } }
  m.emitFrom(session, { type: 'approval/asked', data: { id: 'a2' } })
  m.emitFrom(session, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } })
  m.emitFrom(session, { type: 'turn/start', data: { turn: 1 } })
  m.emitFrom(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.deepEqual(m.spoken, [])
})

test('scheduled (automation) turns never speak', () => {
  const m = mount()
  // The schedule injects the user message before the turn opens; both orders
  // must suppress the whole turn.
  m.emit({ type: 'user/message', data: { source: { kind: 'schedule' } } })
  m.emit({ type: 'turn/start', data: { turn: 1 } })
  m.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } })
  m.emit({ type: 'approval/asked', data: { id: 'a1' } })
  m.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.deepEqual(m.spoken, [])
})

test('a normal message clears the automation marker', () => {
  const m = mount()
  m.emit({ type: 'user/message', data: { source: { kind: 'schedule' } } })
  m.emit({ type: 'user/message', data: { source: { kind: 'user' } } })
  m.emit({ type: 'approval/asked', data: { id: 'a3' } })
  assert.deepEqual(m.spoken, ['老大，有个操作要你批一下。'])
})

test('remote mode silences say and automatic alerts', async () => {
  const m = mount({ isSilenced: () => true })
  await m.tool.execute({ text: '老大，测试。' })
  m.emit({ type: 'approval/asked', data: { id: 'a1' } })
  m.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } })
  m.emit({ type: 'turn/start', data: { turn: 1 } })
  m.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.deepEqual(m.spoken, [])
})

test('long unawaited job settlement speaks', () => {
  const m = mount()
  const finishedAt = Date.now()
  m.settleJob({
    type: 'settled',
    awaited: false,
    cause: 'producer',
    job: {
      id: 'job-1',
      startedAt: finishedAt - 100_000,
      finishedAt,
      status: 'completed',
    },
  })
  assert.deepEqual(m.spoken, ['老大，后台任务跑完了。'])
})

test('awaited job settlement stays silent', () => {
  const m = mount()
  const finishedAt = Date.now()
  m.settleJob({
    type: 'settled',
    awaited: true,
    cause: 'producer',
    job: {
      id: 'job-2',
      startedAt: finishedAt - 100_000,
      finishedAt,
      status: 'completed',
    },
  })
  assert.deepEqual(m.spoken, [])
})
