/**
 * Windows desktop tools for DeepSeek Harness (scratch plugin).
 *
 * Registers model-facing tools that observe and operate the local Windows
 * desktop: UI Automation snapshots, DPI-aware screenshots returned as images,
 * precise Unicode keyboard input, mouse, clipboard, application
 * launch/activation, and deterministic waiting. Modeled on the tool surface
 * of Windows-MCP (CursorTouch). Windows-only.
 *
 * A single persistent PowerShell helper process is started lazily and speaks
 * one-JSON-request-per-line over stdin/stdout; every tool call is a round trip
 * to that process, so no per-call PowerShell startup or C# compile happens.
 *
 * Load with: pnpm dsh web --patch ./scratch-plugin/windows-tools.cordis.yml
 * @module scratch-windows-tools
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'scratch-windows-tools'

export const inject = ['tools']

const POWERSHELL = process.env.SystemRoot !== undefined
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

const HOST_SCRIPT = String.raw`# Persistent Windows desktop helper host for the dsh scratch-windows-tools plugin.
# Reads one JSON request per line on stdin, executes it, and writes one JSON
# response per line on stdout. Pure ASCII: non-ASCII text travels as JSON
# escapes and output is forced to UTF-8.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WtNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr RealChildWindowFromPoint(IntPtr hWndParent, POINT pt);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

  public class WindowInfo {
    public IntPtr Handle;
    public int ProcessId;
    public bool Visible;
    public bool Iconic;
    public string Title;
  }

  public static WindowInfo[] ListTopLevelWindows() {
    List<WindowInfo> list = new List<WindowInfo>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      StringBuilder builder = new StringBuilder(512);
      GetWindowText(hWnd, builder, 512);
      string title = builder.ToString();
      if (title.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      WindowInfo info = new WindowInfo();
      info.Handle = hWnd;
      info.ProcessId = (int)pid;
      info.Visible = IsWindowVisible(hWnd);
      info.Iconic = IsIconic(hWnd);
      info.Title = title;
      list.Add(info);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static bool[] ExtendedFor(ushort[] vks) {
    bool[] extended = new bool[vks.Length];
    for (int i = 0; i < vks.Length; i++) {
      ushort vk = vks[i];
      if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C) extended[i] = true;
    }
    return extended;
  }

  public static void SendInputs(INPUT[] inputs) {
    int size = Marshal.SizeOf(typeof(INPUT));
    uint sent = SendInput((uint)inputs.Length, inputs, size);
    if (sent != inputs.Length) throw new Exception("SendInput delivered " + sent + " of " + inputs.Length + " events");
  }

  public static INPUT KeyEvent(ushort vk, bool keyUp, bool extended) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    input.u.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
    return input;
  }

  public static INPUT UnicodeEvent(ushort unit, bool keyUp) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = 0;
    input.u.ki.wScan = unit;
    input.u.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0);
    return input;
  }

  public static void TapChord(ushort[] vks) {
    bool[] extended = ExtendedFor(vks);
    List<INPUT> inputs = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) inputs.Add(KeyEvent(vks[i], false, extended[i]));
    for (int i = vks.Length - 1; i >= 0; i--) inputs.Add(KeyEvent(vks[i], true, extended[i]));
    SendInputs(inputs.ToArray());
  }

  public static void TypeText(string text) {
    List<INPUT> batch = new List<INPUT>();
    List<INPUT[]> chunks = new List<INPUT[]>();
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') {
        batch.Add(KeyEvent(0x0D, false, false));
        batch.Add(KeyEvent(0x0D, true, false));
      } else if (ch == '\t') {
        batch.Add(KeyEvent(0x09, false, false));
        batch.Add(KeyEvent(0x09, true, false));
      } else {
        batch.Add(UnicodeEvent(ch, false));
        batch.Add(UnicodeEvent(ch, true));
      }
      if (batch.Count >= 128) {
        chunks.Add(batch.ToArray());
        batch.Clear();
      }
    }
    if (batch.Count > 0) chunks.Add(batch.ToArray());
    foreach (INPUT[] chunk in chunks) {
      SendInputs(chunk);
      System.Threading.Thread.Sleep(2);
    }
  }
}
"@
[void][WtNative]::SetProcessDPIAware()

$script:AE = [System.Windows.Automation.AutomationElement]
$script:TS = [System.Windows.Automation.TreeScope]
$script:ANY = [System.Windows.Automation.Condition]::TrueCondition
$script:NEWLINE = [string][char]10
$script:wtMaxDepth = 100
$script:wtInteresting = @('Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'ListItem', 'TabItem', 'Hyperlink', 'Slider', 'Spinner', 'TreeItem', 'DataItem', 'Window', 'Menu', 'MenuBar', 'ToolBar', 'StatusBar', 'SplitButton', 'Group', 'Document', 'Text')
$script:wtCount = 0
$script:wtLines = $null
$script:wtProcCache = @{}

$script:keyMap = @{
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B; 'meta' = 0x5B
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
  'capslock' = 0x14; 'printscreen' = 0x2C
  'minus' = 0xBD; 'equal' = 0xBB; 'comma' = 0xBC; 'period' = 0xBE; 'slash' = 0xBF
  'semicolon' = 0xBA; 'quote' = 0xDE; 'backtick' = 0xC0; 'backslash' = 0xDC
  'bracketleft' = 0xDB; 'bracketright' = 0xDD
}
for ($i = 1; $i -le 12; $i++) { $script:keyMap["f$i"] = 0x6F + $i }
for ($i = 0; $i -le 9; $i++) { $script:keyMap["$i"] = 0x30 + $i }
foreach ($ch in [char[]]'abcdefghijklmnopqrstuvwxyz') { $script:keyMap["$ch"] = [int][char]::ToUpper($ch) }

function Get-WtScreenSummary {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return ('virtual ({0},{1}) {2}x{3} monitors={4}' -f $vs.Left, $vs.Top, $vs.Width, $vs.Height, [System.Windows.Forms.Screen]::AllScreens.Count)
}

function Get-WtMonitorLines {
  $lines = New-Object System.Collections.Generic.List[string]
  $index = 0
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $screen.Bounds
    $marker = ''
    if ($screen.Primary) { $marker = ' primary' }
    $lines.Add(('- monitor {0}: {1} @({2},{3} {4}x{5}){6}' -f $index, $screen.DeviceName, $b.X, $b.Y, $b.Width, $b.Height, $marker))
    $index++
  }
  return $lines
}

function Get-WtCursorPosition {
  $pt = New-Object WtNative+POINT
  [void][WtNative]::GetCursorPos([ref]$pt)
  return @{ x = $pt.X; y = $pt.Y }
}

function Get-WtForeground {
  $hwnd = [WtNative]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][WtNative]::GetWindowText($hwnd, $sb, 512)
  $r = New-Object WtNative+RECT
  [void][WtNative]::GetWindowRect($hwnd, [ref]$r)
  return @{ handle = $hwnd.ToInt64(); title = $sb.ToString(); x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}

function Get-WtProcessName($processId) {
  if ($script:wtProcCache.ContainsKey($processId)) { return $script:wtProcCache[$processId] }
  $name = '?'
  try {
    $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
  } catch { }
  $script:wtProcCache[$processId] = $name
  return $name
}

function Get-WtUiaTopWindows {
  $list = New-Object System.Collections.ArrayList
  try {
    $tops = $script:AE::RootElement.FindAll($script:TS::Children, $script:ANY)
    foreach ($w in $tops) {
      try {
        $c = $w.Current
        if ($c.ControlType.ProgrammaticName -ne 'ControlType.Window') { continue }
        [void]$list.Add($w)
      } catch { }
    }
  } catch { }
  return $list
}

function Get-WtWindowLine($el, [long]$foregroundHandle) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  $marker = '  '
  if ($c.NativeWindowHandle -ne 0 -and $c.NativeWindowHandle -eq $foregroundHandle) { $marker = 'FG' }
  $processName = Get-WtProcessName $c.ProcessId
  $state = ''
  try {
    $windowHandle = [IntPtr]$c.NativeWindowHandle
    if ($windowHandle -ne [IntPtr]::Zero) {
      if ([WtNative]::IsIconic($windowHandle)) { $state = ' state=minimized' }
      elseif ([WtNative]::IsZoomed($windowHandle)) { $state = ' state=maximized' }
      else { $state = ' state=normal' }
    }
  } catch { }
  return ('[{0}] "{1}" pid={2} process={3}{4} @({5},{6} {7}x{8})' -f $marker, $c.Name, $c.ProcessId, $processName, $state, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

function Get-WtWindowList([long]$foregroundHandle) {
  $list = New-Object System.Collections.Generic.List[string]
  foreach ($w in Get-WtUiaTopWindows) {
    try {
      $c = $w.Current
      if ([string]::IsNullOrWhiteSpace($c.Name)) { continue }
      $list.Add((Get-WtWindowLine $w $foregroundHandle))
    } catch { }
  }
  return $list
}

function Get-WtElementLine($el) {
  try {
    $c = $el.Current
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $name = $c.Name
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }
    if ($script:wtInteresting -notcontains $type) { return $null }
    if ($c.IsOffscreen) { return $null }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    $script:wtCount++
    $cx = [int]($r.X + $r.Width / 2)
    $cy = [int]($r.Y + $r.Height / 2)
    $focus = ''
    if ($c.HasKeyboardFocus) { $focus = ' FOCUS' }
    $id = ''
    if (-not [string]::IsNullOrEmpty($c.AutomationId)) { $id = ' id=' + $c.AutomationId }
    $shortName = $name
    if ($name.Length -gt 70) { $shortName = $name.Substring(0, 70) + '...' }
    return ('[{0}] {1} "{2}" @({3},{4}){5}{6}' -f $script:wtCount, $type, $shortName, $cx, $cy, $id, $focus)
  } catch {
    return $null
  }
}

function Walk-WtTree($el, $depth) {
  if ($depth -gt $script:wtMaxDepth) { return }
  try {
    $children = $el.FindAll($script:TS::Children, $script:ANY)
  } catch {
    return
  }
  foreach ($child in $children) {
    $line = Get-WtElementLine $child
    if ($null -ne $line) {
      $script:wtLines.Add((('  ' * $depth)) + $line)
      Walk-WtTree $child ($depth + 1)
    } else {
      Walk-WtTree $child $depth
    }
  }
}

function Get-WtStatus {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add(('screen: ' + (Get-WtScreenSummary)))
  foreach ($l in Get-WtMonitorLines) { $lines.Add($l) }
  $cursor = Get-WtCursorPosition
  $lines.Add(('cursor: ({0}, {1})' -f $cursor.x, $cursor.y))
  $fg = Get-WtForeground
  $lines.Add(('foreground: "{0}" handle={1} @({2},{3} {4}x{5})' -f $fg.title, $fg.handle, $fg.x, $fg.y, $fg.w, $fg.h))
  $windows = Get-WtWindowList $fg.handle
  $lines.Add(('windows ({0}):' -f $windows.Count))
  foreach ($l in $windows) { $lines.Add('  ' + $l) }
  return ($lines -join $script:NEWLINE)
}

function Get-WtSnapshot([string]$target) {
  $script:wtCount = 0
  $script:wtLines = New-Object System.Collections.Generic.List[string]
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add(('screen: ' + (Get-WtScreenSummary)))
  $fg = Get-WtForeground
  $lines.Add(('foreground: "{0}" handle={1} @({2},{3} {4}x{5})' -f $fg.title, $fg.handle, $fg.x, $fg.y, $fg.w, $fg.h))
  $windows = Get-WtWindowList $fg.handle
  $lines.Add(('windows ({0}):' -f $windows.Count))
  foreach ($l in $windows) { $lines.Add('  ' + $l) }
  $lines.Add('elements:')
  $rootEl = $null
  $resolvedTitle = ''
  if (-not [string]::IsNullOrWhiteSpace($target)) {
    foreach ($w in Get-WtUiaTopWindows) {
      try {
        $wc = $w.Current
        if ($wc.Name -like ('*' + $target + '*')) { $rootEl = $w; $resolvedTitle = $wc.Name; break }
      } catch { }
    }
    if ($null -eq $rootEl) {
      foreach ($w in [WtNative]::ListTopLevelWindows()) {
        if (-not $w.Visible) { continue }
        if ($w.Title.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        try { $el = $script:AE::FromHandle($w.Handle) } catch { $el = $null }
        if ($null -ne $el) { $rootEl = $el; $resolvedTitle = $w.Title; break }
      }
    }
    if ($null -eq $rootEl) {
      $resolved = Resolve-WtWindow $target
      if ($null -ne $resolved) {
        try { $rootEl = $script:AE::FromHandle($resolved.Handle); $resolvedTitle = $resolved.Title } catch { $rootEl = $null }
      }
    }
    if ($null -eq $rootEl) { throw (Format-WtNoWindowError $target) }
    $lines.Add(('target-window: "{0}"' -f $resolvedTitle))
  } else {
    $hwnd = [WtNative]::GetForegroundWindow()
    $rootEl = $script:AE::FromHandle($hwnd)
  }
  if ($null -ne $rootEl) {
    $rootLine = Get-WtElementLine $rootEl
    if ($null -ne $rootLine) { $script:wtLines.Add($rootLine) }
    Walk-WtTree $rootEl 1
  }
  foreach ($l in $script:wtLines) { $lines.Add($l) }
  $lines.Add(('element-count: {0}' -f $script:wtCount))
  return ($lines -join $script:NEWLINE)
}

function Get-WtScreenshotSource($req) {
  if ($null -ne $req.window -and [string]$req.window -ne '') {
    $found = Resolve-WtWindow ([string]$req.window)
    if ($null -eq $found) { throw (Format-WtNoWindowError ([string]$req.window)) }
    if ($found.Iconic) { throw ('the target window "{0}" is minimized; restore it before capturing (minimized windows are not rendered)' -f $found.Title) }
    $hwnd = $found.Handle
    $wr = New-Object WtNative+RECT
    [void][WtNative]::GetWindowRect($hwnd, [ref]$wr)
    $ww = $wr.Right - $wr.Left
    $wh = $wr.Bottom - $wr.Top
    if ($ww -le 0 -or $wh -le 0) { throw ('window "{0}" has an empty rectangle' -f $found.Title) }
    $full = New-Object System.Drawing.Bitmap $ww, $wh
    $graphics = [System.Drawing.Graphics]::FromImage($full)
    $hdc = $graphics.GetHdc()
    $ok = $false
    try { $ok = [WtNative]::PrintWindow($hwnd, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
    $graphics.Dispose()
    if (-not $ok) { $full.Dispose(); throw ('background capture (PrintWindow) failed for window "{0}"' -f $found.Title) }
    $cr = New-Object WtNative+RECT
    [void][WtNative]::GetClientRect($hwnd, [ref]$cr)
    $clientW = $cr.Right - $cr.Left
    $clientH = $cr.Bottom - $cr.Top
    $origin = New-Object WtNative+POINT
    $origin.X = 0
    $origin.Y = 0
    [void][WtNative]::ClientToScreen($hwnd, [ref]$origin)
    $offsetX = $origin.X - $wr.Left
    $offsetY = $origin.Y - $wr.Top
    if ($clientW -gt 0 -and $clientH -gt 0 -and $offsetX -ge 0 -and $offsetY -ge 0 -and ($offsetX + $clientW) -le $ww -and ($offsetY + $clientH) -le $wh) {
      $client = $full.Clone((New-Object System.Drawing.Rectangle $offsetX, $offsetY, $clientW, $clientH), $full.PixelFormat)
      $full.Dispose()
      return @{ bitmap = $client; label = ('window "{0}" client' -f $found.Title) }
    }
    return @{ bitmap = $full; label = ('window "{0}" frame' -f $found.Title) }
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $screen = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $graphics = [System.Drawing.Graphics]::FromImage($screen)
  $graphics.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $screen.Size)
  $graphics.Dispose()
  return @{ bitmap = $screen; label = 'screen' }
}

function Save-WtScreenshot($req) {
  $path = [string]$req.path
  if ([string]::IsNullOrWhiteSpace($path)) {
    $shotDir = Join-Path $env:TEMP 'opencode-windows-tools'
    if (-not (Test-Path $shotDir)) { New-Item -ItemType Directory -Path $shotDir -Force | Out-Null }
    $path = Join-Path $shotDir ('screenshot-{0}.png' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  }
  $source = Get-WtScreenshotSource $req
  $owned = New-Object System.Collections.Generic.List[object]
  try {
    $bitmap = $source.bitmap
    [void]$owned.Add($bitmap)
    if ($null -ne $req.width -and $null -ne $req.height) {
      $regionX = [int]$req.x
      $regionY = [int]$req.y
      $regionW = [int]$req.width
      $regionH = [int]$req.height
      if ($regionW -le 0 -or $regionH -le 0) { throw 'screenshot region must have positive width and height' }
      $left = [Math]::Max($regionX, 0)
      $top = [Math]::Max($regionY, 0)
      $right = [Math]::Min($regionX + $regionW, $bitmap.Width)
      $bottom = [Math]::Min($regionY + $regionH, $bitmap.Height)
      if ($right -le $left -or $bottom -le $top) { throw 'screenshot region does not intersect the captured image' }
      $cropped = $bitmap.Clone((New-Object System.Drawing.Rectangle $left, $top, ($right - $left), ($bottom - $top)), $bitmap.PixelFormat)
      [void]$owned.Add($cropped)
      $bitmap = $cropped
    }
    $scale = 1.0
    if ($null -ne $req.scale) { $scale = [double]$req.scale }
    if ($scale -lt 1) { $scale = 1 }
    if ($scale -gt 4) { $scale = 4 }
    $final = $bitmap
    if ($scale -gt 1) {
      $finalWidth = [int]([Math]::Round($bitmap.Width * $scale))
      $finalHeight = [int]([Math]::Round($bitmap.Height * $scale))
      $scaled = New-Object System.Drawing.Bitmap $finalWidth, $finalHeight
      [void]$owned.Add($scaled)
      $resizer = [System.Drawing.Graphics]::FromImage($scaled)
      $resizer.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $resizer.DrawImage($bitmap, 0, 0, $finalWidth, $finalHeight)
      $resizer.Dispose()
      $final = $scaled
    }
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $final.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    return ('saved: {0}|width:{1}|height:{2}|scale:{3}|source:{4}' -f $path, $final.Width, $final.Height, $scale, $source.label)
  } finally {
    foreach ($item in $owned) {
      try { $item.Dispose() } catch { }
    }
  }
}

function Get-WtPixel([int]$x, [int]$y) {
  $bmp = New-Object System.Drawing.Bitmap 1, 1
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size 1, 1))
  $color = $bmp.GetPixel(0, 0)
  $graphics.Dispose()
  $bmp.Dispose()
  return (($color.R -shl 16) -bor ($color.G -shl 8) -bor $color.B)
}

function Get-WtRegionSignature([int]$x, [int]$y, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $graphics.Dispose()
  $values = New-Object System.Collections.Generic.List[int]
  $stepX = [Math]::Max(1, [int]([Math]::Floor($w / 16)))
  $stepY = [Math]::Max(1, [int]([Math]::Floor($h / 16)))
  for ($py = 0; $py -lt $h; $py += $stepY) {
    for ($px = 0; $px -lt $w; $px += $stepX) {
      $color = $bmp.GetPixel($px, $py)
      $values.Add(($color.R + $color.G + $color.B))
    }
  }
  $bmp.Dispose()
  return $values.ToArray()
}

function Get-WtSignatureDifference($a, $b) {
  $sum = 0.0
  $n = [Math]::Min($a.Length, $b.Length)
  if ($n -le 0) { return 0.0 }
  for ($i = 0; $i -lt $n; $i++) {
    $sum += [Math]::Abs($a[$i] - $b[$i])
  }
  return $sum / $n
}

function Get-WtHitDescription([int]$x, [int]$y) {
  try {
    $element = $script:AE::FromPoint([System.Windows.Point]::new([double]$x, [double]$y))
    if ($null -ne $element) {
      $current = $element
      for ($i = 0; $i -lt 24 -and $null -ne $current; $i++) {
        try {
          $c = $current.Current
          if (-not [string]::IsNullOrWhiteSpace($c.Name)) {
            $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
            $id = ''
            if (-not [string]::IsNullOrEmpty($c.AutomationId)) { $id = ' id=' + $c.AutomationId }
            return ('{0} "{1}"{2}' -f $type, $c.Name, $id)
          }
        } catch { }
        try { $current = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($current) } catch { $current = $null }
      }
      try {
        $deepest = $element.Current
        $deepestType = $deepest.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        return ('unlabeled element (deepest: {0})' -f $deepestType)
      } catch {
        return 'unlabeled element'
      }
    }
  } catch { }
  try {
    $pt = New-Object WtNative+POINT
    $pt.X = $x
    $pt.Y = $y
    $hwnd = [WtNative]::WindowFromPoint($pt)
    if ($hwnd -ne [IntPtr]::Zero) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][WtNative]::GetWindowText($hwnd, $sb, 512)
      if (-not [string]::IsNullOrWhiteSpace($sb.ToString())) { return ('window "{0}" (no UIA element at this point)' -f $sb.ToString()) }
    }
  } catch { }
  return 'no labeled element at this point'
}

function Move-WtTo([int]$x, [int]$y) {
  [void][WtNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 20
}

function Get-WtKeyVks([string]$keys) {
  $vks = @()
  foreach ($part in $keys.ToLower().Split('+')) {
    $key = $part.Trim()
    if (-not $script:keyMap.ContainsKey($key)) { throw ('unknown key name: ' + $key) }
    $vks += ([uint16]$script:keyMap[$key])
  }
  return $vks
}

function Get-WtWindowTarget($req) {
  if ($null -eq $req.window -or [string]$req.window -eq '') { return $null }
  $found = Resolve-WtWindow ([string]$req.window)
  if ($null -eq $found) { throw (Format-WtNoWindowError ([string]$req.window)) }
  return $found
}

function Get-WtDeepestChildAt($hWnd, [int]$x, [int]$y) {
  $point = New-Object WtNative+POINT
  $point.X = $x
  $point.Y = $y
  $child = [WtNative]::RealChildWindowFromPoint($hWnd, $point)
  if ($child -eq [IntPtr]::Zero -or $child -eq $hWnd) { return @{ handle = $hWnd; x = $x; y = $y } }
  $frameOrigin = New-Object WtNative+POINT
  $frameOrigin.X = 0
  $frameOrigin.Y = 0
  [void][WtNative]::ClientToScreen($hWnd, [ref]$frameOrigin)
  $childOrigin = New-Object WtNative+POINT
  $childOrigin.X = 0
  $childOrigin.Y = 0
  [void][WtNative]::ClientToScreen($child, [ref]$childOrigin)
  return @{ handle = $child; x = ($x + $frameOrigin.X - $childOrigin.X); y = ($y + $frameOrigin.Y - $childOrigin.Y) }
}

function Get-WtBackgroundInputHandle($found) {
  try {
    $element = $script:AE::FromHandle($found.Handle)
    if ($null -ne $element) {
      $editCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)
      $documentCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
      $condition = New-Object System.Windows.Automation.OrCondition -ArgumentList $editCondition, $documentCondition
      $candidates = $element.FindAll($script:TS::Descendants, $condition)
      foreach ($candidate in $candidates) {
        try {
          $handle = $candidate.Current.NativeWindowHandle
          if ($handle -ne 0 -and $candidate.Current.IsEnabled) { return [IntPtr]$handle }
        } catch { }
      }
    }
  } catch { }
  # Qt top-level windows own keyboard routing for all their child surfaces;
  # posting characters to a native child (e.g. a render surface) is ignored.
  $classBuffer = New-Object System.Text.StringBuilder 256
  if ([WtNative]::GetClassName($found.Handle, $classBuffer, 256) -gt 0) {
    if ($classBuffer.ToString() -match '^Qt\d') { return $found.Handle }
  }
  $cr = New-Object WtNative+RECT
  [void][WtNative]::GetClientRect($found.Handle, [ref]$cr)
  $child = Get-WtDeepestChildAt $found.Handle ([int](($cr.Right - $cr.Left) / 2)) ([int](($cr.Bottom - $cr.Top) / 2))
  return $child.handle
}

function Invoke-WtBackgroundClick($found, [int]$x, [int]$y, [string]$button) {
  $target = Get-WtDeepestChildAt $found.Handle $x $y
  $hwnd = $target.handle
  $clientX = $target.x
  $clientY = $target.y
  # Qt windows hit-test posted mouse messages in client pixels on the
  # top-level window; native child surfaces ignore synthetic messages.
  $classBuffer = New-Object System.Text.StringBuilder 256
  if ([WtNative]::GetClassName($found.Handle, $classBuffer, 256) -gt 0 -and $classBuffer.ToString() -match '^Qt\d') {
    $hwnd = $found.Handle
  }
  $lp = [IntPtr]((($clientY -band 0xFFFF) -shl 16) -bor ($clientX -band 0xFFFF))
  [void][WtNative]::PostMessage($hwnd, 0x0200, [IntPtr]::Zero, $lp)
  Start-Sleep -Milliseconds 40
  $down = 0x0201
  $up = 0x0202
  $downWParam = [IntPtr]1
  if ($button -eq 'right') {
    $down = 0x0204
    $up = 0x0205
    $downWParam = [IntPtr]2
  }
  $clicks = 1
  if ($button -eq 'double') { $clicks = 2 }
  for ($i = 0; $i -lt $clicks; $i++) {
    $message = $down
    if ($button -eq 'double' -and $i -gt 0) { $message = 0x0203 }
    [void][WtNative]::PostMessage($hwnd, $message, $downWParam, $lp)
    Start-Sleep -Milliseconds 50
    [void][WtNative]::PostMessage($hwnd, $up, [IntPtr]::Zero, $lp)
    if ($i -lt $clicks - 1) { Start-Sleep -Milliseconds 80 }
  }
  return ('posted {0} click (background) to window "{1}" at client {2},{3}' -f $button, $found.Title, $x, $y)
}

function Invoke-WtBackgroundType($found, [string]$text) {
  $hwnd = Get-WtBackgroundInputHandle $found
  $procName = ''
  try { $procName = (Get-Process -Id $found.ProcessId -ErrorAction Stop).ProcessName } catch { }
  if ($procName -eq 'Weixin') {
    # WeChat's custom input stack decodes WM_CHAR as legacy ANSI bytes, not UTF-16.
    $bytes = [System.Text.Encoding]::Default.GetBytes($text)
    foreach ($b in $bytes) {
      [void][WtNative]::PostMessage($hwnd, 0x0102, [IntPtr][int]$b, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 8
    }
    return ('posted {0} bytes (background, ANSI) to window "{1}"' -f $bytes.Length, $found.Title)
  }
  foreach ($ch in $text.ToCharArray()) {
    $code = [int]$ch
    if ($code -eq 13) { continue }
    if ($code -eq 10) { $code = 13 }
    [void][WtNative]::PostMessage($hwnd, 0x0102, [IntPtr]$code, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 8
  }
  return ('posted {0} characters (background) to window "{1}"' -f $text.Length, $found.Title)
}

function Invoke-WtBackgroundKeys($found, [string]$keys) {
  $vks = Get-WtKeyVks $keys
  $hwnd = $found.Handle
  foreach ($vk in $vks) {
    [void][WtNative]::PostMessage($hwnd, 0x0100, [IntPtr]([int]$vk), [IntPtr]::Zero)
    Start-Sleep -Milliseconds 25
  }
  for ($i = $vks.Count - 1; $i -ge 0; $i--) {
    [void][WtNative]::PostMessage($hwnd, 0x0101, [IntPtr]([int]$vks[$i]), [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
  }
  return ('posted keys "{0}" (background) to window "{1}"' -f $keys, $found.Title)
}

function Invoke-WtBackgroundScroll($found, [int]$amount) {
  $hwnd = $found.Handle
  $wr = New-Object WtNative+RECT
  [void][WtNative]::GetWindowRect($hwnd, [ref]$wr)
  $centerX = [int](($wr.Left + $wr.Right) / 2)
  $centerY = [int](($wr.Top + $wr.Bottom) / 2)
  $lp = [IntPtr]((($centerY -band 0xFFFF) -shl 16) -bor ($centerX -band 0xFFFF))
  $steps = [Math]::Max(1, [Math]::Min(10, [Math]::Abs($amount)))
  $per = [int](($amount * 120) / $steps)
  for ($i = 0; $i -lt $steps; $i++) {
    $wParam = [IntPtr]((($per -band 0xFFFF) -shl 16))
    [void][WtNative]::PostMessage($hwnd, 0x020A, $wParam, $lp)
    Start-Sleep -Milliseconds 40
  }
  return ('posted scroll {0} wheel clicks (background) to window "{1}"' -f $amount, $found.Title)
}

function Read-WtWindowText([string]$target) {
  $found = Resolve-WtWindow $target
  if ($null -eq $found) { throw (Format-WtNoWindowError $target) }
  $element = $script:AE::FromHandle($found.Handle)
  if ($null -eq $element) { throw ('window "{0}" exposes no UI Automation element' -f $found.Title) }
  $documentCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
  $editCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)
  $condition = New-Object System.Windows.Automation.OrCondition -ArgumentList $documentCondition, $editCondition
  $candidates = $element.FindAll($script:TS::Descendants, $condition)
  foreach ($candidate in $candidates) {
    try {
      $textPattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
        $text = [string]$textPattern.DocumentRange.GetText(2000)
        if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) + '... (truncated)' }
        return $text
      }
      $valuePattern = $null
      if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $value = [string]$valuePattern.Current.Value
        if ($value.Length -gt 2000) { $value = $value.Substring(0, 2000) + '... (truncated)' }
        return $value
      }
    } catch { }
  }
  return '(no readable text control inside the window)'
}

function Invoke-WtMouse($req) {
  $target = Get-WtWindowTarget $req
  if ($null -ne $target) {
    $mode = [string]$req.mode
    if ($mode -eq 'click') {
      $button = 'left'
      if ($req.button) { $button = [string]$req.button }
      return Invoke-WtBackgroundClick $target ([int]$req.x) ([int]$req.y) $button
    }
    if ($mode -eq 'scroll') { return Invoke-WtBackgroundScroll $target ([int]$req.amount) }
    throw ('background mode (window) supports click and scroll only; got mode: ' + $mode)
  }
  switch ([string]$req.mode) {
    'move' {
      Move-WtTo ([int]$req.x) ([int]$req.y)
      return ('moved to {0},{1}' -f $req.x, $req.y)
    }
    'click' {
      $clickX = [int]$req.x
      $clickY = [int]$req.y
      Move-WtTo $clickX $clickY
      $hit = Get-WtHitDescription $clickX $clickY
      $button = 'left'
      if ($req.button) { $button = [string]$req.button }
      if ($button -eq 'right') {
        [WtNative]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        [WtNative]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
      }
      elseif ($button -eq 'double') {
        [WtNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [WtNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 90
        [WtNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [WtNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      else {
        [WtNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [WtNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      return ('clicked {0} at {1},{2} - hit: {3}' -f $button, $clickX, $clickY, $hit)
    }
    'drag' {
      $fx = [int]$req.fromX
      $fy = [int]$req.fromY
      $tx = [int]$req.x
      $ty = [int]$req.y
      Move-WtTo $fx $fy
      [WtNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      for ($i = 1; $i -le 12; $i++) {
        [void][WtNative]::SetCursorPos([int]($fx + ($tx - $fx) * $i / 12), [int]($fy + ($ty - $fy) * $i / 12))
        Start-Sleep -Milliseconds 15
      }
      Start-Sleep -Milliseconds 60
      [WtNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      return ('dragged {0},{1} -> {2},{3}' -f $fx, $fy, $tx, $ty)
    }
    'scroll' {
      $hitX = 0
      $hitY = 0
      if ($null -ne $req.x -and $null -ne $req.y) {
        $hitX = [int]$req.x
        $hitY = [int]$req.y
        Move-WtTo $hitX $hitY
      } else {
        $cursor = Get-WtCursorPosition
        $hitX = $cursor.x
        $hitY = $cursor.y
      }
      $hit = Get-WtHitDescription $hitX $hitY
      $amount = [int]$req.amount
      $steps = [Math]::Max(1, [Math]::Min(10, [Math]::Abs($amount)))
      $per = [int](($amount * 120) / $steps)
      for ($i = 0; $i -lt $steps; $i++) {
        [WtNative]::mouse_event(0x0800, 0, 0, $per, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
      }
      return ('scrolled {0} wheel clicks at {1},{2} - hit: {3}' -f $amount, $hitX, $hitY, $hit)
    }
    default { throw ('unknown mouse mode: ' + [string]$req.mode) }
  }
}

function Format-WtNoWindowError([string]$target) {
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($w in [WtNative]::ListTopLevelWindows()) {
    if ($items.Count -ge 8) { break }
    if ($w.Visible -and -not [string]::IsNullOrWhiteSpace($w.Title)) { $items.Add(('"{0}" [{1}]' -f $w.Title, (Get-WtProcessName $w.ProcessId))) }
  }
  return ('no window matches "{0}"; visible windows (title [process]): {1}; tip: targets match a title substring, a process name (e.g. Weixin), or a PID - WeChat 4.x retitles its main window with the open chat, so prefer its process name or PID' -f $target, ($items -join ' | '))
}

function Resolve-WtWindow([string]$target) {
  $isPid = $target -match '^[0-9]+$'
  $pidValue = -1
  if ($isPid) { $pidValue = [int]$target }
  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($w in [WtNative]::ListTopLevelWindows()) {
    if ($pidValue -ge 0) {
      if ($w.ProcessId -ne $pidValue) { continue }
    } else {
      if ($w.Title.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    }
    [void]$candidates.Add($w)
  }
  if ($candidates.Count -eq 0 -and $pidValue -lt 0) {
    # Some apps retitle their main window dynamically (WeChat 4.x shows the
    # open chat's name), so a title lookup fails; fall back to the process name.
    $procPids = @{}
    $procName = [System.IO.Path]::GetFileNameWithoutExtension($target)
    foreach ($p in (Get-Process -Name $procName -ErrorAction SilentlyContinue)) { $procPids[$p.Id] = $true }
    if ($procPids.Count -gt 0) {
      foreach ($w in [WtNative]::ListTopLevelWindows()) {
        if ($procPids.ContainsKey($w.ProcessId)) { [void]$candidates.Add($w) }
      }
    }
  }
  if ($candidates.Count -eq 0 -and $pidValue -ge 0) {
    # Packaged or stub launchers expose the real window under another process;
    # fall back to every window owned by a same-named process.
    $processName = $null
    try {
      $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName
    } catch { }
    if ($null -ne $processName) {
      $sameNamePids = @{}
      foreach ($p in (Get-Process -Name $processName -ErrorAction SilentlyContinue)) { $sameNamePids[$p.Id] = $true }
      foreach ($w in [WtNative]::ListTopLevelWindows()) {
        if ($sameNamePids.ContainsKey($w.ProcessId)) { [void]$candidates.Add($w) }
      }
    }
  }
  if ($candidates.Count -eq 0) { return $null }
  $best = $null
  foreach ($w in $candidates) {
    if ($w.Visible -and -not $w.Iconic) { return $w }
  }
  foreach ($w in $candidates) {
    if ($w.Visible) { return $w }
  }
  return $candidates[0]
}

function Invoke-WtActivate([string]$target) {
  $found = Resolve-WtWindow $target
  if ($null -eq $found) {
    $isPid = $target -match '^[0-9]+$'
    if ($isPid) {
      $process = Get-Process -Id ([int]$target) -ErrorAction SilentlyContinue
      if ($null -eq $process) { throw ('process {0} does not exist' -f $target) }
      throw ('process {0} ({1}) is running but exposes no top-level window to activate' -f $target, $process.ProcessName)
    }
    throw (Format-WtNoWindowError $target)
  }
  $hwnd = $found.Handle
  if ($found.Iconic) { [void][WtNative]::ShowWindow($hwnd, 9) }
  elseif (-not $found.Visible) { [void][WtNative]::ShowWindow($hwnd, 5) }
  Start-Sleep -Milliseconds 100
  if ([WtNative]::GetForegroundWindow() -ne $hwnd) {
    $ourThread = [WtNative]::GetCurrentThreadId()
    $fgThread = 0
    [void][WtNative]::GetWindowThreadProcessId([WtNative]::GetForegroundWindow(), [ref]$fgThread)
    $targetThread = 0
    [void][WtNative]::GetWindowThreadProcessId($hwnd, [ref]$targetThread)
    $attachedFg = $false
    $attachedTarget = $false
    try {
      if ($fgThread -ne 0 -and $fgThread -ne $ourThread) { $attachedFg = [WtNative]::AttachThreadInput($ourThread, $fgThread, $true) }
      if ($targetThread -ne 0 -and $targetThread -ne $ourThread -and $targetThread -ne $fgThread) { $attachedTarget = [WtNative]::AttachThreadInput($ourThread, $targetThread, $true) }
      [void][WtNative]::BringWindowToTop($hwnd)
      [void][WtNative]::SetForegroundWindow($hwnd)
      [void][WtNative]::SetActiveWindow($hwnd)
    } finally {
      if ($attachedTarget) { [void][WtNative]::AttachThreadInput($ourThread, $targetThread, $false) }
      if ($attachedFg) { [void][WtNative]::AttachThreadInput($ourThread, $fgThread, $false) }
    }
    Start-Sleep -Milliseconds 120
    if ([WtNative]::GetForegroundWindow() -ne $hwnd) {
      [WtNative]::TapChord([uint16[]]@(0x12))
      Start-Sleep -Milliseconds 40
      [void][WtNative]::SetForegroundWindow($hwnd)
      Start-Sleep -Milliseconds 120
    }
  }
  $now = [WtNative]::GetForegroundWindow()
  if ($now -eq $hwnd) { return ('activated: "{0}" (handle {1})' -f $found.Title, $found.Handle.ToInt64()) }
  $nowPid = 0
  [void][WtNative]::GetWindowThreadProcessId($now, [ref]$nowPid)
  $targetPid = 0
  [void][WtNative]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
  if ($nowPid -ne 0 -and $nowPid -eq $targetPid) {
    $sbModal = New-Object System.Text.StringBuilder 512
    [void][WtNative]::GetWindowText($now, $sbModal, 512)
    return ('activated: "{0}" (the same app''s modal dialog "{1}" holds the foreground)' -f $found.Title, $sbModal.ToString())
  }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WtNative]::GetWindowText($now, $sb, 512)
  throw ('activation did not take effect: "' + $found.Title + '" did not become foreground; current foreground is "' + $sb.ToString() + '". Try calling windows_app activate again, or activate by another title.')
}

function Send-WtKeys([string]$keys) {
  $vks = @()
  foreach ($part in $keys.ToLower().Split('+')) {
    $key = $part.Trim()
    if (-not $script:keyMap.ContainsKey($key)) { throw ('unknown key name: ' + $key) }
    $vks += ([uint16]$script:keyMap[$key])
  }
  [WtNative]::TapChord([uint16[]]$vks)
  Start-Sleep -Milliseconds 30
  return ('pressed: ' + $keys)
}

function Get-WtFocusedText {
  try {
    $focused = $script:AE::FocusedElement
    if ($null -eq $focused) { return $null }
    $valuePattern = $null
    if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
      return [string]$valuePattern.Current.Value
    }
    $textPattern = $null
    if ($focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
      return [string]$textPattern.DocumentRange.GetText(4000)
    }
  } catch { }
  return $null
}

function Confirm-WtTyped([string]$text, [string]$mode) {
  $observed = Get-WtFocusedText
  if ($null -eq $observed) { return ' (not verified: the focused control exposes no readable text)' }
  $normalizedObserved = $observed.Replace([string][char]13, '')
  $normalizedTyped = $text.Replace([string][char]13, '')
  if ($normalizedObserved.Length -ge 3990) {
    return ' (not verified: the focused text is too long to compare)'
  }
  if ($normalizedObserved.IndexOf($normalizedTyped, [System.StringComparison]::Ordinal) -ge 0) {
    return ' (verified: the focused control now contains the typed text)'
  }
  $snippet = $normalizedObserved
  if ($snippet.Length -gt 120) { $snippet = $snippet.Substring(0, 120) + '...' }
  throw ('typed via ' + $mode + ' but the focused control text does not contain the input; focused text now starts with: "' + $snippet + '"')
}

function Repair-WtTypeFocus($req) {
  try {
    $focused = $script:AE::FocusedElement
    if ($null -ne $focused) {
      try {
        $ft = $focused.Current.ControlType.ProgrammaticName
        if ($ft -eq 'ControlType.Edit' -or $ft -eq 'ControlType.Document') { return '' }
      } catch { }
    }
    $searchRoot = $null
    if ($null -ne $req.activate -and [string]$req.activate -ne '') {
      $t = Resolve-WtWindow ([string]$req.activate)
      if ($null -ne $t) { $searchRoot = $script:AE::FromHandle($t.Handle) }
    }
    if ($null -eq $searchRoot) { $searchRoot = $script:AE::FromHandle([WtNative]::GetForegroundWindow()) }
    if ($null -eq $searchRoot) { return '' }
    $editCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)
    $edits = $searchRoot.FindAll($script:TS::Descendants, $editCondition)
    $candidate = $null
    foreach ($e in $edits) {
      try {
        $ec = $e.Current
        if (-not $ec.IsEnabled -or -not $ec.IsKeyboardFocusable) { continue }
        if ($ec.AutomationId -match '(?i)file' -or $ec.AutomationId -eq '1148' -or $ec.AutomationId -eq 'FileNameControlHost') { $candidate = $e; break }
      } catch { }
    }
    if ($null -eq $candidate) { return '' }
    $candidate.SetFocus()
    Start-Sleep -Milliseconds 100
    return ' (focused edit "' + $candidate.Current.Name + '" first)'
  } catch {
    return ''
  }
}

function Invoke-WtType($req) {
  $text = [string]$req.text
  $target = Get-WtWindowTarget $req
  if ($null -ne $target) {
    $note = Invoke-WtBackgroundType $target $text
    if (([string]$req.clear) -eq 'True' -or ([string]$req.clear) -eq '1' -or ([string]$req.clear) -eq 'true') { $note = $note + ' (clear is ignored in background mode)' }
    return ($note + ' (background: not verified)')
  }
  if ($null -ne $req.activate -and [string]$req.activate -ne '') { [void](Invoke-WtActivate ([string]$req.activate)) }
  $focusNote = Repair-WtTypeFocus $req
  $mode = 'keys'
  if ($req.mode) { $mode = [string]$req.mode }
  $clearText = ([string]$req.clear) -eq 'True' -or ([string]$req.clear) -eq '1' -or ([string]$req.clear) -eq 'true'
  if ($clearText) {
    [WtNative]::TapChord([uint16[]]@(0x11, 0x41))
    Start-Sleep -Milliseconds 60
  }
  if ($mode -eq 'paste') {
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 90
    [WtNative]::TapChord([uint16[]]@(0x11, 0x56))
  } else {
    [WtNative]::TypeText($text)
  }
  Start-Sleep -Milliseconds 120
  $note = Confirm-WtTyped $text $mode
  return ('typed {0} characters ({1}){2}{3}' -f $text.Length, $mode, $note, $focusNote)
}

function Read-WtFocusedText {
  $text = Get-WtFocusedText
  if ($null -eq $text) { return '(focused control exposes no readable text)' }
  if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) + '... (truncated)' }
  return $text
}

function Invoke-WtLaunch([string]$target, $launchArgs) {
  $before = @{}
  foreach ($w in [WtNative]::ListTopLevelWindows()) { $before[$w.Handle.ToInt64()] = $true }
  $p = $null
  if ($null -ne $launchArgs -and [string]$launchArgs -ne '') {
    $p = Start-Process -FilePath $target -ArgumentList ([string]$launchArgs) -PassThru
  } else {
    $p = Start-Process -FilePath $target -PassThru
  }
  if ($null -eq $p) { return ('launched: ' + $target) }
  $processName = $null
  try { $processName = $p.ProcessName } catch { }
  $newWindow = $null
  $bestArea = -1
  $lastHandle = [IntPtr]::Zero
  $stable = 0
  $deadline = (Get-Date).AddSeconds(6)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $pollBest = $null
    $pollArea = -1
    foreach ($w in [WtNative]::ListTopLevelWindows()) {
      if ($before.ContainsKey($w.Handle.ToInt64())) { continue }
      if (-not $w.Visible) { continue }
      if ($null -ne $processName -and (Get-WtProcessName $w.ProcessId) -ne $processName) { continue }
      $r = New-Object WtNative+RECT
      [void][WtNative]::GetWindowRect($w.Handle, [ref]$r)
      $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($area -gt $pollArea) { $pollArea = $area; $pollBest = $w }
    }
    if ($null -ne $pollBest) {
      if ($pollBest.Handle -eq $lastHandle) { $stable++ } else { $stable = 0; $lastHandle = $pollBest.Handle }
      if ($pollArea -gt $bestArea) { $bestArea = $pollArea; $newWindow = $pollBest }
      if ($stable -ge 2) { break }
    }
  }
  if ($null -ne $newWindow) {
    return ('launched: {0} (pid {1}); new window "{2}" handle={3}' -f $target, $p.Id, $newWindow.Title, $newWindow.Handle.ToInt64())
  }
  return ('launched: {0} (pid {1})' -f $target, $p.Id)
}

function Invoke-WtClipboard($req) {
  if ([string]$req.action -eq 'set') {
    Set-Clipboard -Value ([string]$req.text)
    return ('clipboard set: {0} characters' -f ([string]$req.text).Length)
  }
  $text = Get-Clipboard -Raw
  if ($null -eq $text) { $text = '' }
  $text = [string]$text
  if ($text.Length -gt 100000) { $text = $text.Substring(0, 100000) + '... (truncated)' }
  return $text
}

function Invoke-WtWaitFor($req) {
  $timeoutMs = 10000
  if ($null -ne $req.timeoutSeconds) { $timeoutMs = [int]([double]$req.timeoutSeconds * 1000) }
  if ($timeoutMs -lt 100) { $timeoutMs = 100 }
  if ($timeoutMs -gt 60000) { $timeoutMs = 60000 }
  $kind = [string]$req.kind
  $value = ''
  if ($null -ne $req.value) { $value = [string]$req.value }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $regionX = $vs.Left
  $regionY = $vs.Top
  $regionW = $vs.Width
  $regionH = $vs.Height
  if ($null -ne $req.width -and $null -ne $req.height) {
    $regionX = [int]$req.x
    $regionY = [int]$req.y
    $regionW = [int]$req.width
    $regionH = [int]$req.height
  }
  if ($regionW -le 0 -or $regionH -le 0) { throw 'wait_for region must have positive width and height' }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()

  if ($kind -eq 'pixel') {
    if ($null -eq $req.x -or $null -eq $req.y) { throw 'pixel condition requires x and y' }
    $pixelX = [int]$req.x
    $pixelY = [int]$req.y
    $initialColor = Get-WtPixel $pixelX $pixelY
    while ($true) {
      if ((Get-WtPixel $pixelX $pixelY) -ne $initialColor) { return ('condition met after {0} ms (pixel changed)' -f $watch.ElapsedMilliseconds) }
      if ($watch.ElapsedMilliseconds -ge $timeoutMs) { break }
      Start-Sleep -Milliseconds 150
    }
    throw ('windows_wait_for timed out after {0} ms: pixel at {1},{2} did not change' -f $timeoutMs, $pixelX, $pixelY)
  }

  if ($kind -eq 'region') {
    $threshold = 20.0
    if ($null -ne $req.threshold) { $threshold = [double]$req.threshold }
    $initial = Get-WtRegionSignature $regionX $regionY $regionW $regionH
    while ($true) {
      $current = Get-WtRegionSignature $regionX $regionY $regionW $regionH
      $difference = Get-WtSignatureDifference $initial $current
      if ($difference -ge $threshold) { return ('condition met after {0} ms (region changed, diff={1:N1})' -f $watch.ElapsedMilliseconds, $difference) }
      if ($watch.ElapsedMilliseconds -ge $timeoutMs) { break }
      Start-Sleep -Milliseconds 150
    }
    throw ('windows_wait_for timed out after {0} ms: region {1},{2} {3}x{4} did not change beyond threshold {5}' -f $timeoutMs, $regionX, $regionY, $regionW, $regionH, $threshold)
  }

  if ($kind -eq 'settle') {
    $stableFrames = 3
    if ($null -ne $req.stableFrames) { $stableFrames = [int]$req.stableFrames }
    if ($stableFrames -lt 2) { $stableFrames = 2 }
    if ($stableFrames -gt 20) { $stableFrames = 20 }
    $previous = Get-WtRegionSignature $regionX $regionY $regionW $regionH
    $stable = 0
    while ($true) {
      Start-Sleep -Milliseconds 150
      $current = Get-WtRegionSignature $regionX $regionY $regionW $regionH
      $difference = Get-WtSignatureDifference $previous $current
      $previous = $current
      if ($difference -lt 4.0) { $stable++ } else { $stable = 0 }
      if ($stable -ge $stableFrames) { return ('screen settled after {0} ms ({1} stable frames)' -f $watch.ElapsedMilliseconds, $stable) }
      if ($watch.ElapsedMilliseconds -ge $timeoutMs) { break }
    }
    throw ('windows_wait_for timed out after {0} ms: the region never stayed still for {1} frames' -f $timeoutMs, $stableFrames)
  }

  while ($true) {
    $met = $false
    if ($kind -eq 'foreground') {
      $fg = Get-WtForeground
      if ($fg.title.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $met = $true }
    } elseif ($kind -eq 'window') {
      foreach ($w in [WtNative]::ListTopLevelWindows()) {
        if ($w.Visible -and $w.Title.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $met = $true; break }
      }
    } else {
      throw ('unknown wait_for kind: ' + $kind)
    }
    if ($met) { return ('condition met after {0} ms ({1})' -f $watch.ElapsedMilliseconds, $kind) }
    if ($watch.ElapsedMilliseconds -ge $timeoutMs) { break }
    Start-Sleep -Milliseconds 150
  }
  throw ('windows_wait_for timed out after {0} ms: no {1} matched "{2}"' -f $timeoutMs, $kind, $value)
}

function Invoke-WtCommand($req) {
  switch ([string]$req.cmd) {
    'status' { return Get-WtStatus }
    'snapshot' { return Get-WtSnapshot ([string]$req.target) }
    'screenshot' { return Save-WtScreenshot $req }
    'hit' { return Get-WtHitDescription ([int]$req.x) ([int]$req.y) }
    'mouse' { return Invoke-WtMouse $req }
    'keys' {
      $target = Get-WtWindowTarget $req
      if ($null -ne $target) { return Invoke-WtBackgroundKeys $target ([string]$req.keys) }
      if ($null -ne $req.activate -and [string]$req.activate -ne '') { [void](Invoke-WtActivate ([string]$req.activate)) }
      return Send-WtKeys ([string]$req.keys)
    }
    'type' { return Invoke-WtType $req }
    'activate' { return Invoke-WtActivate ([string]$req.target) }
    'launch' { return Invoke-WtLaunch ([string]$req.target) $req.args }
    'clipboard' { return Invoke-WtClipboard $req }
    'waitfor' { return Invoke-WtWaitFor $req }
    'readtext' { return Read-WtFocusedText }
    'readwindow' { return Read-WtWindowText ([string]$req.target) }
    default { throw ('unknown command: ' + [string]$req.cmd) }
  }
}

[Console]::Out.WriteLine('{"ok":true,"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $response = $null
  try {
    $request = $line | ConvertFrom-Json
    $output = Invoke-WtCommand $request
    $response = @{ ok = $true; output = [string]$output } | ConvertTo-Json -Compress -Depth 8
  } catch {
    $response = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 8
  }
  [Console]::Out.WriteLine($response)
  [Console]::Out.Flush()
}
`

const HOST_SCRIPT_PATH = join(tmpdir(), 'dsh-windows-tools', 'wt-host.ps1')

/** One in-flight helper call waiting for its response line. */
interface PendingCall {
  resolve: (output: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Live helper process plus its FIFO request queue. */
interface HostState {
  child: ChildProcess
  pending: PendingCall[]
}

let host: HostState | undefined

/** Reject every pending call and stop the helper process. */
function killHost(error: Error): void {
  const current = host
  host = undefined
  if (current === undefined) return
  for (const call of current.pending.splice(0)) {
    clearTimeout(call.timer)
    call.reject(error)
  }
  current.child.kill()
}

/** Start the helper on first use; keep it for the life of the plugin. */
function ensureHost(): HostState {
  if (host !== undefined) return host
  mkdirSync(join(tmpdir(), 'dsh-windows-tools'), { recursive: true })
  writeFileSync(HOST_SCRIPT_PATH, HOST_SCRIPT, 'utf8')
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT_PATH], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state: HostState = { child, pending: [] }
  host = state
  const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream })
  reader.on('line', (line: string) => {
    let message: { ready?: boolean; ok?: boolean; output?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (message.ready === true) return
    const call = state.pending.shift()
    if (call === undefined) return
    clearTimeout(call.timer)
    if (message.ok === true) call.resolve(String(message.output ?? ''))
    else call.reject(new Error(String(message.error ?? 'windows helper command failed')))
  })
  child.on('close', () => {
    if (host !== state) return
    host = undefined
    for (const call of state.pending.splice(0)) {
      clearTimeout(call.timer)
      call.reject(new Error('windows helper exited unexpectedly'))
    }
  })
  child.stderr?.setEncoding('utf8')
  // Keep the pipe drained; helper failures surface through exit codes and responses.
  child.stderr?.on('data', () => {})
  return state
}

