import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'

/**
 * Load the plugin against a fake cordis context and capture speech.
 *
 * The marker path defaults to a fresh temp file so no test can ever touch the
 * real `~/.dsh/rules/remote-mode.on`.
 */
function mount({ isSilenced, markerPath, wechatWorkspace } = {}) {
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
  const marker = markerPath ?? join(mkdtempSync(join(tmpdir(), 'voice-speak-')), 'remote-mode.on')
  const options = { speak: (text) => spoken.push(text), markerPath: marker }
  if (isSilenced !== undefined) options.isSilenced = isSilenced
  if (wechatWorkspace !== undefined) options.wechatWorkspace = wechatWorkspace
  apply(ctx, options)
  return {
    spoken,
    tool,
    section,
    markerPath: marker,
    /** Enter remote mode the way `set_remote_mode` does. */
    arm() {
      writeFileSync(marker, 'enabled\n', 'utf8')
    },
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

/** A desktop session, i.e. this GUI. */
const DESKTOP = { id: 's1', header: { cwd: 'D:/DSH_Project/plugin01' } }
/** A session the WeChat channel created, i.e. a phone turn. */
const WECHAT = { id: 'w1', header: { cwd: 'C:/Users/someone/.dsh/dsh_wechat' } }
const userMessage = { type: 'user/message', data: { source: { kind: 'user' } } }
const scheduledMessage = { type: 'user/message', data: { source: { kind: 'schedule' } } }

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
  const m = mount()
  m.arm()
  const result = await m.tool.execute({ text: '老大，测试。' })
  m.emit({ type: 'approval/asked', data: { id: 'a1' } })
  m.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } })
  m.emit({ type: 'turn/start', data: { turn: 1 } })
  m.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.deepEqual(m.spoken, [])
  assert.deepEqual(result, { status: 'muted', text: '老大，测试。' })
  assert.deepEqual(m.tool.output.render({}, result), [
    { type: 'text', text: '已静默（远程模式），没有出声' },
  ])
})

test('a desktop message releases a stale remote-mode marker', async () => {
  const m = mount()
  m.arm()
  m.emitFrom(DESKTOP, userMessage)
  assert.equal(existsSync(m.markerPath), false)
  // Voice is back for the same turn, without anyone remembering to switch.
  const result = await m.tool.execute({ text: '老大，回来了。' })
  assert.deepEqual(result, { status: 'queued', text: '老大，回来了。' })
  assert.deepEqual(m.spoken, ['老大，回来了。'])
})

test('a WeChat message keeps the remote-mode marker', () => {
  const m = mount()
  m.arm()
  m.emitFrom(WECHAT, userMessage)
  assert.equal(existsSync(m.markerPath), true)
})

test('a scheduled message keeps the remote-mode marker', () => {
  const m = mount()
  m.arm()
  m.emitFrom(DESKTOP, scheduledMessage)
  assert.equal(existsSync(m.markerPath), true)
})

test('a custom WeChat workspace still keeps the marker', () => {
  const m = mount({ wechatWorkspace: 'D:/wechat-sessions' })
  m.arm()
  m.emitFrom({ id: 'w2', header: { cwd: 'D:/wechat-sessions' } }, userMessage)
  assert.equal(existsSync(m.markerPath), true)
  m.emitFrom(DESKTOP, userMessage)
  assert.equal(existsSync(m.markerPath), false)
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
