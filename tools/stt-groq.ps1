<#
.SYNOPSIS
  音频文件 → 文字。用 Groq 的 whisper-large-v3-turbo（OpenAI 兼容接口）。
  这是 dsh-voice 那个插件的 voice_stt 的独立替代：不占每轮上下文，需要时才跑。

.DESCRIPTION
  密钥来源（按序）：
    1. -Key 参数
    2. 环境变量 DSH_VOICE_ASR_KEY
    3. ~\.dsh\profiles\web\cordis.patch.yml 里 `- id: voice` 段的 asrApiKey

  代理来源（按序）：
    1. -Proxy 参数（如 http://127.0.0.1:7892）
    2. 系统代理（Internet Settings 的 ProxyServer）
    3. 不走代理

  接口限制：音频 ≤ 25 MB。超了先压缩：
    ffmpeg -i in.wav -codec:a libmp3lame -b:a 32k -ar 16000 out.mp3

.PARAMETER Audio
  音频文件。mp3 / wav / m4a / ogg / flac 都行。

.PARAMETER Language
  语言提示，默认 zh。留空则自动判断。

.PARAMETER Model
  默认 whisper-large-v3-turbo。

.PARAMETER Out
  可选，把转写文本写成 .txt。

.EXAMPLE
  .\stt-groq.ps1 -Audio "D:\Test\tools\_tmp\tts-local-demo.mp3"

.EXAMPLE
  .\stt-groq.ps1 -Audio rec.m4a -Language en -Out rec.txt
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Audio,
  [string]$Language = 'zh',
  [string]$Model = 'whisper-large-v3-turbo',
  [string]$Key = '',
  [string]$Proxy = '',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $Audio)) { throw "音频不存在：$Audio" }
$sizeMB = (Get-Item -LiteralPath $Audio).Length / 1MB
if ($sizeMB -gt 25) { throw ("音频 {0:N1} MB 超过 25 MB 上限，先 ffmpeg 压到 32k/16k 单声道" -f $sizeMB) }

# ---- 密钥 ----
if (-not $Key) { $Key = $env:DSH_VOICE_ASR_KEY }
if (-not $Key) { $Key = $env:GROQ_API_KEY }
if (-not $Key) {
  $cfgJson = Join-Path $env:USERPROFILE '.dsh\voice-speak.json'
  if (Test-Path -LiteralPath $cfgJson) {
    try { $Key = (Get-Content -LiteralPath $cfgJson -Raw | ConvertFrom-Json).groqApiKey } catch { }
  }
}
if (-not $Key) {
  $cfg = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
  if (Test-Path -LiteralPath $cfg) {
    $line = Select-String -Path $cfg -Pattern '^\s+asrApiKey:\s*(\S+)' | Select-Object -First 1
    if ($line) { $Key = $line.Matches[0].Groups[1].Value.Trim("'", '"') }
  }
}
if (-not $Key) { throw '拿不到 ASR 密钥：给 -Key，或设 DSH_VOICE_ASR_KEY，或在 cordis.patch.yml 的 voice 段配 asrApiKey。' }

# ---- 代理 ----
if (-not $Proxy) {
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
    $srv = ($ie.ProxyServer -split ';' | Where-Object { $_ -match 'https|http|=|:' } | Select-Object -First 1)
    if ($srv -match '=') { $srv = ($srv -split '=')[1] }
    if ($srv -notmatch '^https?://') { $srv = 'http://' + $srv }
    $Proxy = $srv
  }
}

$endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions'
$curlArgs = @('-s', '-S', '--max-time', '180',
  '-H', "Authorization: Bearer $Key",
  '-F', "file=@$Audio",
  '-F', "model=$Model",
  '-F', 'response_format=json')
if ($Language) { $curlArgs += @('-F', "language=$Language") }
if ($Proxy) { $curlArgs = @('-x', $Proxy) + $curlArgs }
$curlArgs += $endpoint

$sw = [Diagnostics.Stopwatch]::StartNew()
$raw = & curl.exe @curlArgs 2>&1 | Out-String
$sw.Stop()

if ($LASTEXITCODE -ne 0) { throw "curl 失败 exit=$LASTEXITCODE`n$raw" }

try { $json = $raw | ConvertFrom-Json } catch { throw "返回不是 JSON`n$raw" }
if ($json.error) { throw ("接口报错：" + $json.error.message) }
if (-not $json.text) { throw "没有拿到 text 字段`n$raw" }

Write-Host ("转写完成 · {0} · {1:N1}s · 代理 {2}" -f $Model, $sw.Elapsed.TotalSeconds, $(if ($Proxy) { $Proxy } else { '无' }))
Write-Output $json.text

if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Out, $json.text, (New-Object Text.UTF8Encoding $false))
  Write-Host "写出：$Out"
}
