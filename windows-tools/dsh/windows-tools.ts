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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] public static extern IntPtr SendMessageText(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);

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
  $topmost = ''
  try {
    $windowHandle = [IntPtr]$c.NativeWindowHandle
    if ($windowHandle -ne [IntPtr]::Zero) {
      if ([WtNative]::IsIconic($windowHandle)) { $state = ' state=minimized' }
      elseif ([WtNative]::IsZoomed($windowHandle)) { $state = ' state=maximized' }
      else { $state = ' state=normal' }
      # Independent ground truth for winop topmost: WS_EX_TOPMOST.
      if (([WtNative]::GetWindowLong($windowHandle, -20) -band 0x00000008) -ne 0) { $topmost = ' topmost' }
    }
  } catch { }
  return ('[{0}] "{1}" pid={2} process={3}{4} @({5},{6} {7}x{8}){9}' -f $marker, $c.Name, $c.ProcessId, $processName, $state, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $topmost)
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

# Strict opt-in flag: only boolean true or the string "true" enable a
# destructive option, so a "false" string (or 1 / "yes") can never overwrite.
function Test-WtExplicitTrue($value) {
  if ($null -eq $value) { return $false }
  if ($value -is [bool]) { return [bool]$value }
  return ([string]$value).Trim().ToLowerInvariant() -eq 'true'
}

# Foreground mouse paths act on the real desktop, so the point must be inside
# the virtual screen before any native call is made.
function Assert-WtPointInVirtualScreen([int]$x, [int]$y) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($x -lt $vs.Left -or $x -ge ($vs.Left + $vs.Width) -or $y -lt $vs.Top -or $y -ge ($vs.Top + $vs.Height)) {
    throw ('point {0},{1} is outside the virtual desktop ({2},{3} {4}x{5})' -f $x, $y, $vs.Left, $vs.Top, $vs.Width, $vs.Height)
  }
}

# Region arguments are all-or-nothing: a partial set must fail loudly instead of
# silently falling back to the full image or to a (0,0) origin. Screenshot
# regions are 0-based pixels of the captured image; wait_for regions are
# virtual-desktop pixels whose origin can be negative on a multi-monitor layout,
# so those are checked against the virtual screen instead.
function Assert-WtRegionArgs($req, [switch]$ScreenRelative) {
  $given = @()
  foreach ($name in @('x', 'y', 'width', 'height')) { if ($null -ne $req.$name) { $given += $name } }
  if ($given.Count -eq 0) { return $false }
  if ($given.Count -ne 4) {
    throw ('region needs all of x, y, width and height (got only: {0}); pass all four or none' -f ($given -join ', '))
  }
  $rx = [int]$req.x
  $ry = [int]$req.y
  $rw = [int]$req.width
  $rh = [int]$req.height
  if ($rw -le 0 -or $rh -le 0) { throw ('region width and height must be positive (got {0}x{1})' -f $rw, $rh) }
  if ($ScreenRelative) { Assert-WtPointInVirtualScreen $rx $ry }
  elseif ($rx -lt 0 -or $ry -lt 0) { throw ('region x and y must not be negative: screenshot regions are 0-based pixels of the captured image (got {0},{1})' -f $rx, $ry) }
  return $true
}

# Retention for screenshots this plugin named itself. The client sets prune only
# when it generated the default path, so a caller-supplied path is never pruned;
# within the directory only files matching our own auto-generated name are
# candidates. Deleting must never fail the tool call, so failures are counted
# and reported instead of raised.
function Invoke-WtScreenshotPrune([string]$path, $req) {
  $keep = 20
  if ($null -ne $req.pruneKeep) { $keep = [int]$req.pruneKeep }
  if ($keep -lt 1) { $keep = 1 }
  if ($keep -gt 500) { $keep = 500 }
  $dir = Split-Path -Parent $path
  if ([string]::IsNullOrWhiteSpace($dir)) { return '|pruned=0' }
  $matched = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($file in [System.IO.Directory]::GetFiles($dir, 'screenshot-*')) {
      if ([System.IO.Path]::GetFileName($file) -match '(?i)^screenshot-.*\.png$') { [void]$matched.Add($file) }
    }
  } catch {
    return '|pruned=0'
  }
  if ($matched.Count -le $keep) { return '|pruned=0' }
  # Oldest first by write time, name as the tie-break so the order is defined.
  $sorted = @($matched | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime }, { $_ })
  $remove = $sorted.Count - $keep
  $deleted = 0
  $failures = 0
  for ($i = 0; $i -lt $remove; $i++) {
    try {
      Remove-Item -LiteralPath $sorted[$i] -Force -ErrorAction Stop
      $deleted++
    } catch {
      $failures++
    }
  }
  if ($failures -gt 0) { return ('|pruned={0} ({1} failures)' -f $deleted, $failures) }
  return ('|pruned={0}' -f $deleted)
}

