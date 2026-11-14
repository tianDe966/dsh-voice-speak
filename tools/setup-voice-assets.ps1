<#
.SYNOPSIS
  把「微软离线自然语音 晓晓」装到本地，让 dsh-voice-speak 的第一优先级引擎能用。

.DESCRIPTION
  这个脚本只做「接线」，不打包、不分发任何微软资产。三样东西都要你自己从官方/镜像取得：
    1. Microsoft Cognitive Services Speech SDK（Embedded Speech 部分）
    2. Microsoft Windows Narrator 自然语音包 Xiaoxiao（MSIX）
    3. NaturalVoiceSAPIAdapter（第三方，把 Narrator 语音暴露成 SAPI voice）

  为什么不在仓库里带：这些是微软的知识产权，随插件分发属于侵权，而且微软随时可能下架。
  本仓库只提供「怎么接线」和「怎么校验」，资产留在你自己的机器上。

.PARAMETER Root
  资产落地目录，默认 D:\DSH_Project\TTS。**路径必须全 ASCII**（WPF / SAPI 在中文路径上会读不到）。

.PARAMETER Msix
  已下载的 Xiaoxiao MSIX 文件路径，或 http(s) 下载地址。留空则跳过语音包步骤（只做检查）。

.PARAMETER AdapterZip
  NaturalVoiceSAPIAdapter 的 zip 路径或 URL。默认取 GitHub Releases v0.2.11。

.PARAMETER MsixSha256
  期望的 MSIX 哈希。默认值是微软原版
  MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64 的 SHA256；换了版本就传新值。

.PARAMETER VerifyOnly
  只检查现状，不下载、不安装。

.EXAMPLE
  # 只体检
  .\setup-voice-assets.ps1 -VerifyOnly

.EXAMPLE
  # 装语音包 + 适配器
  .\setup-voice-assets.ps1 -Msix "D:\Downloads\MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy.Msix"
