/**
 * dsh-voice-speak — Edge TTS client, no dependencies.
 *
 * Why this file exists: `System.Speech` only offers the SAPI5 voices installed
 * on the machine (here: Huihui), while the natural Chinese voices live behind
 * Microsoft's Edge read-aloud service. Talking to it needs three things that a
 * bare WebSocket client cannot express — the `Origin`/`User-Agent` handshake
 * headers, the `Sec-MS-GEC v2` token, and unmasked server frames — so this module
 * speaks the protocol directly over `node:tls` instead of pulling in a package.
 *
 * The token algorithm is a port of `msedge-tts` 2.1.1 (`SecMsGec.js`), which
 * follows the analysis in rany2/edge-tts PR #492: the v2 token is
 * `<CS64 checksum>-<SHA-256>` over Edge's copyright line plus the Windows tick
 * count and the trusted client token. If Microsoft changes it again, this file is
 * the only place to update; a synthesis failure falls back to SAPI upstream.
 *
 * Measured on this machine (2026-10-27): a 25 KB MP3 for a 20-character sentence
 * arrives in ~1.2 s. A handshake without the Edge headers is rejected with 403.
 */
import { connect } from 'node:tls'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const GEC_VERSION = '2-143.0.3650.96'
const HOST = 'speech.platform.bing.com'
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

const COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.'
const SWAP_FIRST = { swappedWord: 0xef0569fb, swappedSum: 0x76f50f34, swappedProduct: 0xc3efea97 }
const SWAP_SECOND = { swappedWord: 0xc31713db, swappedSum: 0x1881ce3c, swappedProduct: 0x35bd1ec9 }
const MIX_FIRST = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]
const MIX_SECOND = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]

/** Cached server clock offset, in milliseconds. */
let clockOffsetMs = 0
let clockOffsetKnown = false

const swapHalves = (value) => ((value << 16) | (value >>> 16)) >>> 0

/**
 * One swap/multiply term of the CS64 checksum.
 * @param {number} word - one 32-bit message word.
 * @param {number} key - one 32-bit key derived from the digest.
 * @param {{ swappedWord: number, swappedSum: number, swappedProduct: number }} multipliers - constants.
 * @returns {number} the term.
 */
function swapTerm(word, key, multipliers) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.swappedWord)
  const product = Math.imul(swapHalves(sum), multipliers.swappedSum) >>> 0
  return (Math.imul(swapHalves(product), multipliers.swappedProduct) + product) >>> 0
}

/**
 * Apply a fixed multiplier chain to a value.
 * @param {number} value - the value.
 * @param {number[]} multipliers - the chain.
 * @returns {number} the mixed value.
 */
const mixWords = (value, multipliers) =>
  multipliers.reduce((acc, multiplier) => Math.imul(swapHalves(acc), multiplier) >>> 0, value)

/**
 * Compute the 8-byte CS64 checksum over the message with the digest as key.
 * @param {Uint8Array} message - the hashed message.
 * @param {Uint8Array} digest - its SHA-256 digest.
 * @returns {Uint8Array} the checksum.
 */
function cs64(message, digest) {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const firstKey = (view.getUint32(0, true) | 1) >>> 0
  const secondKey = (view.getUint32(4, true) | 1) >>> 0
  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8)
  padded.set(message)
  const words = new DataView(padded.buffer)
  let swapSum = 0
  let lastSwap = 0
  let mix = 0
  let mixSum = 0
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = words.getUint32(offset, true)
    const secondWord = words.getUint32(offset + 4, true)
    const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST)
    lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND)
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0
    mix = mixWords(Math.imul(mix + firstWord, firstKey), MIX_FIRST)
    mixSum = (mixSum + mix) >>> 0
    mix = mixWords(Math.imul(mix + secondWord, secondKey), MIX_SECOND)
    mixSum = (mixSum + mix) >>> 0
  }
  const checksum = new Uint8Array(8)
  const checksumView = new DataView(checksum.buffer)
  checksumView.setUint32(0, lastSwap ^ mix, true)
  checksumView.setUint32(4, swapSum ^ mixSum, true)
  return checksum
}

/**
 * Render bytes as upper-case hex.
 * @param {Uint8Array} bytes - the bytes.
 * @returns {string} the hex string.
 */
const toUpperHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()

/**
 * Build the `Sec-MS-GEC` v2 token for the current five-minute window.
 * @returns {string} the token.
 */
function secMsGec() {
  const ticks = Math.floor((Date.now() + clockOffsetMs) / 1000) + 11644473600
  const rounded = ticks - (ticks % 300)
  const message = new TextEncoder().encode(COPYRIGHT + `${rounded * 10000000}${TRUSTED_CLIENT_TOKEN}`)
  const digest = new Uint8Array(createHash('sha256').update(message).digest())
  return `${toUpperHex(cs64(message, digest))}-${toUpperHex(digest)}`
}

