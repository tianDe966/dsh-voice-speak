import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechTriggers } from '../lib/triggers.js'

/** A controller with a controllable clock and a speech spy. */
function mount({ silenced = false } = {}) {
  let clock = 1_000_000
  const spoken = []
  const triggers = createSpeechTriggers({
    speak: (text) => spoken.push(text),
    now: () => clock,
    isSilenced: () => silenced,
  })
  return {
    triggers,
    spoken,
    advance(ms) {
      clock += ms
    },
  }
}

test('short completed turn says nothing', () => {
  const { triggers, spoken, advance } = mount()
  triggers.onTurnStart('s1')
  triggers.onToolCall('s1')
  triggers.onToolCall('s1')
  triggers.onToolCall('s1')
  advance(30_000)
  triggers.onTurnEnd('s1', { kind: 'completed' })
  assert.deepEqual(spoken, [])
})

test('long completed turn says one done line', () => {
  const { triggers, spoken, advance } = mount()
  triggers.onTurnStart('s1')
  triggers.onToolCall('s1')
  triggers.onToolCall('s1')
  advance(130_000)
  triggers.onTurnEnd('s1', { kind: 'completed' })
  assert.deepEqual(spoken, ['老大，这轮跑完了。'])
})

test('long turn with too little tool work stays silent', () => {
  const { triggers, spoken, advance } = mount()
  triggers.onTurnStart('s1')
  triggers.onToolCall('s1')
  advance(130_000)
  triggers.onTurnEnd('s1', { kind: 'completed' })
  assert.deepEqual(spoken, [])
})

test('recent speech suppresses the completion line', () => {
  const { triggers, spoken, advance } = mount()
  triggers.onTurnStart('s1')
  triggers.onToolCall('s1')
  triggers.onToolCall('s1')
  advance(100_000)
  triggers.noteSpoken()
  advance(30_000)
  triggers.onTurnEnd('s1', { kind: 'completed' })
  assert.deepEqual(spoken, [])
})

test('error and blocked turns are announced', () => {
  const error = mount()
  error.triggers.onTurnStart('s1')
  error.advance(5_000)
  error.triggers.onTurnEnd('s1', { kind: 'error' })
  assert.deepEqual(error.spoken, ['老大，这轮出错了。'])

  const blocked = mount()
  blocked.triggers.onTurnStart('s1')
  blocked.advance(5_000)
  blocked.triggers.onTurnEnd('s1', { kind: 'blocked' })
  assert.deepEqual(blocked.spoken, ['老大，这轮卡住了。'])
})

test('aborted turns stay silent', () => {
  const { triggers, spoken, advance } = mount()
  triggers.onTurnStart('s1')
  triggers.onToolCall('s1')
  triggers.onToolCall('s1')
  advance(130_000)
  triggers.onTurnEnd('s1', { kind: 'aborted' })
  assert.deepEqual(spoken, [])
})

test('approval is announced once per request', () => {
  const { triggers, spoken } = mount()
  triggers.onApproval('s1', { id: 'a1', toolName: 'bash', callId: 'c1' })
  triggers.onApproval('s1', { id: 'a1', toolName: 'bash', callId: 'c1' })
  assert.deepEqual(spoken, ['老大，有个操作要你批一下。'])
})

test('approval is skipped when the model just spoke', () => {
  const { triggers, spoken, advance } = mount()
  triggers.noteSpoken()
  advance(3_000)
  triggers.onApproval('s1', { id: 'a1' })
  assert.deepEqual(spoken, [])
})

test('question is announced once per call', () => {
  const { triggers, spoken } = mount()
  triggers.onAsk('s1', { callId: 'c9' })
  triggers.onAsk('s1', { callId: 'c9' })
  assert.deepEqual(spoken, ['老大，有个问题要你定。'])
})

test('long background job completion is announced', () => {
  const { triggers, spoken } = mount()
  triggers.onJobSettled({
    jobId: 'j1', startedAt: 1_000_000, finishedAt: 1_100_000, status: 'completed', cause: 'producer',
  })
  assert.deepEqual(spoken, ['老大，后台任务跑完了。'])
})

test('short background job stays silent', () => {
  const { triggers, spoken } = mount()
  triggers.onJobSettled({
    jobId: 'j2', startedAt: 1_000_000, finishedAt: 1_060_000, status: 'completed', cause: 'producer',
  })
  assert.deepEqual(spoken, [])
})

test('failed long background job is announced', () => {
  const { triggers, spoken } = mount()
  triggers.onJobSettled({
    jobId: 'j3', startedAt: 1_000_000, finishedAt: 1_100_000, status: 'failed', cause: 'producer',
  })
  assert.deepEqual(spoken, ['老大，后台任务失败了。'])
})

test('job completion respects the automatic-speech gap', () => {
  const { triggers, spoken, advance } = mount()
  triggers.noteSpoken()
  advance(10_000)
  triggers.onJobSettled({
    jobId: 'j4', startedAt: 1_000_000, finishedAt: 1_100_000, status: 'completed', cause: 'producer',
  })
  assert.deepEqual(spoken, [])
})

test('teardown settlements are ignored', () => {
  const { triggers, spoken } = mount()
  triggers.onJobSettled({
    jobId: 'j5', startedAt: 1_000_000, finishedAt: 1_100_000, status: 'killed', cause: 'teardown',
  })
  assert.deepEqual(spoken, [])
})

test('remote mode silences every automatic line', () => {
  const { triggers, spoken, advance } = mount({ silenced: true })
  triggers.onTurnStart('s1')
  triggers.onToolCall('s1')
  triggers.onToolCall('s1')
  advance(130_000)
  triggers.onTurnEnd('s1', { kind: 'completed' })
  triggers.onTurnEnd('s1', { kind: 'error' })
  triggers.onApproval('s1', { id: 'a1' })
  triggers.onAsk('s1', { callId: 'c1' })
  triggers.onJobSettled({
    jobId: 'j6', startedAt: 1_000_000, finishedAt: 1_100_000, status: 'completed', cause: 'producer',
  })
  triggers.noteSpoken()
  assert.deepEqual(spoken, [])
})