/** Serialize one request as pure-ASCII JSON so stdin decoding cannot garble non-ASCII text. */
function encodeRequest(request: Record<string, unknown>): string {
  return JSON.stringify(request).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Send one command to the helper and await its response. */
function callHost(request: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const state = ensureHost()
  return new Promise((resolve, reject) => {
    const call: PendingCall = {
      resolve,
      reject,
      timer: setTimeout(() => {
        killHost(new Error(`windows helper timed out after ${String(timeoutMs)} ms`))
      }, timeoutMs),
    }
    state.pending.push(call)
    state.child.stdin?.write(`${encodeRequest(request)}\n`)
  })
}

/** Default screenshot destination outside the workspace. */
function defaultScreenshotPath(): string {
  const dir = join(tmpdir(), 'dsh-windows-tools')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, `screenshot-${stamp}.png`)
}

/** Minimal surface of the attachment store used to return screenshots to the model. */
interface ImageSaver {
  saveImages: (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) => Promise<readonly ImageAttachmentRef[]>
}

/** Register the Windows desktop tools on the host tools registry. */
export function apply(ctx: Context): void {
  if (process.platform !== 'win32') return

  ctx.effect(() => () => {
    killHost(new Error('windows helper disposed'))
  })

  ctx.tools.register(defineTool({
    name: 'windows_status',
    description: 'Environment overview of the Windows desktop: virtual screen size and the full monitor layout, current cursor position, the foreground window, and every visible top-level window with its rectangle, owning process name, window state (normal/minimized/maximized), and a foreground marker. Cheap to call; use windows_snapshot when you need interactive element coordinates.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute() {
      return callHost({ cmd: 'status' }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_snapshot',
    description: 'Capture the desktop UI state for automation: virtual screen size, foreground window, visible windows, and the interactive element tree (buttons, edits, list items, menus, links, ...) of the foreground window, each with screen coordinates. Set `window` to capture a specific window by title substring instead. Coordinates are virtual-desktop pixels with origin at the top-left; pass them to windows_click / windows_move / windows_drag.',
    parameters: {
      window: { type: 'string', description: 'Optional window target: title substring, process name, or PID; when set, the element tree of the matching top-level window is captured instead of the foreground window.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'snapshot' }
      if (args.window !== undefined) request.target = args.window
      return callHost(request, 45000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_screenshot',
    description: 'Capture a PNG screenshot (DPI-aware, physical pixels) and return it so you can see the screen. By default the physical screen is captured; give `window` to capture one window in the background instead — this works even when that window is covered by other windows, without disturbing the user (minimized windows are not supported). Give x, y, width, height for a region and scale (1-4) to enlarge small text or icons; in window mode the region is relative to the captured window image. Prefer windows_snapshot when you need interactive element coordinates, because a screenshot shows pixels only.',
    parameters: {
      filePath: { type: 'string', description: 'Optional absolute path for the PNG file; defaults to a timestamped file under the system temporary directory.' },
      attachImage: { type: 'boolean', description: 'Set false to skip returning the image and only save the file; defaults to true.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Captures that window in the background instead of the screen.' },
      x: { type: 'integer', description: 'Optional region left edge in screen pixels.' },
      y: { type: 'integer', description: 'Optional region top edge in screen pixels.' },
      width: { type: 'integer', description: 'Optional region width; requires x and y.' },
      height: { type: 'integer', description: 'Optional region height; requires x and y.' },
      scale: { type: 'number', description: 'Optional enlargement factor 1-4 applied to the captured image; defaults to 1.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          scale: { type: 'number', required: true },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const scaledNote = value.scale > 1
          ? ` The image is enlarged ${String(value.scale)}x: divide image coordinates by ${String(value.scale)} to get screen coordinates.`
          : ''
        const blocks: ContentBlock[] = [{
          type: 'text',
          text: `Screenshot saved to ${value.path} (${String(value.width)}x${String(value.height)} px).${scaledNote}`,
        }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image as ImageAttachmentRef })
        return blocks
      },
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const path = args.filePath ?? defaultScreenshotPath()
      const request: Record<string, unknown> = { cmd: 'screenshot', path }
      if (args.window !== undefined) request.window = args.window
      if (args.x !== undefined && args.y !== undefined && args.width !== undefined && args.height !== undefined) {
        request.x = args.x
        request.y = args.y
        request.width = args.width
        request.height = args.height
      }
      if (args.scale !== undefined) request.scale = args.scale
      const response = await callHost(request, 45000)
      const geometry = /^saved: (.+)\|width:(\d+)\|height:(\d+)\|scale:([0-9.]+)\|source:/.exec(response)
      if (geometry === null) throw new Error(`screenshot helper returned an unexpected result: ${response}`)
      const finalPath = geometry[1] ?? path
      const width = Number(geometry[2])
      const height = Number(geometry[3])
      const scale = Number(geometry[4])
      const bytes = statSync(finalPath).size
      if (args.attachImage !== false) {
        const store = ctx.get('attachments') as ImageSaver | undefined
        if (store !== undefined) {
          try {
            const refs = await store.saveImages([{ data: readFileSync(finalPath), mediaType: 'image/png', name: basename(finalPath) }])
            return refs[0] !== undefined ? { path: finalPath, bytes, width, height, scale, image: refs[0] } : { path: finalPath, bytes, width, height, scale }
          } catch {
            // Image admission refused the capture; keep the file-only result.
          }
        }
      }
      return { path: finalPath, bytes, width, height, scale }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_click',
    description: 'Click a mouse button and report the UI element under the point (UIA hit-test) so you can confirm the target. Default: screen coordinates in virtual-desktop pixels, executed on the real desktop (moves the cursor and changes focus). With `window`: x, y are CLIENT coordinates of that window and the click is posted in the background without moving the mouse or changing focus — best-effort, reliable for classic Win32 and Qt apps (including WeChat 4.x, whose message routing and encoding are handled automatically), while Chromium/Electron apps may ignore synthetic clicks.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Screen x coordinate of the click point (client x when window is set).' },
      y: { type: 'integer', required: true, description: 'Screen y coordinate of the click point (client y when window is set).' },
      button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Which click to perform; defaults to a single left click.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Posts the click to that window in the background (x, y are client coordinates, the same space as the windows_screenshot image of that window).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'mouse', mode: 'click', x: args.x, y: args.y, button: args.button ?? 'left' }
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_move',
    description: 'Move the mouse pointer to the given screen coordinates without pressing any button.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Target screen x coordinate.' },
      y: { type: 'integer', required: true, description: 'Target screen y coordinate.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return callHost({ cmd: 'mouse', mode: 'move', x: args.x, y: args.y }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_drag',
    description: 'Drag with the left mouse button held: press at (fromX, fromY), move, and release at (x, y).',
    parameters: {
      fromX: { type: 'integer', required: true, description: 'Drag start screen x coordinate.' },
      fromY: { type: 'integer', required: true, description: 'Drag start screen y coordinate.' },
      x: { type: 'integer', required: true, description: 'Drag end screen x coordinate.' },
      y: { type: 'integer', required: true, description: 'Drag end screen y coordinate.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return callHost({ cmd: 'mouse', mode: 'drag', fromX: args.fromX, fromY: args.fromY, x: args.x, y: args.y }, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_scroll',
    description: 'Scroll the mouse wheel vertically by `amount` wheel clicks (positive scrolls up, negative scrolls down) and report the UI element under the pointer, so you can confirm the scroll target. With `window` the scroll is posted to that window in the background (no cursor movement).',
    parameters: {
      amount: { type: 'integer', required: true, description: 'Number of wheel clicks; negative values scroll down.' },
      x: { type: 'integer', description: 'Optional screen x coordinate to move the pointer to before scrolling.' },
      y: { type: 'integer', description: 'Optional screen y coordinate to move the pointer to before scrolling.' },
      window: { type: 'string', description: 'Optional window title substring, process name, or PID; posts the scroll to that window in the background.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.amount === 0) throw new Error('scroll amount must not be zero')
      const request: Record<string, unknown> = { cmd: 'mouse', mode: 'scroll', amount: args.amount }
      if (args.x !== undefined && args.y !== undefined) {
        request.x = args.x
        request.y = args.y
      }
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_type',
    description: "Type text into the focused control with exact Unicode input (spaces, punctuation, CJK and symbols are preserved). After typing, the focused control is read back and the call fails if the text did not land. Mode 'keys' (default) synthesizes per-character Unicode input; mode 'paste' uses the clipboard for bulk text. Set `clear` to select all (Ctrl+A) first; set `activate` to bring a window forward atomically before typing. With `window`, the text is posted to that window in the background (no focus change, result not verified, `clear` is ignored) — best-effort: ASCII is reliable; CJK is reliable for classic Win32 and Qt apps including WeChat 4.x (byte encoding handled automatically) but may be garbled or dropped by modern WinUI/UWP apps, so prefer foreground mode with `activate` there.",
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type into the focused control.' },
      clear: { type: 'boolean', description: 'Select all existing content (Ctrl+A) before typing; defaults to false.' },
      mode: { type: 'string', enum: ['keys', 'paste'], description: "Input method; defaults to 'keys' (exact per-character Unicode input). 'paste' is faster for large text." },
      activate: { type: 'string', description: 'Optional window title substring, process name, or PID to activate first, in the same call.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Posts the text to that window in the background instead of the focused control.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.text.length === 0) throw new Error('text must not be empty')
      const request: Record<string, unknown> = { cmd: 'type', text: args.text, clear: args.clear === true, mode: args.mode ?? 'keys' }
      if (args.activate !== undefined) request.activate = args.activate
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_shortcut',
    description: "Press a keyboard shortcut, for example 'ctrl+s', 'alt+tab', 'ctrl+shift+esc', or a single key like 'win', 'enter', 'esc'. Set `activate` to bring a window forward first, in the same call, so the shortcut cannot land in another window. With `window`, the key messages are posted to that window in the background (no focus change) — best-effort: classic Win32 apps accept them, Chromium/Electron apps may ignore some. Supported names: ctrl, alt, shift, win, a-z, 0-9, f1-f12, enter, tab, esc, space, backspace, delete, insert, up, down, left, right, home, end, pageup, pagedown, minus, equal, comma, period, slash.",
    parameters: {
      keys: { type: 'string', required: true, description: "Keys joined with '+', pressed in order and released in reverse, e.g. 'ctrl+alt+delete'." },
      activate: { type: 'string', description: 'Optional window title substring, process name, or PID to activate first, in the same call.' },
      window: { type: 'string', description: 'Optional window title substring, process name, or PID; posts the keys to that window in the background instead of the focused window.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'keys', keys: args.keys }
      if (args.activate !== undefined) request.activate = args.activate
      if (args.window !== undefined) request.window = args.window
      return callHost(request, 20000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_app',
    description: 'Launch an application, document, or URL (action launch, ShellExecute semantics, optional args; reports the new window title when one appears), or bring an existing window to the foreground (action activate; target is a window title substring, process name, or PID; minimized windows are restored).',
    parameters: {
      action: { type: 'string', enum: ['launch', 'activate'], required: true, description: 'launch starts something new; activate focuses an existing window.' },
      target: { type: 'string', required: true, description: 'Executable path, document, or URL for launch; window title substring, process name, or PID for activate.' },
      args: { type: 'string', description: 'Optional command line arguments for launch.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'activate') return callHost({ cmd: 'activate', target: args.target }, 15000)
      const request: Record<string, unknown> = { cmd: 'launch', target: args.target }
      if (args.args !== undefined) request.args = args.args
      return callHost(request, 15000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_clipboard',
    description: 'Read or replace the Windows clipboard text.',
    parameters: {
      action: { type: 'string', enum: ['get', 'set'], required: true, description: 'get returns the current clipboard text; set replaces it.' },
      text: { type: 'string', description: 'The text to place on the clipboard when action is set.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'set') {
        if (args.text === undefined) throw new Error('clipboard set requires text')
        return callHost({ cmd: 'clipboard', action: 'set', text: args.text }, 15000)
      }
      const text = await callHost({ cmd: 'clipboard', action: 'get' }, 15000)
      return text.length === 0 ? '(clipboard is empty)' : text
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_wait',
    description: 'Wait for a number of seconds (0.1-30) so the desktop can settle after an action, instead of polling in a tight loop.',
    parameters: {
      seconds: { type: 'number', required: true, description: 'Seconds to wait; between 0.1 and 30.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!(args.seconds >= 0.1 && args.seconds <= 30)) throw new Error('seconds must be between 0.1 and 30')
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.round(args.seconds * 1000))
        exec.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolveWait()
        }, { once: true })
      })
      return `waited ${String(args.seconds)} seconds`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_wait_for',
    description: 'Wait until a desktop condition becomes true instead of sleeping blindly, then return; it fails with a timeout error when the condition never appears. Conditions: foreground (the foreground window title contains `value`), window (any visible window title contains `value`), pixel (the screen pixel at x, y changes from its color at call time), region (the average pixel difference inside x, y, width, height exceeds `threshold`, default 20; works for web-style UI that never changes window titles), settle (the region — or the whole screen when omitted — stays unchanged for `stableFrames` consecutive frames, default 3; use after any action to wait for rendering to finish).',
    parameters: {
      kind: { type: 'string', enum: ['foreground', 'window', 'pixel', 'region', 'settle'], required: true, description: 'Condition to wait for.' },
      value: { type: 'string', description: 'Title substring for foreground/window conditions; unused otherwise.' },
      x: { type: 'integer', description: 'Screen x coordinate: the pixel for kind pixel, or the region left edge for kind region/settle.' },
      y: { type: 'integer', description: 'Screen y coordinate: the pixel for kind pixel, or the region top edge for kind region/settle.' },
      width: { type: 'integer', description: 'Region width for kind region/settle; omit to watch the whole screen.' },
      height: { type: 'integer', description: 'Region height for kind region/settle; omit to watch the whole screen.' },
      threshold: { type: 'number', description: 'Average pixel-difference threshold for kind region; defaults to 20.' },
      stableFrames: { type: 'number', description: 'Consecutive unchanged frames required by kind settle; defaults to 3.' },
      timeoutSeconds: { type: 'number', description: 'Maximum wait in seconds; defaults to 10, capped at 60.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 65000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.kind === 'pixel' && (args.x === undefined || args.y === undefined)) {
        throw new Error('pixel condition requires x and y')
      }
      const request: Record<string, unknown> = { cmd: 'waitfor', kind: args.kind }
      if (args.value !== undefined) request.value = args.value
      if (args.x !== undefined) request.x = args.x
      if (args.y !== undefined) request.y = args.y
      if (args.width !== undefined) request.width = args.width
      if (args.height !== undefined) request.height = args.height
      if (args.threshold !== undefined) request.threshold = args.threshold
      if (args.stableFrames !== undefined) request.stableFrames = args.stableFrames
      if (args.timeoutSeconds !== undefined) request.timeoutSeconds = args.timeoutSeconds
      return callHost(request, 65000)
    },
  }))
}