/**
 * Learn the clock skew from the server's `Date` header, once per process.
 * The token is windowed to five minutes, so a few seconds of skew matter.
 * @returns {Promise<void>} resolved once the offset is known or the probe failed.
 */
async function learnClockOffset() {
  if (clockOffsetKnown) return
  clockOffsetKnown = true
  try {
    const response = await fetch('https://speech.platform.bing.com/', { method: 'HEAD' })
    const date = Date.parse(response.headers.get('date') ?? '')
    if (Number.isFinite(date)) clockOffsetMs = date - Date.now()
  } catch {
    clockOffsetMs = 0
  }
}

/**
 * One masked client frame.
 * @param {number} opcode - WebSocket opcode.
 * @param {Buffer} payload - frame body.
 * @returns {Buffer} the frame with its header and mask.
 */
function encodeFrame(opcode, payload) {
  const length = payload.length
  const header = [0x80 | opcode]
  if (length < 126) header.push(0x80 | length)
  else if (length < 65536) header.push(0x80 | 126, (length >> 8) & 0xff, length & 0xff)
  else header.push(0x80 | 127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([Buffer.from(header), mask, masked])
}

/**
 * Synthesize one sentence to MP3 bytes.
 * @param {string} text - the sentence.
 * @param {{ voice?: string, timeoutMs?: number }} [options] - voice name and deadline.
 * @returns {Promise<Buffer>} the MP3 bytes.
 */
export async function synthesize(text, options = {}) {
  const { voice = 'zh-CN-XiaoxiaoNeural', timeoutMs = 20000 } = options
  await learnClockOffset()

  const url = `${PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${randomUUID()}`
  const key = randomBytes(16).toString('base64')

  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port: 443, servername: HOST }, () => {
      socket.write(
        [
          `GET ${url} HTTP/1.1`,
          `Host: ${HOST}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Origin: ${ORIGIN}`,
          'Pragma: no-cache',
          'Cache-Control: no-cache',
          'Accept-Encoding: gzip, deflate, br',
          `User-Agent: ${USER_AGENT}`,
          '',
          '',
        ].join('\r\n'),
      )
    })

    let handshakeDone = false
    let buffered = Buffer.alloc(0)
    const chunks = []
    let settled = false
    let timer

    const finish = (error, audio) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(audio)
    }

    timer = setTimeout(() => finish(new Error('Edge TTS 超时')), timeoutMs)
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('连接提前关闭')))

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])

      if (!handshakeDone) {
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buffered.subarray(0, end).toString('latin1')
        buffered = buffered.subarray(end + 4)
        if (!head.startsWith('HTTP/1.1 101')) {
          finish(new Error(`握手失败: ${head.split('\r\n')[0]}`))
          return
        }
        handshakeDone = true
        const config = JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        })
        socket.write(
          encodeFrame(0x1, Buffer.from(
            `X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`,
          )),
        )
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
        socket.write(
          encodeFrame(0x1, Buffer.from(
            `X-RequestId:${randomUUID()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
          )),
        )
      }

      for (;;) {
        if (buffered.length < 2) return
        const opcode = buffered[0] & 0x0f
        const masked = (buffered[1] & 0x80) !== 0
        let length = buffered[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffered.length < 4) return
          length = buffered.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffered.length < 10) return
          length = Number(buffered.readBigUInt64BE(2))
          offset = 10
        }
        const maskLength = masked ? 4 : 0
        if (buffered.length < offset + maskLength + length) return
        let payload = buffered.subarray(offset + maskLength, offset + maskLength + length)
        if (masked) {
          const mask = buffered.subarray(offset, offset + 4)
          payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]))
        }
        buffered = buffered.subarray(offset + maskLength + length)

        if (opcode === 0x8) {
          finish(new Error('服务端关闭连接'))
          return
        }
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload))
          continue
        }
        if (opcode === 0x2) {
          const headerLength = payload.readUInt16BE(0)
          const header = payload.subarray(2, 2 + headerLength).toString('utf8')
          if (header.includes('Path:audio')) chunks.push(payload.subarray(2 + headerLength))
          continue
        }
        if (opcode === 0x1 && payload.toString('utf8').includes('turn.end')) {
          finish(null, Buffer.concat(chunks))
          return
        }
      }
    })
  })
}

/**
 * Escape the three XML-significant characters in the spoken text.
 * @param {string} text - the sentence.
 * @returns {string} the escaped text.
 */
function escapeXml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
