import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalSpeaker } from '../lib/worker.js'

/** A speaker whose transport is replaced, so no process is ever spawned. */
function speaker() {
  const instance = new LocalSpeaker({
    voiceMatch: 'Xiaoxiao',
    pitch: '+10%',
    rate: '-4%',
    tailPadMs: 400,
    idleMs: 1000,
  })
  instance.armIdle = () => {}
  instance.clearIdle = () => {}
  return instance
}

/** Decode the base64 payload of the second token of a protocol line. */
function payload(line) {
  return Buffer.from(line.split(' ')[1], 'base64').toString('utf8')
}

test('each engine sends its own protocol line', async () => {
  const lines = []
  for (const call of ['speak', 'sayDefault', 'playFile', 'playMci']) {
    const instance = speaker()
    instance.exchange = async (line) => {
      lines.push(line)
      return 'ok 12'
    }
    if (call === 'speak') await instance.speak('老大')
    if (call === 'sayDefault') await instance.sayDefault('老大')
    if (call === 'playFile') await instance.playFile('C:/tmp/a.wav')
    if (call === 'playMci') await instance.playMci('C:/tmp/a.mp3')
  }
  assert.deepEqual(lines.map((line) => line.split(' ')[0]), ['speak', 'saydefault', 'play', 'mciplay'])
  assert.equal(payload(lines[0]), '老大')
  const wav = Buffer.from(lines[0].split(' ')[2], 'base64').toString('utf8')
  assert.match(wav, /\.wav$/)
  assert.equal(payload(lines[3]), 'C:/tmp/a.mp3')
})

test('ok replies become a measured duration', async () => {
  const instance = speaker()
  instance.exchange = async () => 'ok 3344'
  const result = await instance.speak('老大')
  assert.equal(result.status, 'ok')
  assert.equal(result.audioMs, 3344)
})

test('unavailable replies are reported, and only pin the state when no voice exists', async () => {
  const instance = speaker()
  instance.voiceKind = 'local'
  instance.exchange = async () => 'unavailable'
  assert.equal((await instance.speak('老大')).status, 'unavailable')
  assert.equal(instance.state, 'new')

  const voiceless = speaker()
  voiceless.voiceKind = 'none'
  voiceless.exchange = async () => 'unavailable'
  await voiceless.speak('老大')
  assert.equal(voiceless.state, 'unavailable')
})

test('error replies carry the worker message, without the err prefix', async () => {
  const instance = speaker()
  instance.exchange = async () => 'err mci-open-263'
  const result = await instance.playMci('C:/tmp/a.mp3')
  assert.equal(result.status, 'error')
  assert.equal(result.message, 'mci-open-263')
})

test('a ready line records which voice the worker picked', () => {
  const instance = speaker()
  instance.onLine('ready default')
  assert.equal(instance.voiceKind, 'default')
  assert.equal(instance.state, 'ready')
})