#>
[CmdletBinding()]
param(
  [string]$Root = 'D:\DSH_Project\TTS',
  [string]$Msix = '',
  [string]$AdapterZip = 'https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/releases/download/v0.2.11/NaturalVoiceSAPIAdapter_v0.2.11_x86_x64.zip',
  [string]$MsixSha256 = 'E069D67BEC8443AECFF49FBB971F46E72094F9A56177FD3C94734EF164542EDF',
  [string]$AdapterSha256 = '01A0D38E4B42750AF3CBD82A120215C83BEA9A5B1AE133805E0F82819C911994',
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$sdkDir     = Join-Path $Root 'SpeechSDK\win-x64'
$voicesDir  = Join-Path $Root 'NaturalVoices'
$xiaoxiao   = Join-Path $voicesDir 'Xiaoxiao'
$adapterDir = Join-Path $Root 'NaturalVoiceSAPIAdapter'
$dlDir      = Join-Path $Root 'downloads'

function Test-Assets {
  $r = [ordered]@{}
  $r['SpeechSDK (embedded tts dll)'] = Test-Path (Join-Path $sdkDir 'Microsoft.CognitiveServices.Speech.extension.embedded.tts.dll')
  $r['SpeechSDK (core dll)']         = Test-Path (Join-Path $sdkDir 'Microsoft.CognitiveServices.Speech.core.dll')
  $r['NaturalVoices\Xiaoxiao']       = Test-Path (Join-Path $xiaoxiao 'MSTTSLocZhCN.dat')
  $r['NaturalVoiceSAPIAdapter x64']  = Test-Path (Join-Path $adapterDir 'x64\NaturalVoiceSAPIAdapter.dll')
  $r['SAPI 里能看见 Xiaoxiao']        = $false
  try {
    Add-Type -AssemblyName System.Speech
    $names = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
    $r['SAPI 里能看见 Xiaoxiao'] = [bool]($names -match 'Xiaoxiao')
  } catch { }
  foreach ($k in $r.Keys) { Write-Host ('  {0,-34} {1}' -f $k, $(if ($r[$k]) { 'OK' } else { '缺' })) }
  return $r
}

'=== 现状体检（{0}）===' -f $Root
$state = Test-Assets
$allOk = ($state.Values -notcontains $false)
if ($allOk) { '  全部就绪，第一优先级引擎可用。'; if ($VerifyOnly) { return } }

if ($VerifyOnly) { '  （-VerifyOnly，不做改动）'; return }

# ---------- 1. 语音包 ----------
if ($Msix) {
  New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
  if ($Msix -match '^https?://') {
    $file = Join-Path $dlDir (Split-Path $Msix -Leaf)
    if (-not (Test-Path -LiteralPath $file)) {
      '下载语音包：{0}' -f $Msix
      & curl.exe -L --fail --max-time 900 -o $file $Msix
      if ($LASTEXITCODE -ne 0) { throw "下载失败 exit=$LASTEXITCODE" }
    }
    $Msix = $file
  }
  if (-not (Test-Path -LiteralPath $Msix)) { throw "MSIX 不存在：$Msix" }

  $hash = (Get-FileHash -LiteralPath $Msix -Algorithm SHA256).Hash
  '  SHA256 = {0}' -f $hash
  if ($MsixSha256 -and $hash -ne $MsixSha256) {
    throw "哈希不符！期望 $MsixSha256`n这可能是别的版本或下载被篡改，先确认来源再传 -MsixSha256 覆盖。"
  }

  $stage = Join-Path $dlDir '_msix_stage'
  if (Test-Path -LiteralPath $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  # MSIX 就是 zip，用 tar 解（Windows 10 1803+ 自带 bsdtar）
  & tar -xf $Msix -C $stage
  if ($LASTEXITCODE -ne 0) { throw "解压 MSIX 失败 exit=$LASTEXITCODE" }

  New-Item -ItemType Directory -Force -Path $xiaoxiao | Out-Null
  Get-ChildItem $stage -Force | ForEach-Object { Copy-Item $_.FullName $xiaoxiao -Recurse -Force }
  Remove-Item $stage -Recurse -Force
  '已落地语音文件：{0}' -f $xiaoxiao
} else {
  '  跳过语音包（没给 -Msix）。要装就把 MSIX 路径或 URL 传给 -Msix。'
}

# ---------- 2. SAPI 适配器 ----------
if (-not (Test-Path (Join-Path $adapterDir 'x64\NaturalVoiceSAPIAdapter.dll'))) {
  New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
  $zip = Join-Path $dlDir (Split-Path $AdapterZip -Leaf)
  if (-not (Test-Path -LiteralPath $zip)) {
    '下载适配器：{0}' -f $AdapterZip
    & curl.exe -L --fail --max-time 300 -o $zip $AdapterZip
    if ($LASTEXITCODE -ne 0) { throw "适配器下载失败 exit=$LASTEXITCODE" }
  }
  if ($AdapterSha256) {
    $h = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    '  适配器 SHA256 = {0}' -f $h
    if ($h -ne $AdapterSha256) { throw "适配器哈希不符，换版本时用 -AdapterSha256 覆盖期望值。" }
  }
  New-Item -ItemType Directory -Force -Path $adapterDir | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $adapterDir -Force
  '已解压适配器：{0}' -f $adapterDir
}

# ---------- 3. 用户级注册表（不需要管理员）----------
$enum = 'HKCU:\Software\NaturalVoiceSAPIAdapter\Enumerator'
New-Item -Path $enum -Force | Out-Null
Set-ItemProperty $enum -Name NoNarratorVoices  -Value 0 -Type DWord
Set-ItemProperty $enum -Name NoEdgeVoices      -Value 1 -Type DWord
Set-ItemProperty $enum -Name NoAzureVoices     -Value 1 -Type DWord
Set-ItemProperty $enum -Name NarratorVoicePath -Value $voicesDir -Type String
'已写用户配置：NarratorVoicePath = {0}' -f $voicesDir

# ---------- 4. 注册 DLL（要管理员）----------
$dll64 = Join-Path $adapterDir 'x64\NaturalVoiceSAPIAdapter.dll'
$dll32 = Join-Path $adapterDir 'x86\NaturalVoiceSAPIAdapter.dll'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
  foreach ($d in @($dll64, $dll32)) {
    if (Test-Path -LiteralPath $d) { & regsvr32.exe /s $d; '  regsvr32 {0} exit={1}' -f (Split-Path $d -Leaf), $LASTEXITCODE }
  }
} else {
  '需要管理员权限注册 DLL。请在**管理员** PowerShell 里跑这两行：'
  '  regsvr32 /s "{0}"' -f $dll64
  '  regsvr32 /s "{0}"' -f $dll32
}

# ---------- 5. 验证 ----------
'=== 装完体检 ==='
$after = Test-Assets
if ($after.Values -notcontains $false) {
  '全部就绪。现在可以在插件里听到微软离线晓晓了。'
} else {
  '还有缺项，最常见的原因是：没以管理员注册 DLL、或语音目录含非 ASCII 字符。'
}
