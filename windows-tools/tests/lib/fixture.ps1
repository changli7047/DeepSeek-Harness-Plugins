# One-shot WPF test window for the windows-tools regression suite.
#
# Why WPF and not WinForms: WinForms child controls are only exposed through the
# default HWND provider, so UIA reports them as ControlType=Pane with the decimal
# HWND as AutomationId (unstable across runs) -- `find` by type/automationId cannot
# work on them. WPF exposes real Edit/Button/Text elements with AutomationId = x:Name.
#
# Contract with tests/lib/host.mjs:
#   * the window is created WITHOUT activation: ShowActivated=false plus
#     WS_EX_NOACTIVATE added on SourceInitialized, so the suite never steals focus
#     and never depends on an app the user has open;
#   * the process writes a JSON descriptor (title / pid / hwnd / control ids / seed
#     text) to -InfoPath, then pumps messages until -CmdPath contains "close", the
#     window is closed from outside (winop close), or -LifetimeSeconds elapses;
#   * clicking the button appends "+c" to the text box and adds "|clicks=N" to the
#     window title, giving the suite two independent ways to observe a background click.

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$InfoPath,
  [Parameter(Mandatory = $true)][string]$CmdPath,
  [int]$LifetimeSeconds = 300,
  [int]$X = 40,
  [int]$Y = 40,
  [int]$DemoteDelayMs = 60
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WtTestNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@ -ReferencedAssemblies 'System.Windows.Forms'

$script:baseTitle = $Title
$script:clicks = 0
$script:closing = $false

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="$Title" Width="440" Height="290"
        WindowStartupLocation="Manual" Left="$X" Top="$Y"
        ShowActivated="False" Topmost="False" ShowInTaskbar="True" ResizeMode="CanResize">
  <StackPanel Margin="16">
    <TextBox x:Name="txtInput" AutomationProperties.Name="Edit-$Tag" Text="seed-$Tag" Height="28"/>
    <Button x:Name="btnGo" Content="Go-$Tag" Height="34" Width="160" HorizontalAlignment="Left" Margin="0,14,0,0"/>
    <TextBlock x:Name="lblNote" Text="Note-$Tag" Margin="0,14,0,0"/>
  </StackPanel>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$script:window = [System.Windows.Markup.XamlReader]::Load($reader)
$script:txt = $script:window.FindName('txtInput')
$script:btn = $script:window.FindName('btnGo')
$script:lbl = $script:window.FindName('lblNote')

# WS_EX_NOACTIVATE (0x08000000): the window can never be activated, so UIA calls
# issued against it cannot pull the user's focus away.
$script:window.Add_SourceInitialized({
    try {
      $helper = New-Object System.Windows.Interop.WindowInteropHelper $script:window
      $hwnd = $helper.Handle
      $ex = [WtTestNative]::GetWindowLong($hwnd, -20)
      [void][WtTestNative]::SetWindowLong($hwnd, -20, ($ex -bor 0x08000000))
    } catch { }
  })

$script:btn.Add_Click({
    $script:clicks++
    $script:txt.Text = $script:txt.Text + '+c'
    $script:window.Title = $script:baseTitle + '|clicks=' + $script:clicks
  })

$script:window.Add_Closed({ $script:closing = $true })

# Local activation truth: whether *this window* got activated, independent of the global
# foreground state (which is unavailable while the desktop has no foreground window, and
# is stirred by whatever the user is doing). Polled inside the timer as well, because a
# WS_EX_NOACTIVATE window does not always raise the Activated event.
$script:actLog = Join-Path (Split-Path -Parent $InfoPath) ('activated-' + $Tag + '.txt')
$script:lastActive = $false
$script:lastOtherFg = [IntPtr]::Zero
$script:fgHistory = New-Object System.Collections.Generic.List[IntPtr]

