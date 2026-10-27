/**
 * dsh-voice-speak — desktop speech bubble.
 *
 * A short-lived WPF window that shows the sentence just spoken, for when the DSH
 * page is not in front of the user. It is a thin, replaceable layer: one function,
 * one child process, no state, no window bookkeeping.
 *
 * Measured facts this file depends on (2026-10-27):
 *   - Speech runs at about 3.3–4 characters per second with our voice, so the
 *     bubble duration is `chars / 3.65 + 2 s` (clamped) instead of asking TTS:
 *     `tts.js` is not modified and cannot hand back `play_ms` before playback.
 *   - A non-DPI-aware process gets virtualized screen metrics (1536×960 for a
 *     125%-scaled 1920×1200 panel), which is how a window ends up off-screen and
 *     drifts. The child therefore declares per-monitor-v2 DPI awareness before
 *     creating any window, and places itself from `SystemParameters.WorkArea`.
 *   - `WS_EX_NOACTIVATE` plus `ShowActivated = false` keep the window from taking
 *     focus, so typing is not interrupted.
 *   - PowerShell dies with STATUS_DLL_INIT_FAILED (0xC0000142) when all three
 *     std handles are NUL, so stdout points at the log file descriptor.
 *
 * Known M3 roughness: every `say` spawns its own window, so sentences that start
 * close together overlap on screen. Windows are not tracked or replaced; M4 owns
 * that. A window outlives the host process, which is fine for a 5–10 s bubble.
 */