function Save-WtScreenshot($req) {
  $path = [string]$req.path
  if ([string]::IsNullOrWhiteSpace($path)) {
    $shotDir = Join-Path $env:TEMP 'opencode-windows-tools'
    if (-not (Test-Path $shotDir)) { New-Item -ItemType Directory -Path $shotDir -Force | Out-Null }
    $path = Join-Path $shotDir ('screenshot-{0}.png' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  }
  # Refuse to replace an existing file unless the caller asked for it, and never
  # write anything but a .png (an existing file is left untouched on refusal).
  if ([System.IO.Path]::GetExtension($path) -ne '.png') {
    throw ('screenshot path must end with .png (got: {0})' -f $path)
  }
  if ((Test-Path -LiteralPath $path) -and -not (Test-WtExplicitTrue $req.overwrite)) {
    throw ('screenshot target already exists: {0}; pass overwrite=true to replace it' -f $path)
  }
  $hasRegion = Assert-WtRegionArgs $req
  $source = Get-WtScreenshotSource $req
  $owned = New-Object System.Collections.Generic.List[object]
  try {
    $bitmap = $source.bitmap
    [void]$owned.Add($bitmap)
    $clipNote = ''
    if ($hasRegion) {
      $regionX = [int]$req.x
      $regionY = [int]$req.y
      $regionW = [int]$req.width
      $regionH = [int]$req.height
      $right = [Math]::Min($regionX + $regionW, $bitmap.Width)
      $bottom = [Math]::Min($regionY + $regionH, $bitmap.Height)
      if ($right -le $regionX -or $bottom -le $regionY) {
        throw ('screenshot region {0},{1} {2}x{3} does not intersect the captured image ({4}x{5})' -f $regionX, $regionY, $regionW, $regionH, $bitmap.Width, $bitmap.Height)
      }
      if (($right - $regionX) -ne $regionW -or ($bottom - $regionY) -ne $regionH) {
        $clipNote = '|clipped:{0},{1} {2}x{3}' -f $regionX, $regionY, ($right - $regionX), ($bottom - $regionY)
      }
      $cropped = $bitmap.Clone((New-Object System.Drawing.Rectangle $regionX, $regionY, ($right - $regionX), ($bottom - $regionY)), $bitmap.PixelFormat)
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
    $pruneNote = ''
    if (Test-WtExplicitTrue $req.prune) { $pruneNote = Invoke-WtScreenshotPrune $path $req }
    return ('saved: {0}|width:{1}|height:{2}|scale:{3}|source:{4}{5}{6}' -f $path, $final.Width, $final.Height, $scale, $source.label, $clipNote, $pruneNote)
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
  Assert-WtPointInVirtualScreen $x $y
  if (-not [WtNative]::SetCursorPos($x, $y)) {
    throw ('SetCursorPos({0},{1}) failed: the point could not be reached (locked or disconnected session?)' -f $x, $y)
  }
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

function Send-WtBackgroundText($hwnd, [string]$text, [string]$procName, [string]$subject) {
  if ($procName -eq 'Weixin') {
    # WeChat's custom input stack decodes WM_CHAR as legacy ANSI bytes, not UTF-16.
    # Pin code page 936 explicitly: Encoding.Default is GBK only on a zh-CN host.
    $bytes = [System.Text.Encoding]::GetEncoding(936).GetBytes($text)
    foreach ($b in $bytes) {
      [void][WtNative]::PostMessage($hwnd, 0x0102, [IntPtr][int]$b, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 8
    }
    return ('posted {0} bytes (background, ANSI) to {1}' -f $bytes.Length, $subject)
  }
  foreach ($ch in $text.ToCharArray()) {
    $code = [int]$ch
    if ($code -eq 13) { continue }
    if ($code -eq 10) { $code = 13 }
    [void][WtNative]::PostMessage($hwnd, 0x0102, [IntPtr]$code, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 8
  }
  return ('posted {0} characters (background) to {1}' -f $text.Length, $subject)
}

function Invoke-WtBackgroundType($found, [string]$text) {
  return Send-WtBackgroundText (Get-WtBackgroundInputHandle $found) $text (Get-WtProcessName $found.ProcessId) ('window "{0}"' -f $found.Title)
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

# Element click. The default leg is a posted click at the centre of the element
# rect: no cursor movement and no focus change, which is what the window-target
# click already promises. The UIA InvokePattern leg is opt-in because a provider
# may activate its window while invoking (measured on WPF: Invoke() brings the
# window to the front, and WS_EX_NOACTIVATE on the target does not prevent it).
function Invoke-WtElementClick($found, $el, [string]$button, [bool]$allowForeground) {
  $label = Get-WtElementLabel $el
  if ($allowForeground -and $button -eq 'left') {
    $invokePattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
      $invokePattern.Invoke()
      Start-Sleep -Milliseconds 120
      return @{ message = ('clicked left via UIA InvokePattern on {0} (the target window may have been brought to the foreground)' -f $label); strategy = 'uia-invoke-pattern' }
    }
  }
  $rect = $el.Current.BoundingRectangle
  if ($rect.IsEmpty) { throw ('the element {0} has an empty rectangle; cannot post a click' -f $label) }
  $centerX = [int]($rect.X + $rect.Width / 2)
  $centerY = [int]($rect.Y + $rect.Height / 2)
  $origin = New-Object WtNative+POINT
  $origin.X = 0
  $origin.Y = 0
  [void][WtNative]::ClientToScreen($found.Handle, [ref]$origin)
  $clientX = $centerX - $origin.X
  $clientY = $centerY - $origin.Y
  $cr = New-Object WtNative+RECT
  [void][WtNative]::GetClientRect($found.Handle, [ref]$cr)
  $clientW = $cr.Right - $cr.Left
  $clientH = $cr.Bottom - $cr.Top
  if ($clientX -lt 0 -or $clientY -lt 0 -or $clientX -ge $clientW -or $clientY -ge $clientH) {
    throw ('the element {0} centre {1},{2} is outside the client area of window "{3}" ({4}x{5}); not posting a click' -f $label, $centerX, $centerY, $found.Title, $clientW, $clientH)
  }
  $hit = Get-WtHitDescription $centerX $centerY
  $posted = Invoke-WtBackgroundClick $found $clientX $clientY $button
  return @{ message = ('{0}; element {1} centre {2},{3} -> client {4},{5}; point hit: {6}' -f $posted, $label, $centerX, $centerY, $clientX, $clientY, $hit); strategy = 'background-post' }
}

function Invoke-WtMouse($req) {
  if ($null -ne $req.element) {
    $mode = [string]$req.mode
    if ($mode -ne 'click') { throw ('an element selector is only supported for click (got mode: ' + $mode + ')') }
    $button = 'left'
    if ($req.button) { $button = [string]$req.button }
    $root = Get-WtElementRoot ([string]$req.window)
    $element = Resolve-WtElement $root.element $req.element
    $result = Invoke-WtElementClick $root.window $element $button (Test-WtExplicitTrue $req.allowForeground)
    # A click can confirm that the message or the pattern call was delivered, but
    # not that the application reacted, so verified stays false by definition.
    return ('{0} [strategy={1}] [verified=false]' -f $result.message, $result.strategy)
  }
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
      Assert-WtPointInVirtualScreen $tx $ty
      Move-WtTo $fx $fy
      [WtNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      for ($i = 1; $i -le 12; $i++) {
        $stepX = [int]($fx + ($tx - $fx) * $i / 12)
        $stepY = [int]($fy + ($ty - $fy) * $i / 12)
        if (-not [WtNative]::SetCursorPos($stepX, $stepY)) {
          [WtNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
          throw ('SetCursorPos({0},{1}) failed during the drag; the left button was released' -f $stepX, $stepY)
        }
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

# ---- element selectors (find / read / click / type / wait_for) --------------
# A selector is {index?, name?, type?, automationId?, className?}. Every given
# field is a case-insensitive substring test and all of them must match.
# Candidates are the descendants of the target window in UI Automation tree
# order, skipping offscreen elements and empty rectangles so that every reported
# rect is usable for a click.
function Test-WtSelectorField([string]$value, [string]$pattern) {
  if ([string]::IsNullOrWhiteSpace($pattern)) { return $true }
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  return ($value.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Test-WtSelectorEmpty($selector) {
  if ($null -eq $selector) { return $true }
  foreach ($field in @('name', 'type', 'automationId', 'className')) {
    if (-not [string]::IsNullOrWhiteSpace([string]$selector.$field)) { return $false }
  }
  return $true
}

function Format-WtSelectorDescription($selector) {
  $parts = New-Object System.Collections.Generic.List[string]
  if ($null -ne $selector.index) { $parts.Add(('index={0}' -f $selector.index)) }
  foreach ($field in @('name', 'type', 'automationId', 'className')) {
    $value = [string]$selector.$field
    if (-not [string]::IsNullOrWhiteSpace($value)) { $parts.Add(('{0}~"{1}"' -f $field, $value)) }
  }
  return ('element selector [' + ($parts -join ', ') + ']')
}

function Get-WtElementMatchList($rootEl, $selector, [int]$limit) {
  $matches = New-Object System.Collections.Generic.List[object]
  if ($null -eq $rootEl -or $limit -lt 1) { return $matches }
  $nameFilter = ''
  $typeFilter = ''
  $idFilter = ''
  $classFilter = ''
  if ($null -ne $selector) {
    $nameFilter = [string]$selector.name
    # The vocabulary is the short programmatic name (Button, Edit, ...); tolerate
    # a caller that passes the full "ControlType.Edit" spelling.
    $typeFilter = ([string]$selector.type) -replace '^ControlType\.', ''
    $idFilter = [string]$selector.automationId
    $classFilter = [string]$selector.className
  }
  $all = $null
  try { $all = $rootEl.FindAll($script:TS::Descendants, $script:ANY) } catch { return $matches }
  foreach ($el in $all) {
    if ($matches.Count -ge $limit) { break }
    try {
      $c = $el.Current
      if ($c.IsOffscreen) { continue }
      $rect = $c.BoundingRectangle
      if ($rect.IsEmpty) { continue }
      $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if (-not (Test-WtSelectorField $type $typeFilter)) { continue }
      if (-not (Test-WtSelectorField ([string]$c.Name) $nameFilter)) { continue }
      if (-not (Test-WtSelectorField ([string]$c.AutomationId) $idFilter)) { continue }
      if (-not (Test-WtSelectorField ([string]$c.ClassName) $classFilter)) { continue }
      [void]$matches.Add($el)
    } catch { }
  }
  return $matches
}

function Format-WtElementMatch($el, [int]$index) {
  $c = $el.Current
  $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  $name = [string]$c.Name
  if ($name.Length -gt 200) { $name = $name.Substring(0, 200) + '...' }
  $id = '-'
  if (-not [string]::IsNullOrEmpty($c.AutomationId)) { $id = $c.AutomationId }
  $rect = $c.BoundingRectangle
  $enabled = 'false'
  if ($c.IsEnabled) { $enabled = 'true' }
  return ('[{0}] {1} | {2} | automationId={3} | rect={4},{5},{6},{7} | enabled={8}' -f $index, $name, $type, $id, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height, $enabled)
}

function Get-WtElementLabel($el) {
  try {
    $c = $el.Current
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $name = [string]$c.Name
    if ($name.Length -gt 60) { $name = $name.Substring(0, 60) + '...' }
    $id = ''
    if (-not [string]::IsNullOrEmpty($c.AutomationId)) { $id = ' automationId=' + $c.AutomationId }
    return ('{0} "{1}"{2}' -f $type, $name, $id)
  } catch {
    return 'element (unreadable)'
  }
}

function Get-WtElementRoot([string]$target) {
  if ([string]::IsNullOrWhiteSpace($target)) {
    throw 'this command needs a target window (title substring, process name, or PID) to search elements in'
  }
  $found = Resolve-WtWindow $target
  if ($null -eq $found) { throw (Format-WtNoWindowError $target) }
  $element = $null
  try { $element = $script:AE::FromHandle($found.Handle) } catch { $element = $null }
  if ($null -eq $element) { throw ('window "{0}" exposes no UI Automation element' -f $found.Title) }
  return @{ window = $found; element = $element }
}

function Resolve-WtElement($rootEl, $selector) {
  # An index alone is ambiguous: the caller must name what to look for, so the
  # index always counts matches of the same selector that find() printed.
  if (Test-WtSelectorEmpty $selector) {
    throw 'element selector needs at least one of: name, type, automationId, className (index alone is ambiguous)'
  }
  $description = Format-WtSelectorDescription $selector
  $wanted = -1
  if ($null -ne $selector.index) { $wanted = [int]$selector.index }
  if ($wanted -lt 0) {
    $matches = Get-WtElementMatchList $rootEl $selector 1
    if ($matches.Count -eq 0) { throw ('no element matched ' + $description) }
    return $matches[0]
  }
  $matches = Get-WtElementMatchList $rootEl $selector ($wanted + 1)
  if ($matches.Count -le $wanted) {
    throw ('element index {0} is out of range: {1} matched {2} element(s)' -f $wanted, $description, $matches.Count)
  }
  return $matches[$wanted]
}

function Read-WtElementText($el) {
  $c = $el.Current
  $valuePattern = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    $value = [string]$valuePattern.Current.Value
    if ($value.Length -gt 4000) { $value = $value.Substring(0, 4000) + '... (truncated)' }
    return $value
  }
  $textPattern = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
    $text = [string]$textPattern.DocumentRange.GetText(4000)
    if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) + '... (truncated)' }
    return $text
  }
  $name = [string]$c.Name
  if (-not [string]::IsNullOrWhiteSpace($name)) { return $name }
  return '(element exposes no readable text)'
}

function Invoke-WtFind($req) {
  $root = Get-WtElementRoot ([string]$req.target)
  $limit = 20
  if ($null -ne $req.limit) { $limit = [int]$req.limit }
  if ($limit -lt 1) { $limit = 1 }
  if ($limit -gt 200) { $limit = 200 }
  # Enumerate once with a ceiling far above any usable limit so the truncation
  # notice can report the real match count instead of claiming a partial list.
  $matches = Get-WtElementMatchList $root.element $req 1000
  if ($matches.Count -eq 0) { return 'no element matched' }
  $shown = $matches.Count
  if ($shown -gt $limit) { $shown = $limit }
  $lines = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $shown; $i++) {
    $lines.Add((Format-WtElementMatch $matches[$i] $i))
  }
  if ($matches.Count -gt $shown) {
    $lines.Add(('truncated: showing {0} of {1} matches (raise limit, max 200)' -f $shown, $matches.Count))
  }
  return ($lines -join $script:NEWLINE)
}

function Invoke-WtRead($req) {
  # Any element field routes here, including an unusable one: a selector that
  # only carries an index must fail loudly instead of silently reading the whole
  # window.
  if ($null -ne $req.element) {
    $root = Get-WtElementRoot ([string]$req.target)
    $element = Resolve-WtElement $root.element $req.element
    return Read-WtElementText $element
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$req.target)) { return Read-WtWindowText ([string]$req.target) }
  return Read-WtFocusedText
}

# ---- window operations (winop) and process enumeration (procs) --------------
function Get-WtWindowMetrics($hwnd) {
  $rect = New-Object WtNative+RECT
  [void][WtNative]::GetWindowRect($hwnd, [ref]$rect)
  $state = 'normal'
  if ([WtNative]::IsIconic($hwnd)) { $state = 'minimized' }
  elseif ([WtNative]::IsZoomed($hwnd)) { $state = 'maximized' }
  $visible = 'false'
  if ([WtNative]::IsWindowVisible($hwnd)) { $visible = 'true' }
  $topmost = 'false'
  if (([WtNative]::GetWindowLong($hwnd, -20) -band 0x00000008) -ne 0) { $topmost = 'true' }
  return @{
    x = [int]$rect.Left
    y = [int]$rect.Top
    w = [int]($rect.Right - $rect.Left)
    h = [int]($rect.Bottom - $rect.Top)
    state = $state
    visible = $visible
    topmost = $topmost
  }
}

function Format-WtWindowMetrics($metrics) {
  return ('rect={0},{1},{2},{3} state={4} visible={5} topmost={6}' -f $metrics.x, $metrics.y, $metrics.w, $metrics.h, $metrics.state, $metrics.visible, $metrics.topmost)
}

# Every action is measured after the fact and reported only if the measurement
# agrees with the request. There is no focus action on purpose: activation is
# windows_app's job, and an activation that cannot be verified from a background
# host would be a capability nobody can test.
function Invoke-WtWinOp($req) {
  $target = [string]$req.target
  if ([string]::IsNullOrWhiteSpace($target)) { throw 'winop needs a target window (title substring, process name, or PID)' }
  $found = Resolve-WtWindow $target
  if ($null -eq $found) { throw (Format-WtNoWindowError $target) }
  $hwnd = $found.Handle
  $action = ([string]$req.action).ToLowerInvariant()
  $requested = ''
  # SWP_NOSIZE 0x1, SWP_NOMOVE 0x2, SWP_NOZORDER 0x4, SWP_NOACTIVATE 0x10
  switch ($action) {
    'move' {
      if ($null -eq $req.x -or $null -eq $req.y) { throw 'winop move needs x and y' }
      $x = [int]$req.x
      $y = [int]$req.y
      $requested = ('requested={0},{1} ' -f $x, $y)
      if (-not [WtNative]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, 0, 0, 0x0015)) {
        throw ('SetWindowPos(move to {0},{1}) was refused for window "{2}"' -f $x, $y, $found.Title)
      }
    }
    'resize' {
      if ($null -eq $req.width -or $null -eq $req.height) { throw 'winop resize needs width and height' }
      $w = [int]$req.width
      $h = [int]$req.height
      if ($w -le 0 -or $h -le 0) { throw ('winop resize needs positive width and height (got {0}x{1})' -f $w, $h) }
      $flags = 0x0016
      $x = 0
      $y = 0
      if ($null -ne $req.x -and $null -ne $req.y) {
        $x = [int]$req.x
        $y = [int]$req.y
        $flags = 0x0014
        $requested = ('requested={0},{1},{2},{3} ' -f $x, $y, $w, $h)
      } else {
        $requested = ('requested={0},{1} ' -f $w, $h)
      }
      if (-not [WtNative]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, $flags)) {
        throw ('SetWindowPos(resize to {0}x{1}) was refused for window "{2}"' -f $w, $h, $found.Title)
      }
    }
    'minimize' { [void][WtNative]::ShowWindow($hwnd, 6) }
    'maximize' { [void][WtNative]::ShowWindow($hwnd, 3) }
    'restore' { [void][WtNative]::ShowWindow($hwnd, 9) }
    'close' { [void][WtNative]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    'topmost' {
      $on = $true
      if ($null -ne $req.on) { $on = Test-WtExplicitTrue $req.on }
      $insertAfter = [IntPtr]::new(-2)
      if ($on) { $insertAfter = [IntPtr]::new(-1) }
      $requested = ('requested=on:{0} ' -f $on)
      if (-not [WtNative]::SetWindowPos($hwnd, $insertAfter, 0, 0, 0, 0, 0x0013)) {
        throw ('SetWindowPos(topmost {0}) was refused for window "{1}"' -f $on, $found.Title)
      }
    }
    default {
      throw ('unknown winop action: ' + [string]$req.action + ' (expected move, resize, minimize, maximize, restore, close or topmost)')
    }
  }
  if ($action -eq 'close') {
    $deadline = (Get-Date).AddMilliseconds(1500)
    while ((Get-Date) -lt $deadline) {
      if (-not [WtNative]::IsWindow($hwnd)) { break }
      Start-Sleep -Milliseconds 100
    }
    if ([WtNative]::IsWindow($hwnd)) {
      throw ('window "{0}" did not close within 1500 ms (it may be showing a confirmation dialog)' -f $found.Title)
    }
    return ('winop close: "{0}" handle={1} closed=true' -f $found.Title, $hwnd.ToInt64())
  }
  Start-Sleep -Milliseconds 200
  $metrics = Get-WtWindowMetrics $hwnd
  $verified = $false
  # A DPI-scaled window can round a requested coordinate or size by a pixel or
  # two, so move/resize accept a 2 px slack; the reply still reports the measured
  # rectangle, and anything farther off keeps failing (4 px and up is a failure).
  $tolerance = 2
  if ($action -eq 'move') {
    if ([Math]::Abs($metrics.x - [int]$req.x) -le $tolerance -and [Math]::Abs($metrics.y - [int]$req.y) -le $tolerance) { $verified = $true }
  }
  elseif ($action -eq 'resize') {
    if ([Math]::Abs($metrics.w - [int]$req.width) -le $tolerance -and [Math]::Abs($metrics.h - [int]$req.height) -le $tolerance) { $verified = $true }
  }
  elseif ($action -eq 'minimize') { if ($metrics.state -eq 'minimized') { $verified = $true } }
  elseif ($action -eq 'maximize') { if ($metrics.state -eq 'maximized') { $verified = $true } }
  elseif ($action -eq 'restore') { if ($metrics.state -eq 'normal') { $verified = $true } }
  elseif ($action -eq 'topmost') {
    $wanted = 'true'
    if ($null -ne $req.on -and -not (Test-WtExplicitTrue $req.on)) { $wanted = 'false' }
    if ($metrics.topmost -eq $wanted) { $verified = $true }
  }
  if (-not $verified) {
    throw ('winop {0} did not take effect on window "{1}": {2} (an operation is reported as successful only when the measurement after it agrees)' -f $action, $found.Title, (Format-WtWindowMetrics $metrics))
  }
  return ('winop {0}: "{1}" handle={2} {3}{4} verified=true' -f $action, $found.Title, $hwnd.ToInt64(), $requested, (Format-WtWindowMetrics $metrics))
}

# Read-only enumeration: one line per top-level window. By default only visible
# windows with a title are listed (the same predicate as the status window list),
# so a process's hidden helper windows cannot push its real window out of a small
# limit; includeHidden adds those hidden windows back, and only then can a line
# carry visible=false.
function Invoke-WtProcs($req) {
  $filter = ''
  if ($null -ne $req.name) { $filter = ([string]$req.name).Trim() }
  if ($filter.ToLowerInvariant().EndsWith('.exe')) { $filter = $filter.Substring(0, $filter.Length - 4) }
  $limit = 50
  if ($null -ne $req.limit) { $limit = [int]$req.limit }
  if ($limit -lt 1) { $limit = 1 }
  if ($limit -gt 200) { $limit = 200 }
  $includeHidden = Test-WtExplicitTrue $req.includeHidden
  $lines = New-Object System.Collections.Generic.List[string]
  $windows = [WtNative]::ListTopLevelWindows()
  $visiblePids = @{}
  foreach ($w in $windows) {
    if ($w.Visible) { $visiblePids[$w.ProcessId] = $true }
  }
  # Visible windows first: a process with several hidden helper windows would
  # otherwise push its real window out of a small limit.
  foreach ($w in ($windows | Sort-Object @{ Expression = { $_.Visible }; Descending = $true }, ProcessId, Title)) {
    if (-not $visiblePids.ContainsKey($w.ProcessId)) { continue }
    if (-not $includeHidden -and (-not $w.Visible -or [string]::IsNullOrWhiteSpace($w.Title))) { continue }
    $processName = Get-WtProcessName $w.ProcessId
    if ($filter -ne '') {
      $match = $false
      if ($filter -match '^[0-9]+$') { if ($w.ProcessId -eq [int]$filter) { $match = $true } }
      elseif ($processName -like ('*' + $filter + '*')) { $match = $true }
      if (-not $match) { continue }
    }
    if ($lines.Count -ge $limit) { break }
    $visible = 'false'
    if ($w.Visible) { $visible = 'true' }
    $lines.Add(('{0} {1} | {2} | visible={3}' -f $w.ProcessId, $processName, $w.Title, $visible))
  }
  if ($lines.Count -eq 0) { return 'no process matched' }
  return ($lines -join $script:NEWLINE)
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

function Test-WtClearRequested($value) {
  $text = [string]$value
  return ($text -eq 'True' -or $text -eq '1' -or $text -eq 'true')
}

# Watch for a window gaining the foreground during a write. A provider's
# activation can be brief, so the caller samples repeatedly while it waits; one
# sample at a fixed offset both misses short activations and invents none.
function New-WtActivationWatch($hwnd) {
  $handle = [IntPtr]$hwnd
  return @{ handle = $handle.ToInt64(); wasForeground = ([WtNative]::GetForegroundWindow() -eq $handle); seen = $false }
}

function Update-WtActivationWatch($watch) {
  if ($null -eq $watch) { return }
  if ($watch.wasForeground -or $watch.seen) { return }
  if ([WtNative]::GetForegroundWindow().ToInt64() -eq $watch.handle) { $watch.seen = $true }
}

# Sleeps while sampling the watch, so the wait the write already needs doubles as
# the observation window and no extra latency is added when nothing happens.
function Wait-WtSettle($watch, [int]$milliseconds) {
  $steps = [Math]::Max(1, [int]($milliseconds / 10))
  for ($step = 0; $step -lt $steps; $step++) {
    Start-Sleep -Milliseconds 10
    Update-WtActivationWatch $watch
  }
}

function Get-WtTypeVerification([string]$text, [string]$mode) {
  $observed = Get-WtFocusedText
  if ($null -eq $observed) { return @{ note = ' (not verified: the focused control exposes no readable text)'; verified = 'false' } }
  $normalizedObserved = $observed.Replace([string][char]13, '')
  $normalizedTyped = $text.Replace([string][char]13, '')
  if ($normalizedObserved.Length -ge 3990) {
    return @{ note = ' (not verified: the focused text is too long to compare)'; verified = 'false' }
  }
  if ($normalizedObserved.IndexOf($normalizedTyped, [System.StringComparison]::Ordinal) -ge 0) {
    return @{ note = ' (verified: the focused control now contains the typed text)'; verified = 'true' }
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

# Element typing fallback chain in the frozen order: UIA ValuePattern, then
# WM_SETTEXT to the element's native handle, then the plain background key
# stream. The chain never touches the clipboard and never asks for the
# foreground; the leg that ran is reported as strategy and the read-back result
# as verified, so a caller can tell which path actually carried the text.
function Invoke-WtElementType($el, [string]$text, $found, $watch) {
  $label = Get-WtElementLabel $el
  $valuePattern = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    if (-not $valuePattern.Current.IsReadOnly) {
      $valuePattern.SetValue($text)
      Wait-WtSettle $watch 100
      $verified = 'false'
      try {
        if ((Read-WtElementText $el).IndexOf($text, [System.StringComparison]::Ordinal) -ge 0) { $verified = 'true' }
      } catch { }
      return @{ message = ('typed {0} characters into {1}' -f $text.Length, $label); strategy = 'uia-value-pattern'; verified = $verified }
    }
  }
  $handle = 0
  try { $handle = $el.Current.NativeWindowHandle } catch { $handle = 0 }
  if ($handle -ne 0) {
    # USER32 marshals WM_SETTEXT across processes, so SendMessage (not
    # PostMessage, which cannot carry the string pointer) is the correct call.
    [void][WtNative]::SendMessageText([IntPtr]$handle, 0x000C, [IntPtr]::Zero, $text)
    Wait-WtSettle $watch 100
    $verified = 'false'
    try {
      if ((Read-WtElementText $el).IndexOf($text, [System.StringComparison]::Ordinal) -ge 0) { $verified = 'true' }
    } catch { }
    return @{ message = ('typed {0} characters into {1} (WM_SETTEXT to hwnd {2})' -f $text.Length, $label, $handle); strategy = 'wm-settext'; verified = $verified }
  }
  $note = Send-WtBackgroundText (Get-WtBackgroundInputHandle $found) $text (Get-WtProcessName $found.ProcessId) $label
  $verified = 'false'
  try {
    if ((Read-WtElementText $el).IndexOf($text, [System.StringComparison]::Ordinal) -ge 0) { $verified = 'true' }
  } catch { }
  return @{ message = $note; strategy = 'keystream'; verified = $verified }
}

function Invoke-WtType($req) {
  $text = [string]$req.text
  $clearText = Test-WtClearRequested $req.clear
  if ($null -ne $req.element) {
    $root = Get-WtElementRoot ([string]$req.window)
    $element = Resolve-WtElement $root.element $req.element
    # Some UIA providers activate their own window while a write goes through
    # (measured on WPF with ValuePattern.SetValue). The host never requests the
    # foreground, so the only honest thing is to observe the transition and say
    # so in the reply; sampling happens while the write already waits, plus a
    # short sweep afterwards for an activation that lands late.
    $watch = New-WtActivationWatch $root.window.Handle
    $result = Invoke-WtElementType $element $text $root.window $watch
    $message = $result.message
    if ($result.strategy -eq 'keystream' -and $clearText) { $message = $message + ' (clear is ignored in the key stream path)' }
    # A provider may run the activation on its own dispatcher, so it can land up
    # to a few hundred milliseconds after the write; keep sampling for a bounded
    # window and report only what was actually observed.
    Wait-WtSettle $watch 250
    $activatedNote = ''
    if ($watch.seen) {
      $activatedNote = ' activated=true (the target application provider brought its own window to the foreground; the host never requests focus)'
    }
    return ('{0} [strategy={1}] [verified={2}]{3}' -f $message, $result.strategy, $result.verified, $activatedNote)
  }
  $target = Get-WtWindowTarget $req
  if ($null -ne $target) {
    $note = Invoke-WtBackgroundType $target $text
    if ($clearText) { $note = $note + ' (clear is ignored in background mode)' }
    return ($note + ' [strategy=keystream] [verified=false]')
  }
  if ($null -ne $req.activate -and [string]$req.activate -ne '') { [void](Invoke-WtActivate ([string]$req.activate)) }
  $focusNote = Repair-WtTypeFocus $req
  $mode = 'keys'
  if ($req.mode) { $mode = [string]$req.mode }
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
  $verification = Get-WtTypeVerification $text $mode
  return ('typed {0} characters ({1}){2}{3} [strategy=keystream] [verified={4}]' -f $text.Length, $mode, $verification.note, $focusNote, $verification.verified)
}

function Read-WtFocusedText {
  $text = Get-WtFocusedText
  if ($null -eq $text) { return '(focused control exposes no readable text)' }
  if ($text.Length -eq 0) { return '(the focused control is empty)' }
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
  # An empty title substring matches every window, so it would report success
  # after 0 ms instead of waiting for the intended window to appear.
  if (($kind -eq 'foreground' -or $kind -eq 'window') -and [string]::IsNullOrWhiteSpace($value)) {
    throw ('wait_for kind "{0}" needs a non-empty value (the title substring to wait for)' -f $kind)
  }
  $target = ''
  if ($null -ne $req.target) { $target = [string]$req.target }
  if ($kind -eq 'element') {
    if ([string]::IsNullOrWhiteSpace($target)) { throw 'wait_for kind "element" needs a non-empty target (the window to search in)' }
    if (Test-WtSelectorEmpty $req) { throw 'wait_for kind "element" needs at least one of: name, type, automationId, className' }
  }
  if ($kind -eq 'windowgone' -and [string]::IsNullOrWhiteSpace($target)) {
    throw 'wait_for kind "windowgone" needs a non-empty target (the window that should disappear)'
  }
  if ($kind -eq 'text') {
    if ([string]::IsNullOrWhiteSpace($target)) { throw 'wait_for kind "text" needs a non-empty target (the window whose text is read)' }
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'wait_for kind "text" needs a non-empty value (the substring to look for in the window text)' }
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $regionX = $vs.Left
  $regionY = $vs.Top
  $regionW = $vs.Width
  $regionH = $vs.Height
  if (($kind -eq 'region' -or $kind -eq 'settle') -and (Assert-WtRegionArgs $req -ScreenRelative)) {
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

  $hitLine = ''
  while ($true) {
    $met = $false
    if ($kind -eq 'foreground') {
      $fg = Get-WtForeground
      if ($fg.title.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $met = $true }
    } elseif ($kind -eq 'window') {
      foreach ($w in [WtNative]::ListTopLevelWindows()) {
        if ($w.Visible -and $w.Title.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $met = $true; break }
      }
    } elseif ($kind -eq 'element') {
      # The window may not exist yet: that is a wait, not an error.
      $rootInfo = $null
      try { $rootInfo = Get-WtElementRoot $target } catch { $rootInfo = $null }
      if ($null -ne $rootInfo) {
        $hits = Get-WtElementMatchList $rootInfo.element $req 1
        if ($hits.Count -gt 0) { $met = $true; $hitLine = (Format-WtElementMatch $hits[0] 0) }
      }
    } elseif ($kind -eq 'windowgone') {
      if ($null -eq (Resolve-WtWindow $target)) { $met = $true }
    } elseif ($kind -eq 'text') {
      try {
        $windowText = Read-WtWindowText $target
        $index = $windowText.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase)
        if ($index -ge 0) {
          $met = $true
          $contextStart = $index - 30
          if ($contextStart -lt 0) { $contextStart = 0 }
          $contextEnd = $index + $value.Length + 30
          if ($contextEnd -gt $windowText.Length) { $contextEnd = $windowText.Length }
          $hitLine = $windowText.Substring($contextStart, $contextEnd - $contextStart).Replace([string][char]10, ' ').Replace([string][char]13, ' ')
        }
      } catch { $met = $false }
    } else {
      throw ('unknown wait_for kind: ' + $kind)
    }
    if ($met) {
      if ($kind -eq 'element') { return ('condition met after {0} ms (element): {1}' -f $watch.ElapsedMilliseconds, $hitLine) }
      if ($kind -eq 'text') { return ('condition met after {0} ms (text): ...{1}...' -f $watch.ElapsedMilliseconds, $hitLine) }
      if ($kind -eq 'windowgone') { return ('condition met after {0} ms (windowgone): no window matches "{1}"' -f $watch.ElapsedMilliseconds, $target) }
      return ('condition met after {0} ms ({1})' -f $watch.ElapsedMilliseconds, $kind)
    }
    if ($watch.ElapsedMilliseconds -ge $timeoutMs) { break }
    Start-Sleep -Milliseconds 150
  }
  if ($kind -eq 'element') { throw ('windows_wait_for timed out after {0} ms: no element matched {1} in window "{2}"' -f $timeoutMs, (Format-WtSelectorDescription $req), $target) }
  if ($kind -eq 'windowgone') { throw ('windows_wait_for timed out after {0} ms: a window still matches "{1}"' -f $timeoutMs, $target) }
  if ($kind -eq 'text') { throw ('windows_wait_for timed out after {0} ms: text "{1}" did not appear in window "{2}"' -f $timeoutMs, $value, $target) }
  throw ('windows_wait_for timed out after {0} ms: no {1} matched "{2}"' -f $timeoutMs, $kind, $value)
}

function Invoke-WtCommand($req) {
  switch ([string]$req.cmd) {
    'status' { return Get-WtStatus }
    'snapshot' { return Get-WtSnapshot ([string]$req.target) }
    'screenshot' { return Save-WtScreenshot $req }
    'hit' { return Get-WtHitDescription ([int]$req.x) ([int]$req.y) }
    'mouse' { return Invoke-WtMouse $req }
    # Alias: a click is the mouse command with mode=click; accepting both spellings
    # keeps a direct client from guessing which one the protocol uses. The request
    # is copied instead of mutated: it is a parsed JSON object, whose properties
    # cannot be added in place.
    'click' {
      $clickRequest = @{}
      foreach ($property in $req.PSObject.Properties) { $clickRequest[$property.Name] = $property.Value }
      $clickRequest['mode'] = 'click'
      return Invoke-WtMouse $clickRequest
    }
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
    'find' { return Invoke-WtFind $req }
    'read' { return Invoke-WtRead $req }
    'winop' { return Invoke-WtWinOp $req }
    'procs' { return Invoke-WtProcs $req }
    'readtext' { return Read-WtFocusedText }
    'readwindow' { return Read-WtWindowText ([string]$req.target) }
    default { throw ('unknown command: ' + [string]$req.cmd) }
  }
}

[Console]::Out.WriteLine('{"ok":true,"ready":true}')
[Console]::Out.Flush()

# Requests are decoded as UTF-8 no matter what the console code page is. A client
# may send raw UTF-8 (e.g. a path under a user profile whose name is not ASCII) or
# the escaped pure-ASCII form the plugins use; both decode identically. The
# default [Console]::In decodes with the console code page and silently garbles
# raw UTF-8, which turns such a path into a failure against a directory that
# never existed.
$script:stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))

while ($true) {
  $line = $script:stdin.ReadLine()
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

/** Content-addressed path: two plugin versions never share one helper file. */
const HOST_SCRIPT_HASH = createHash('sha256').update(HOST_SCRIPT).digest('hex').slice(0, 16)

const HOST_DIR = join(tmpdir(), 'dsh-windows-tools')
const HOST_SCRIPT_PATH = join(HOST_DIR, `wt-host-${HOST_SCRIPT_HASH}.ps1`)

/**
 * Publish the helper with a write-to-staging-then-rename, so a concurrent
 * reader (another session starting at the same moment) can never observe a
 * half-written script.
 */
function materializeHostScript(): string {
  mkdirSync(HOST_DIR, { recursive: true })
  const staging = join(HOST_DIR, `wt-host-${HOST_SCRIPT_HASH}.${String(process.pid)}.tmp`)
  writeFileSync(staging, HOST_SCRIPT, 'utf8')
  try {
    renameSync(staging, HOST_SCRIPT_PATH)
  } catch (error) {
    rmSync(staging, { force: true })
    // The path encodes the content hash, so an existing readable file is
    // equivalent; anything else is a real failure and must surface.
    if (!existsSync(HOST_SCRIPT_PATH)) throw error
  }
  return HOST_SCRIPT_PATH
}

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
  const scriptPath = materializeHostScript()
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
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

/**
 * Retention override for screenshots this plugin names itself. The helper prunes
 * only when the request carries `prune`, and the client sets that flag only for
 * its own default directory; a caller-supplied filePath is never touched.
 */
function screenshotKeep(): number | undefined {
  const raw = process.env.WINDOWS_TOOLS_SCREENSHOT_KEEP
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return undefined
  return Math.min(parsed, 500)
}

/**
 * Element selector shared by windows_find / windows_read / windows_click /
 * windows_type: every given field is a case-insensitive substring test and all
 * of them must match. `index` picks among the matches of the same selector, in
 * the order windows_find prints them, so an index alone is ambiguous and is
 * rejected by the helper.
 */
function elementSelectorSchema(description: string) {
  return {
    type: 'object' as const,
    additionalProperties: false,
    description,
    properties: {
      index: { type: 'integer' as const, description: 'Optional 0-based index among the elements matching the other fields, in the order windows_find prints them; defaults to the first match.' },
      name: { type: 'string' as const, description: 'Case-insensitive substring of the element name.' },
      type: { type: 'string' as const, description: 'Case-insensitive substring of the UI Automation control type short name (Button, Edit, Text, ...); a "ControlType." prefix is accepted too.' },
      automationId: { type: 'string' as const, description: 'Case-insensitive substring of the element AutomationId.' },
      className: { type: 'string' as const, description: 'Case-insensitive substring of the element class name.' },
    },
  }
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
    description: 'Capture a PNG screenshot (DPI-aware, physical pixels) and return it so you can see the screen. By default the physical screen is captured; give `window` to capture one window in the background instead — this works even when that window is covered by other windows, without disturbing the user (minimized windows are not supported). Give x, y, width, height for a region and scale (1-4) to enlarge small text or icons; in window mode the region is relative to the captured window image. A region must be given completely: x, y, width and height together, never a subset. An existing filePath is refused unless overwrite is true. Prefer windows_snapshot when you need interactive element coordinates, because a screenshot shows pixels only.',
    parameters: {
      filePath: { type: 'string', description: 'Optional absolute path for the PNG file; must end with .png and must not already exist unless overwrite is true. Defaults to a fresh timestamped file under the system temporary directory.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing file at filePath; defaults to false, in which case the call fails instead of overwriting.' },
      attachImage: { type: 'boolean', description: 'Set false to skip returning the image and only save the file; defaults to true.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Captures that window in the background instead of the screen.' },
      x: { type: 'integer', description: 'Optional region left edge; requires y, width and height as well.' },
      y: { type: 'integer', description: 'Optional region top edge; requires x, width and height as well.' },
      width: { type: 'integer', description: 'Optional region width; requires x, y and height as well.' },
      height: { type: 'integer', description: 'Optional region height; requires x, y and width as well.' },
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
      const generatedPath = args.filePath === undefined
      const path = args.filePath ?? defaultScreenshotPath()
      const request: Record<string, unknown> = { cmd: 'screenshot', path }
      // Retention applies only to the directory this plugin names itself.
      if (generatedPath) {
        request.prune = true
        const keep = screenshotKeep()
        if (keep !== undefined) request.pruneKeep = keep
      }
      if (args.window !== undefined) request.window = args.window
      // Forward region arguments one by one: the helper rejects a partial set
      // instead of silently capturing the whole screen.
      if (args.x !== undefined) request.x = args.x
      if (args.y !== undefined) request.y = args.y
      if (args.width !== undefined) request.width = args.width
      if (args.height !== undefined) request.height = args.height
      if (args.scale !== undefined) request.scale = args.scale
      if (args.overwrite === true) request.overwrite = true
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
    name: 'windows_find',
    description: 'Locate elements inside one window and print them one per line as `[i] <name> | <type> | automationId=<id> | rect=<screen x>,<y>,<w>,<h> | enabled=<true|false>`. `i` is exactly the `element.index` accepted by windows_click / windows_read / windows_type, so a find followed by an action on the same selector is coherent. The type vocabulary is the UI Automation short name (Button, Edit, Text, ListItem, MenuItem, Document, Pane, ...). Every given field matches case-insensitively as a substring and all fields must match. Only on-screen elements with a non-empty rectangle are listed, so a control currently scrolled out of view is not reported. No match prints `no element matched` — an empty result, not an error. No interactive-type whitelist is applied, so static text and container panes are listed too. `limit` defaults to 20 and is capped at 200; when the list is cut short, a final `truncated:` line states how many elements matched in total.',
    parameters: {
      window: { type: 'string', required: true, description: 'Window to search: title substring, process name (e.g. Weixin), or PID.' },
      name: { type: 'string', description: 'Optional case-insensitive substring of the element name.' },
      type: { type: 'string', description: 'Optional case-insensitive substring of the UI Automation control type short name (Button, Edit, Text, ...); a "ControlType." prefix is accepted too.' },
      automationId: { type: 'string', description: 'Optional case-insensitive substring of the element AutomationId.' },
      className: { type: 'string', description: 'Optional case-insensitive substring of the element class name. Classic Win32 and Qt apps expose their controls by class (e.g. WindowsForms10.EDIT...) rather than by automation id.' },
      limit: { type: 'integer', description: 'Maximum number of element lines; defaults to 20, capped at 200.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'find', target: args.window }
      if (args.name !== undefined) request.name = args.name
      if (args.type !== undefined) request.type = args.type
      if (args.automationId !== undefined) request.automationId = args.automationId
      if (args.className !== undefined) request.className = args.className
      if (args.limit !== undefined) request.limit = args.limit
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_read',
    description: 'Read text out of a window or out of one element. With `element` (and `window` as the search root) it reads that element: UI Automation ValuePattern first, then TextPattern, then the element name. With `window` alone it returns the text of the largest readable Document/Edit control inside that window — static labels are not included, so a window whose text lives in labels reports `(no readable text control inside the window)`. With neither it reads the currently focused control. Read-only: it never changes focus and never writes.',
    parameters: {
      window: { type: 'string', description: 'Window target: title substring, process name, or PID. Omitted together with element, the focused control is read instead.' },
      element: elementSelectorSchema('Optional element to read inside `window`; requires `window` as the search root.'),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.element !== undefined && args.window === undefined) throw new Error('reading an element needs window (the target window to search in)')
      const request: Record<string, unknown> = { cmd: 'read' }
      if (args.window !== undefined) request.target = args.window
      if (args.element !== undefined) request.element = args.element
      return callHost(request, 30000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_click',
    description: 'Click a mouse button. Default: screen coordinates in virtual-desktop pixels, executed on the real desktop (moves the cursor and changes focus). With `window`: x, y are CLIENT coordinates of that window and the click is posted in the background without moving the mouse or changing focus — reliable for classic Win32 and Qt apps (including WeChat 4.x, whose message routing and encoding are handled automatically), but a posted click is NOT turned into an input event by WPF/WinUI (measured: eight variants — Post/Send, with and without WM_MOUSEMOVE, client or screen coordinates, with WM_MOUSEACTIVATE — none of them fired a WPF button handler), and Chromium/Electron apps may ignore synthetic clicks too. To actually fire an element in WPF/WinUI you must pass `allowForeground: true` with `element`, which may bring the target window to the foreground. Instead of x/y you may pass `element` together with `window`: the host locates the element with UI Automation and reports the element it hit plus the `strategy` it used. The default element strategy is `background-post` (a posted click at the centre of the element rectangle); UIA `uia-invoke-pattern` is attempted only with `allowForeground: true`. Click replies always end with `verified=false`: delivery of the message or the pattern call is observable, the application reacting to it is not.',
    parameters: {
      x: { type: 'integer', description: 'Screen x coordinate of the click point (client x when window is set); required unless `element` is given.' },
      y: { type: 'integer', description: 'Screen y coordinate of the click point (client y when window is set); required unless `element` is given.' },
      button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Which click to perform; defaults to a single left click. Only a left click can use uia-invoke-pattern.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Posts the click to that window in the background (x, y are client coordinates, the same space as the windows_screenshot image of that window). Required when `element` is used.' },
      element: elementSelectorSchema('Optional element to click instead of x/y; requires `window`. The response names the strategy: `background-post` (default, no focus change) or `uia-invoke-pattern` (only with allowForeground).'),
      allowForeground: { type: 'boolean', description: 'Allow the element click to use UIA InvokePattern, which may bring the target window to the foreground; defaults to false, in which case the click is always posted in the background.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.element !== undefined) {
        if (args.window === undefined) throw new Error('clicking an element needs window (the target window to search in)')
        const request: Record<string, unknown> = { cmd: 'mouse', mode: 'click', button: args.button ?? 'left', window: args.window, element: args.element }
        if (args.allowForeground === true) request.allowForeground = true
        return callHost(request, 15000)
      }
      if (args.x === undefined || args.y === undefined) throw new Error('click needs x and y, or an element selector with window')
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
    description: "Type text into the focused control with exact Unicode input (spaces, punctuation, CJK and symbols are preserved). After typing, the focused control is read back and the call fails if the text did not land. Mode 'keys' (default) synthesizes per-character Unicode input; mode 'paste' uses the clipboard for bulk text. Set `clear` to select all (Ctrl+A) first; set `activate` to bring a window forward atomically before typing. With `window`, the text is posted to that window in the background (no focus change, `clear` is ignored) — best-effort: ASCII is reliable; CJK is reliable for classic Win32 and Qt apps including WeChat 4.x (byte encoding handled automatically) but may be garbled or dropped by modern WinUI/UWP apps, so prefer foreground mode with `activate` there. With `element` (plus `window` as the search root) the text goes to that element through a fixed fallback chain, and every response ends with `[strategy=<leg>] [verified=<true|false>]`: `uia-value-pattern` (UI Automation ValuePattern), then `wm-settext` (WM_SETTEXT to the element's native window handle), then `keystream` (the plain background character stream). Classic Win32 and Qt apps expose no ValuePattern, so they land on `wm-settext` or `keystream`. `verified=true` only when the text could be read back from the element; the background and element paths never touch the clipboard (only an explicit foreground `mode: 'paste'` writes it). The host layer contains no SetForegroundWindow/SetActiveWindow, but the target application's own UI Automation provider may still bring its window forward: on WPF the element path can do that (reproduced in three independent comparisons — 3 of 28 element writes, against 0 of 32 control writes), and the reply then carries `activated=true` instead of staying silent about it. Do not assume the element path leaves the foreground untouched.",
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type into the focused control.' },
      clear: { type: 'boolean', description: 'Select all existing content (Ctrl+A) before typing; defaults to false. Ignored by the background and keystream paths, which cannot replace a selection.' },
      mode: { type: 'string', enum: ['keys', 'paste'], description: "Input method; defaults to 'keys' (exact per-character Unicode input). 'paste' is faster for large text and is the only path that writes the clipboard." },
      activate: { type: 'string', description: 'Optional window title substring, process name, or PID to activate first, in the same call.' },
      window: { type: 'string', description: 'Optional window target: title substring, process name (e.g. Weixin), or PID. Posts the text to that window in the background instead of the focused control. Required when `element` is used.' },
      element: elementSelectorSchema('Optional element to type into instead of the focused control; requires `window`. The response names the strategy leg that carried the text, whether it could be read back, and `activated=true` when the target window ended up in the foreground.'),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.text.length === 0) throw new Error('text must not be empty')
      if (args.element !== undefined && args.window === undefined) throw new Error('typing into an element needs window (the target window to search in)')
      const request: Record<string, unknown> = { cmd: 'type', text: args.text, clear: args.clear === true, mode: args.mode ?? 'keys' }
      if (args.activate !== undefined) request.activate = args.activate
      if (args.window !== undefined) request.window = args.window
      if (args.element !== undefined) request.element = args.element
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
    name: 'windows_window',
    description: 'Move, resize, minimize, maximize, restore, close or pin a window, and report the rectangle and state measured AFTER the operation. These actions do not request the foreground: move/resize/topmost use SetWindowPos with SWP_NOACTIVATE, minimize/maximize/restore use ShowWindow, close posts WM_CLOSE, and the layer contains no SetForegroundWindow/SetActiveWindow. That is not a promise that no window reaches the foreground: minimizing a window that is currently foreground hands the foreground to the next window in Z order (Windows semantics), and a target application can activate its own window by itself. The cursor is not moved by these calls. An action is reported as successful only when the fresh measurement agrees with the request — move/resize allow a 2 px rounding slack for DPI-scaled windows (farther off still fails), and the reply always carries the measured rectangle rather than an echo of the request. Consequences worth knowing: moving or resizing a minimized window cannot take effect (restore it first), and `close` waits up to 1.5 s and fails if the window is still there, e.g. because it is showing a confirmation dialog. There is deliberately no activate/focus action — use windows_app with action "activate" for that.',
    parameters: {
      action: { type: 'string', enum: ['move', 'resize', 'minimize', 'maximize', 'restore', 'close', 'topmost'], required: true, description: 'Operation to perform.' },
      target: { type: 'string', required: true, description: 'Window target: title substring, process name, or PID.' },
      x: { type: 'integer', description: 'Target screen x for move (required), or an optional x when resizing.' },
      y: { type: 'integer', description: 'Target screen y for move (required), or an optional y when resizing.' },
      width: { type: 'integer', description: 'Target width for resize (required, positive).' },
      height: { type: 'integer', description: 'Target height for resize (required, positive).' },
      on: { type: 'boolean', description: 'For topmost: true pins the window above others, false unpins it; defaults to true.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'winop', action: args.action, target: args.target }
      if (args.x !== undefined) request.x = args.x
      if (args.y !== undefined) request.y = args.y
      if (args.width !== undefined) request.width = args.width
      if (args.height !== undefined) request.height = args.height
      if (args.on !== undefined) request.on = args.on
      return callHost(request, 20000)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'windows_process',
    description: 'Enumerate top-level windows, one line per window as `<pid> <name> | <title> | visible=<true|false>`. By default only visible windows that carry a title are listed, so a process with several hidden helper windows cannot push its real window out of `limit`; pass `includeHidden: true` to list those hidden windows as well, which is the only case where a line reads visible=false. Read-only: nothing is started or terminated. `name` filters the process image name case-insensitively as a substring (a trailing .exe is ignored; a plain number is matched against the pid instead). No match prints `no process matched`. `limit` defaults to 50 and is capped at 200.',
    parameters: {
      name: { type: 'string', description: 'Optional case-insensitive substring of the process image name (e.g. Weixin, chrome); a trailing .exe is ignored, and a plain number is matched against the pid.' },
      includeHidden: { type: 'boolean', description: 'Also list hidden top-level windows of those processes; defaults to false, so every line reads visible=true.' },
      limit: { type: 'integer', description: 'Maximum number of window lines; defaults to 50, capped at 200.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const request: Record<string, unknown> = { cmd: 'procs' }
      if (args.name !== undefined) request.name = args.name
      if (args.includeHidden === true) request.includeHidden = true
      if (args.limit !== undefined) request.limit = args.limit
      return callHost(request, 30000)
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
    description: 'Wait until a desktop condition becomes true instead of sleeping blindly, then return; it fails with a timeout error when the condition never appears. Conditions: foreground (the foreground window title contains `value`), window (any visible window title contains `value`), element (an element matching name/type/automationId/className appears inside `target`; the reply carries the matching element line in the same format as windows_find), windowgone (no top-level window matches `target` any more), text (the text of `target` contains `value`; same text source as windows_read with a window, so labels do not count, and a short context snippet is returned), pixel (the screen pixel at x, y changes from its color at call time), region (the average pixel difference inside x, y, width, height exceeds `threshold`, default 20; works for web-style UI that never changes window titles), settle (the region — or the whole screen when omitted — stays unchanged for `stableFrames` consecutive frames, default 3; use after any action to wait for rendering to finish). The region conditions take x, y, width and height together or not at all. Empty values are rejected: an empty title substring matches every window and would report success instantly.',
    parameters: {
      kind: { type: 'string', enum: ['foreground', 'window', 'element', 'windowgone', 'text', 'pixel', 'region', 'settle'], required: true, description: 'Condition to wait for.' },
      value: { type: 'string', description: 'Title substring for the foreground/window conditions, or the substring to look for in kind text: required and must not be empty for those kinds, unused otherwise.' },
      target: { type: 'string', description: 'Window target: for kind element/text the window to search or read, for kind windowgone the window that should disappear — title substring, process name, or PID.' },
      name: { type: 'string', description: 'Kind element: case-insensitive substring of the element name.' },
      type: { type: 'string', description: 'Kind element: case-insensitive substring of the UI Automation control type short name (Button, Edit, Text, ...).' },
      automationId: { type: 'string', description: 'Kind element: case-insensitive substring of the element AutomationId.' },
      className: { type: 'string', description: 'Kind element: case-insensitive substring of the element class name.' },
      x: { type: 'integer', description: 'Screen x coordinate: the pixel for kind pixel, or the region left edge for kind region/settle (all four region values must be given together).' },
      y: { type: 'integer', description: 'Screen y coordinate: the pixel for kind pixel, or the region top edge for kind region/settle (all four region values must be given together).' },
      width: { type: 'integer', description: 'Region width for kind region/settle; omit all four region values to watch the whole screen.' },
      height: { type: 'integer', description: 'Region height for kind region/settle; omit all four region values to watch the whole screen.' },
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
      if ((args.kind === 'foreground' || args.kind === 'window') && (args.value === undefined || args.value.length === 0)) {
        throw new Error(`wait_for kind "${args.kind}" needs a non-empty value (the title substring to wait for)`)
      }
      if (args.kind === 'element') {
        if (args.target === undefined) throw new Error('wait_for kind "element" needs target (the window to search in)')
        if (args.name === undefined && args.type === undefined && args.automationId === undefined && args.className === undefined) {
          throw new Error('wait_for kind "element" needs at least one of name, type, automationId, className')
        }
      }
      if (args.kind === 'windowgone' && args.target === undefined) {
        throw new Error('wait_for kind "windowgone" needs target (the window that should disappear)')
      }
      if (args.kind === 'text') {
        if (args.target === undefined) throw new Error('wait_for kind "text" needs target (the window whose text is read)')
        if (args.value === undefined || args.value.length === 0) throw new Error('wait_for kind "text" needs a non-empty value (the substring to look for in the window text)')
      }
      const request: Record<string, unknown> = { cmd: 'waitfor', kind: args.kind }
      if (args.value !== undefined) request.value = args.value
      if (args.target !== undefined) request.target = args.target
      if (args.name !== undefined) request.name = args.name
      if (args.type !== undefined) request.type = args.type
      if (args.automationId !== undefined) request.automationId = args.automationId
      if (args.className !== undefined) request.className = args.className
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
