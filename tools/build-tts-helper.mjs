/**
 * Build dsh-tts-helper.
 *
 * No MSVC and no .NET SDK on this machine, so the C# is compiled with the
 * .NET Framework 4.8 csc.exe against the managed Speech SDK assembly that lives
 * in the standalone SDK folder (not in this repository — it is Microsoft's
 * redistributable binary, and the voice models are not ours to ship either).
 *
 * Usage: node tools/build-tts-helper.mjs [--sdk <dir>]
 * Default SDK dir: D:\DSH_Project\TTS\SpeechSDK\win-x64
 *
 * Output: bin/dsh-tts-helper.exe (our code only, ~10 KB).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const sdkFlag = process.argv.indexOf('--sdk')
const sdkDir = sdkFlag > -1 ? process.argv[sdkFlag + 1] : 'D:\\DSH_Project\\TTS\\SpeechSDK\\win-x64'
const managed = join(sdkDir, 'Microsoft.CognitiveServices.Speech.csharp.dll')
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

if (!existsSync(csc)) {
  console.error(`build: csc.exe not found at ${csc}`)
  process.exit(2)
}
if (!existsSync(managed)) {
  console.error(`build: managed Speech SDK assembly not found at ${managed}\n` +
    '       run the SDK staging step first (see 经验库/dsh-voice-speak.md, 2026-10-30).')
  process.exit(2)
}

const outDir = join(root, 'bin')
mkdirSync(outDir, { recursive: true })
const exe = join(outDir, 'dsh-tts-helper.exe')

const sources = [join(here, 'tts-helper', 'Program.cs'), join(here, 'tts-helper', 'Runner.cs')]
const args = [
  '/nologo',
  '/platform:x64',
  '/target:exe',
  '/optimize+',
  `/out:${exe}`,
  `/r:${managed}`,
  ...sources,
]

const result = spawnSync(csc, args, { encoding: 'utf8' })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) {
  console.error(`build: csc exited ${result.status}`)
  process.exit(1)
}
console.log(`built ${exe} (${statSync(exe).size} bytes) against ${managed}`)
