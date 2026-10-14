# Persistent Windows desktop helper host for the dsh scratch-windows-tools plugin.
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
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
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

# Element click in strict background mode: a posted click at the centre of the
# element rectangle. There is deliberately no UIA InvokePattern leg — a provider
# may activate its own window while invoking (measured on WPF), and this plugin
# takes no foreground action.
function Invoke-WtElementClick($found, $el, [string]$button) {
  $label = Get-WtElementLabel $el
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

# Strict background mode: the mouse command only posts messages to a window, so a
# window target is mandatory and there is no cursor-moving or foreground fallback.
function Invoke-WtMouse($req) {
  $mode = [string]$req.mode
  if ($mode -ne 'click' -and $mode -ne 'scroll') {
    throw ('unknown mouse mode: ' + $mode + '; this plugin runs in strict background mode and only posts click and scroll messages to a window')
  }
  if ($null -ne $req.element) {
    if ($mode -ne 'click') { throw ('an element selector is only supported for click (got mode: ' + $mode + ')') }
    $button = 'left'
    if ($req.button) { $button = [string]$req.button }
    $root = Get-WtElementRoot ([string]$req.window)
    $element = Resolve-WtElement $root.element $req.element
    $result = Invoke-WtElementClick $root.window $element $button
    # A click can confirm that the message was delivered, but not that the
    # application reacted, so verified stays false by definition.
    return ('{0} [strategy={1}] [verified=false]' -f $result.message, $result.strategy)
  }
  $target = Get-WtWindowTarget $req
  if ($null -eq $target) {
    throw 'this plugin runs in strict background mode and never takes foreground input: pass window (title substring, process name, or PID) so the click or scroll can be posted to that window; for an element target use element together with window, and use windows_window for window operations'
  }
  if ($mode -eq 'click') {
    $button = 'left'
    if ($req.button) { $button = [string]$req.button }
    return Invoke-WtBackgroundClick $target ([int]$req.x) ([int]$req.y) $button
  }
  return Invoke-WtBackgroundScroll $target ([int]$req.amount)
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
# agrees with the request. There is no focus action on purpose: this plugin runs
# in strict background mode and leaves bringing a window to the front to the user.
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

# Element typing fallback chain under strict background mode: WM_SETTEXT to the
# element's native handle, then the plain background character stream posted to
# that same handle. The UIA ValuePattern leg was removed: on WPF its SetValue can
# bring the target window to the foreground (measured, roughly one call in ten)
# and the host cannot prevent that. An element without a native handle therefore
# has no usable background leg at all and is refused instead of failing silently.
function Invoke-WtElementType($el, [string]$text, $found, $watch) {
  $label = Get-WtElementLabel $el
  $handle = 0
  try { $handle = $el.Current.NativeWindowHandle } catch { $handle = 0 }
  if ($handle -eq 0) {
    throw ('element {0} exposes no native window handle, and this plugin runs in strict background mode: the only leg that could write such an element (UI Automation ValuePattern) was removed because on WPF it can bring the target window to the foreground. Post to the window instead (windows_type with window, which posts the background character stream), or use windows_clipboard and let the user paste.' -f $label)
  }
  # USER32 marshals WM_SETTEXT across processes, so SendMessage (not PostMessage,
  # which cannot carry the string pointer) is the correct call.
  [void][WtNative]::SendMessageText([IntPtr]$handle, 0x000C, [IntPtr]::Zero, $text)
  Wait-WtSettle $watch 100
  $verified = 'false'
  try {
    if ((Read-WtElementText $el).IndexOf($text, [System.StringComparison]::Ordinal) -ge 0) { $verified = 'true' }
  } catch { }
  if ($verified -eq 'true') {
    return @{ message = ('typed {0} characters into {1} (WM_SETTEXT to hwnd {2})' -f $text.Length, $label, $handle); strategy = 'wm-settext'; verified = $verified }
  }
  # WM_SETTEXT did not land: post the character stream to the same handle and
  # report whether that one landed instead.
  $note = Send-WtBackgroundText ([IntPtr]$handle) $text (Get-WtProcessName $found.ProcessId) $label
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
  if ($null -eq $target) {
    throw 'this plugin runs in strict background mode and never injects foreground keys: pass window (title substring, process name, or PID) so the text can be posted to that window; for an element target use element together with window'
  }
  $note = Invoke-WtBackgroundType $target $text
  if ($clearText) { $note = $note + ' (clear is ignored in background mode)' }
  return ($note + ' [strategy=keystream] [verified=false]')
}

function Read-WtFocusedText {
  $text = Get-WtFocusedText
  if ($null -eq $text) { return '(focused control exposes no readable text)' }
  if ($text.Length -eq 0) { return '(the focused control is empty)' }
  if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) + '... (truncated)' }
  return $text
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
      if ($null -eq $target) {
        throw 'this plugin runs in strict background mode and never injects foreground keys: pass window (title substring, process name, or PID) so the keys can be posted to that window'
      }
      return Invoke-WtBackgroundKeys $target ([string]$req.keys)
    }
    'type' { return Invoke-WtType $req }
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

# ---- host-script retention (runs once at startup) ---------------------------
# Every plugin version materializes its own content-addressed copy of this script
# as wt-host-<hash16>.ps1 in the plugin's temporary directory, and nothing else
# removes the older ones. Prune them once at startup: keep the newest N, never
# touch the running script, never touch a name that is not content-addressed, and
# never act outside the plugin's own two directories (so running this file from a
# checkout cannot delete anything in that checkout).
function Invoke-WtHostScriptPrune {
  try {
    $dir = [string]$PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($dir)) { return }
    $leaf = Split-Path -Leaf $dir
    if ($leaf -ne 'dsh-windows-tools' -and $leaf -ne 'opencode-windows-tools') { return }
    $keep = 3
    $raw = [string]$env:WINDOWS_TOOLS_HOST_KEEP
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $parsed = 0
      if ([int]::TryParse($raw.Trim(), [ref]$parsed)) { $keep = $parsed }
    }
    if ($keep -lt 1) { $keep = 1 }
    if ($keep -gt 20) { $keep = 20 }
    $self = [string]$PSCommandPath
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($file in [System.IO.Directory]::GetFiles($dir, 'wt-host-*')) {
      if ([System.IO.Path]::GetFileName($file) -notmatch '^wt-host-[0-9a-fA-F]{16}\.ps1$') { continue }
      [void]$candidates.Add($file)
    }
    if ($candidates.Count -le $keep) { return }
    # Newest first by write time; the running script is ranked like any other but
    # is never removed, even when it falls outside the kept window.
    $sorted = @($candidates | Sort-Object @{ Expression = { (Get-Item -LiteralPath $_).LastWriteTime }; Descending = $true }, @{ Expression = { $_ }; Descending = $false })
    for ($i = $keep; $i -lt $sorted.Count; $i++) {
      $path = $sorted[$i]
      if (-not [string]::IsNullOrWhiteSpace($self) -and $path -eq $self) { continue }
      try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch { }
    }
  } catch { }
}

Invoke-WtHostScriptPrune

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