# The provider of the target application sometimes activates this window as a side effect
# of a UIA write. A *test scaffold* has no business holding the user's foreground, so it
# gives it straight back: hand the foreground to whichever window had it before (we only
# hold it because we were just activated, and the current foreground process is allowed to
# pass it on), then drop to the bottom of the Z-order without taking activation back.
# The activation log is still written first, so the observation is never lost.
$script:logNote = {
    param([string]$text)
    try { Add-Content -LiteralPath $script:actLog -Value (('{0} {1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $text)) -Encoding ASCII } catch { }
  }

$script:selfDemote = {
    try {
      $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
      $handedBack = $false
      foreach ($candidate in $script:fgHistory) {
        if ($candidate -eq [IntPtr]::Zero -or -not [WtTestNative]::IsWindow($candidate)) { continue }
        if ([WtTestNative]::SetForegroundWindow($candidate)) { $handedBack = $true; break }
      }
      if (-not $handedBack) {
        $shell = [WtTestNative]::GetShellWindow()
        if ($shell -ne [IntPtr]::Zero -and [WtTestNative]::IsWindow($shell)) {
          $handedBack = [WtTestNative]::SetForegroundWindow($shell)
        }
      }
      [void][WtTestNative]::SetWindowPos($hwnd, [IntPtr]1, 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0010 -bor 0x0200)
      # SW_SHOWNA (8), NOT SW_SHOWNOACTIVATE (4): value 4 has SW_SHOWNORMAL semantics and
      # restores a maximized window to its normal size (the suite caught this: winop
      # maximize started failing because the scaffold un-maximized its own window).
      [void][WtTestNative]::ShowWindow($hwnd, 8)
      # Record the release from the *system* foreground, which is what the user actually
      # experiences; WPF's own Deactivated event can lag by seconds for a WS_EX_NOACTIVATE
      # window, and logging that lag would overstate the occupancy.
      $released = [WtTestNative]::GetForegroundWindow() -ne $hwnd
      if ($released -and $script:lastActive) {
        $script:lastActive = $false
        Add-Content -LiteralPath $script:actLog -Value (('{0} isActive=False (released by self-demotion)' -f (Get-Date).ToString('HH:mm:ss.fff'))) -Encoding ASCII
      }
      & $script:logNote ('demote handedBack={0} released={1} candidates={2}' -f $handedBack, $released, $script:fgHistory.Count)
    } catch {
      & $script:logNote ('demote failed: ' + $_.Exception.Message)
    }
  }

# Occupancy is measured on the *system* foreground (GetForegroundWindow), which is what
# the user experiences and what the verifier measured — not WPF's IsActive, which goes
# stale for a WS_EX_NOACTIVATE window and reported multi-second "occupancies" while the
# system foreground was already somebody else's. Entry is event-driven (Activated), exit is
# event-driven (self-demotion) plus a 200 ms poll as a backstop.
$script:noteActivation = {
    try {
      $own = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
      $now = ([WtTestNative]::GetForegroundWindow() -eq $own)
      if ($now -ne $script:lastActive) {
        $script:lastActive = $now
        Add-Content -LiteralPath $script:actLog -Value (('{0} isActive={1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $now)) -Encoding ASCII
      }
    } catch { }
  }
$script:window.Add_Activated({
    & $script:noteActivation
    # Bounded hold before handing the foreground back: long enough for the host's 10 ms
    # foreground sampler to observe the activation it is required to report (releasing in
    # ~3 ms made that contract unverifiable — the suite reported INCONCLUSIVE 20/20), short
    # enough to be imperceptible (the user-facing criterion is < 1 s; this is ~0.06 s).
    try {
      $script:demoteTimer = New-Object System.Windows.Threading.DispatcherTimer
      $script:demoteTimer.Interval = [TimeSpan]::FromMilliseconds($DemoteDelayMs)
      $script:demoteTimer.Add_Tick({
          try { $script:demoteTimer.Stop() } catch { }
          & $script:selfDemote
        })
      $script:demoteTimer.Start()
    } catch { & $script:selfDemote }
  })
$script:window.Add_Deactivated({ & $script:noteActivation })

$script:window.Show()
[System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([System.Windows.Threading.DispatcherPriority]::Background, [action] { })

$helper = New-Object System.Windows.Interop.WindowInteropHelper $script:window
$info = [ordered]@{
  title       = [string]$script:window.Title
  baseTitle   = $script:baseTitle
  tag         = $Tag
  pid         = $PID
  hwnd        = [int64]$helper.Handle
  textBoxId   = 'txtInput'
  buttonId    = 'btnGo'
  labelId     = 'lblNote'
  textBoxName = ('Edit-' + $Tag)
  buttonName  = ('Go-' + $Tag)
  labelName   = ('Note-' + $Tag)
  seed        = ('seed-' + $Tag)
  activatedLog = $script:actLog
}
$json = ($info | ConvertTo-Json -Compress)
[System.IO.File]::WriteAllText($InfoPath + '.tmp', $json, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath ($InfoPath + '.tmp') -Destination $InfoPath -Force

# A real WPF message loop, not a poll-with-sleep.
#
# Cross-process UI Automation makes hundreds of round trips into this window's UI thread
# per element search, so a loop that only pumps every 40 ms multiplies every UIA call:
# measured 8.5–10.7 s per `find` with a polling pump versus milliseconds with
# Dispatcher.Run() (implementer-host measured 12766 ms vs ~0 ms per call on the same
# host and machine). The housekeeping (close command file, lifetime) rides on a timer
# inside the loop instead of blocking it.
$script:deadline = (Get-Date).AddSeconds($LifetimeSeconds)
$script:timer = New-Object System.Windows.Threading.DispatcherTimer
$script:timer.Interval = [TimeSpan]::FromMilliseconds(200)
$script:timer.Add_Tick({
    & $script:noteActivation
    # Remember who had the foreground before us (a short history, so a window that has
    # since closed cannot block the hand-back), and self-demote if we ever hold the
    # foreground without having raised the Activated event (WS_EX_NOACTIVATE windows do
    # not always raise it).
    try {
      $own = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
      $fg = [WtTestNative]::GetForegroundWindow()
      if ($fg -ne [IntPtr]::Zero -and $fg -ne $own) {
        $script:lastOtherFg = $fg
        if (-not $script:fgHistory.Contains($fg)) { $script:fgHistory.Insert(0, $fg) }
        while ($script:fgHistory.Count -gt 5) { $script:fgHistory.RemoveAt(5) }
      } elseif ($fg -eq $own) {
        # The system says we hold the user's foreground: give it back immediately.
        & $script:selfDemote
      }
    } catch { }
    if ($script:closing -or (Get-Date) -gt $script:deadline) {
      try { $script:timer.Stop() } catch { }
      try { $script:window.Close() } catch { }
      # No Application object exists (the window was created directly), so closing the
      # last window does not end the loop by itself.
      try { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() } catch { }
      return
    }
    if (Test-Path -LiteralPath $script:CmdPath) {
      $command = ''
      try { $command = [System.IO.File]::ReadAllText($script:CmdPath) } catch { $command = '' }
      if ($command -match 'close') {
        try { $script:timer.Stop() } catch { }
        try { $script:window.Close() } catch { }
        try { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() } catch { }
      }
    }
  })
$script:timer.Start()
[System.Windows.Threading.Dispatcher]::Run()

exit 0