import { spawn } from 'node:child_process'
import { openSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const POWERSHELL = 'powershell.exe'
const LOG_FILE = 'dsh-voice-speak.log'
const LOG_PATH = join(tmpdir(), LOG_FILE)

/** Conservative end of the measured 3.3–4 字/秒 speaking rate. */
const CHARS_PER_SECOND = 3.3
/** The agreed 2 s tail so the bubble never closes on the last syllable. */
const DURATION_MARGIN_MS = 2000
/**
 * Edge synthesis happens before the first sound (measured 1.3–2.4 s) and the
 * window itself takes a moment to appear, so the estimate also carries a fixed
 * synthesis allowance. Measured 2026-10-27: a 19-character sentence took 1905 ms
 * to synthesize and 6081 ms to speak; with the 2 s tail alone the bubble closed
 * ~40 ms before the audio ended.
 */
const SYNTHESIS_ALLOWANCE_MS = 1500
const MIN_DURATION_MS = 3000
const MAX_DURATION_MS = 20000
/** Distance from the work-area corner, in device-independent pixels. */
const MARGIN_DIP = 24

/** The child's stdout sink: one fd for the whole plugin lifetime. */
let logFd = null
try {
  logFd = openSync(LOG_PATH, 'a')
} catch {
  logFd = null
}
const CHILD_STDIO = ['ignore', logFd ?? 'ignore', 'ignore']

/** Fixed window script; the sentence and duration arrive through the environment. */
const BUBBLE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshBubbleApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  /** Places the window in its monitor's work area, in physical pixels. */
  public static string PlaceBottomRight(IntPtr hWnd, int marginDip) {
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return "GetWindowRect failed";
    int width = rect.Right - rect.Left;
    int height = rect.Bottom - rect.Top;
    IntPtr monitor = MonitorFromWindow(hWnd, 2);
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(monitor, ref info)) return "GetMonitorInfo failed";
    uint dpi = GetDpiForWindow(hWnd);
    if (dpi == 0) dpi = 96;
    int margin = (int)(marginDip * dpi / 96.0);
    int x = info.rcWork.Right - width - margin;
    int y = info.rcWork.Bottom - height - margin;
    if (x < info.rcWork.Left) x = info.rcWork.Left;
    if (y < info.rcWork.Top) y = info.rcWork.Top;
    SetWindowPos(hWnd, new IntPtr(-1), x, y, 0, 0, 0x0001 | 0x0010);
    return string.Format("work=({0},{1})-({2},{3}) dpi={4} rect=({5},{6})-({7},{8})", info.rcWork.Left, info.rcWork.Top, info.rcWork.Right, info.rcWork.Bottom, dpi, x, y, x + width, y + height);
  }
}
'@
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$text = $env:DSH_BUBBLE_TEXT
$ms = [int]$env:DSH_BUBBLE_MS
$w = New-Object System.Windows.Window
$w.Title = 'DshSpeakBubble'
$w.WindowStyle = 'None'
$w.AllowsTransparency = $true
$w.Background = [System.Windows.Media.Brushes]::Transparent
$w.Topmost = $true
$w.ShowInTaskbar = $false
$w.ShowActivated = $false
$w.ResizeMode = 'NoResize'
$w.SizeToContent = 'WidthAndHeight'
$w.MaxWidth = 560
$border = New-Object System.Windows.Controls.Border
$border.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(246, 255, 255, 255))
$border.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 120, 170, 220))
$border.BorderThickness = New-Object System.Windows.Thickness 1
$border.CornerRadius = New-Object System.Windows.CornerRadius 14
$border.Padding = New-Object System.Windows.Thickness 16, 12, 16, 12
$labels = New-Object System.Windows.Controls.StackPanel
$title = New-Object System.Windows.Controls.TextBlock
$title.Text = [char]0x9CB8 + [char]0x9C7C + [char]0x5A18
$title.FontFamily = New-Object System.Windows.Media.FontFamily 'Microsoft YaHei UI, Microsoft YaHei'
$title.FontSize = 11
$title.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 90, 140, 190))
$title.Margin = New-Object System.Windows.Thickness 0, 0, 0, 4
$body = New-Object System.Windows.Controls.TextBlock
$body.Text = $text
$body.TextWrapping = 'Wrap'
$body.MaxWidth = 480
$body.FontFamily = New-Object System.Windows.Media.FontFamily 'Microsoft YaHei UI, Microsoft YaHei'
$body.FontSize = 15
$body.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 32, 40, 48))
[void]$labels.Children.Add($title)
[void]$labels.Children.Add($body)
$border.Child = $labels
$w.Content = $border
$w.Add_SourceInitialized({
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($w)
  $ex = [DshBubbleApi]::GetWindowLongPtr($helper.Handle, -20).ToInt64()
  $ex = $ex -bor 0x08000000 -bor 0x00000080 -bor 0x00000008
  [void][DshBubbleApi]::SetWindowLongPtr($helper.Handle, -20, [IntPtr]$ex)
})
$w.Show()
$w.UpdateLayout()
$handle = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
$placement = [DshBubbleApi]::PlaceBottomRight($handle, ${MARGIN_DIP})
try {
  Add-Content -Path (Join-Path $env:TEMP 'dsh-voice-speak.log') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' engine=bubble place ' + $placement) -Encoding utf8
} catch {}
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($ms)
$timer.Add_Tick({
  $timer.Stop()
  $w.Close()
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
})
$timer.Start()
[System.Windows.Threading.Dispatcher]::Run()
`

const BUBBLE_COMMAND = Buffer.from(BUBBLE_SCRIPT, 'utf16le').toString('base64')

/**
 * How long the bubble should stay up for one sentence.
 * Duration is estimated, never measured: `tts.js` owns playback and stays untouched.
 * Formula: 字数 / 3.3 字每秒 + 2 秒尾巴 + 1.5 秒合成预留（合成 1.3–2.4 s 发生在首声之前）。
 * @param {string} text - the sentence.
 * @returns {number} milliseconds, clamped to [3 s, 20 s].
 */
export function bubbleDurationMs(text) {
  const characters = [...String(text ?? '')].length
  const estimated = Math.round((characters / CHARS_PER_SECOND) * 1000) + DURATION_MARGIN_MS + SYNTHESIS_ALLOWANCE_MS
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, estimated))
}

/**
 * Show one sentence in a desktop bubble. Returns immediately; never throws.
 * @param {string} text - the sentence to display.
 * @returns {void}
 */
export function announce(text) {
  if (!IS_WINDOWS) return
  const sentence = typeof text === 'string' ? text.trim() : ''
  if (sentence === '') return
  const ms = bubbleDurationMs(sentence)

  let child
  try {
    child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', BUBBLE_COMMAND], {
      stdio: CHILD_STDIO,
      windowsHide: true,
      env: { ...process.env, DSH_BUBBLE_TEXT: sentence, DSH_BUBBLE_MS: String(ms) },
    })
  } catch (error) {
    logLine(`engine=bubble len=${sentence.length} ms=${ms} ERR ${oneLine(error)}`)
    return
  }

  child.on('error', (error) => logLine(`engine=bubble len=${sentence.length} ms=${ms} ERR ${oneLine(error)}`))
  child.unref()
}

/**
 * Append one diagnostic line without ever letting logging throw.
 * @param {string} line - the line body, prefixed with the current local timestamp.
 * @returns {void}
 */
function logLine(line) {
  try {
    const now = new Date()
    const pad = (value, width = 2) => String(value).padStart(width, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
      + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
    appendFileSync(LOG_PATH, `${stamp} ${line}\n`, 'utf8')
  } catch {
    // The log is diagnostic only.
  }
}

/**
 * Collapse an error into one line.
 * @param {unknown} error - the failure.
 * @returns {string} its message.
 */
function oneLine(error) {
  const text = error && error.message ? error.message : String(error)
  return text.replaceAll('\r', ' ').replaceAll('\n', ' ')
}
