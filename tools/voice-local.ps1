<#
.SYNOPSIS
  用 dsh-voice-speak 的第一优先级本地语音（Microsoft Xiaoxiao Natural，离线）给一句台词配音，
  可选把配音按指定时间戳混进一条视频。开机动画 v7 的配音走这条链。

.DESCRIPTION
  引擎：bin\dsh-tts-helper.exe + Microsoft Embedded Speech SDK（离线，不联网）。
  这与 dsh-voice-speak 的 say 工具用的是同一条链、同一个音色与同一组参数，
  所以片头听到的声音和「小兰说话」完全一致。

  两个坑已在脚本里处理：
  1. SDK 拒绝打开含非 ASCII 字符的输出路径，会把 wav 偷偷落到自己的 tts-tmp 里
     （stdout 会打印 out=<真实路径>）。所以合成一律先落到 ASCII 临时目录，
     再复制到最终路径。
  2. 该引擎的 pitch 是百分比（+10%），不是 edge-tts 的 Hz（-1Hz）。混用参数会报错。

.PARAMETER Text
  要念的台词。v7 用的是「回来啦，我在呢。」（7 字，合成后约 1.74 s）。

.PARAMETER Out
  输出路径。给了 -Video 时是成片路径；只配音时是 wav 路径。省略则默认 <视频名>-voice.mp4。

.PARAMETER Video
  可选。给一条视频，把配音按 -DelayMs 混进去（视频流直接 copy，不重编码）。

.PARAMETER DelayMs
  配音在视频里的起点，毫秒。v7 定稿是 3800（3.8 s 开口，1.74 s 念完，正好落在 3.8–5.6 s 窗口）。

.PARAMETER Atempo
  配音整体变速（1.0 = 原速）。超窗口时用 1.05–1.12 微压，别超过 1.2（会听出机械感）。

.PARAMETER Pitch / Rate
  合成参数，默认与插件一致：+10% / -4%。

.EXAMPLE
  .\voice-local.ps1 -Text "回来啦，我在呢。" -Out "D:\DSH_Project\小兰形象\08-片库素材\voice-回来啦.wav"

.EXAMPLE
  .\voice-local.ps1 -Text "回来啦，我在呢。" `
      -Video "$env:USERPROFILE\.dsh\boot-animation\videos\xiaolan-boot-v7-b.mp4" `
      -DelayMs 3800
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$Out,
  [string]$Video,
  [int]$DelayMs = 3800,
  [double]$Atempo = 1.0,
  [string]$Pitch = '+10%',
  [string]$Rate = '-4%'
)

$ErrorActionPreference = 'Stop'

# 插件自寻址：优先环境变量，其次脚本所在包的上一级，最后回退旧安装位置。
$plugin = if ($env:DSH_VOICE_SPEAK_HOME) { $env:DSH_VOICE_SPEAK_HOME }
  elseif (Test-Path (Join-Path $PSScriptRoot '..\bin\dsh-tts-helper.exe')) { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  else { Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-voice-speak' }
$helper   = Join-Path $plugin 'bin\dsh-tts-helper.exe'
$sdk      = if ($env:DSH_VOICE_SPEAK_SDK) { $env:DSH_VOICE_SPEAK_SDK } else { 'D:\DSH_Project\TTS\SpeechSDK\win-x64' }
$voiceDir = if ($env:DSH_VOICE_SPEAK_VOICE_DIR) { $env:DSH_VOICE_SPEAK_VOICE_DIR } else { 'D:\DSH_Project\TTS\NaturalVoices\Xiaoxiao' }

foreach ($p in @($helper, $sdk, $voiceDir)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "缺件：$p" }
}

# 临时目录：SDK 对可写目录挑剔（Public 会报 FILE_OPEN_FAILED），用插件自己的 tts-tmp
$scratch = Join-Path $plugin 'bin\tts-tmp'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$tmp = Join-Path $scratch ("voice-" + [guid]::NewGuid().ToString('N') + ".wav")

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
# 长文本按字数放宽超时（基准 15 s，每字 80 ms）
$timeoutMs = [Math]::Max(15000, [int]($Text.Length * 80))
$stdout = & $helper --sdk $sdk --voice $voiceDir --out $tmp --text-b64 $b64 `
  --pitch $Pitch --rate $Rate --timeout-ms $timeoutMs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "合成失败 exit=$LASTEXITCODE $stdout" }

# helper 会在 stdout 打印 out=<真实落地路径>
$landed = $tmp
if ($stdout -match '(?:^|\s)out=(\S+)') { $landed = $Matches[1] }
if (-not (Test-Path -LiteralPath $landed)) { throw "合成没有产出 wav：$stdout" }

$dur = [double](& ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 $landed)
Write-Host ("配音已合成：{0:N2} s  {1}  （{2}）" -f $dur, (Split-Path $landed -Leaf), $stdout.Trim())

if (-not $Video) {
  if (-not $Out) { $Out = Join-Path $scratch 'voice-out.wav' }
  # 扩展名 .mp3 就真转码（2026-11-14 加：原来只是改个后缀，内容还是 wav）
  if ([IO.Path]::GetExtension($Out).ToLower() -eq '.mp3') {
    & ffmpeg -y -hide_banner -loglevel error -i $landed -codec:a libmp3lame -b:a 64k -ar 24000 $Out
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg 转 mp3 失败 exit=$LASTEXITCODE" }
  } else {
    Copy-Item -LiteralPath $landed -Destination $Out -Force
  }
  $outLen = (Get-Item -LiteralPath $Out).Length
  Write-Host ("写出：{0}  （{1:N0} B）" -f $Out, $outLen)
  Remove-Item -LiteralPath $landed -Force -ErrorAction SilentlyContinue
  return
}

if (-not (Test-Path -LiteralPath $Video)) { throw "视频不存在：$Video" }
if (-not $Out) {
  $dir = Split-Path -Parent $Video
  $base = [IO.Path]::GetFileNameWithoutExtension($Video)
  $Out = Join-Path $dir ($base + '-voice.mp4')
}

$aFilter = "adelay=$DelayMs|$DelayMs"
if ([math]::Abs($Atempo - 1.0) -gt 0.001) { $aFilter = "atempo=$Atempo," + $aFilter }

# 视频时长：用来把输出卡在视频长度上。-shortest 不够准（音频被 adelay 推后，
# 比视频长出 0.1 s 时会让末尾多冻一帧），所以显式 -t。
$vDur = [double](& ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 $Video)
if (($DelayMs / 1000.0 + $dur) -gt $vDur) {
  Write-Warning ("配音尾音超出视频 {0:N2} s，会被裁掉；把 -DelayMs 提前或 -Atempo 压一点" -f (($DelayMs / 1000.0 + $dur) - $vDur))
}

& ffmpeg -y -hide_banner -loglevel error -i $Video -i $landed `
  -filter_complex "[1:a]$aFilter[a]" -map 0:v -map '[a]' `
  -c:v copy -c:a aac -b:a 192k -ar 48000 -t $vDur -movflags +faststart $Out

if ($LASTEXITCODE -ne 0) { throw "ffmpeg 混音失败 exit=$LASTEXITCODE" }
Write-Host "成片（带配音）：$Out  · 起点 ${DelayMs}ms · 语速 x$Atempo"

Remove-Item -LiteralPath $landed -Force -ErrorAction SilentlyContinue
