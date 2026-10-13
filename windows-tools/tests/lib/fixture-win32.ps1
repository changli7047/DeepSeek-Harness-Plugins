# One-shot classic Win32 (WinForms) test window for the windows-tools regression suite.
#
# Why a second fixture kind: background (posted) mouse input does reach a classic Win32
# window -- unlike a WPF window, whose input system ignores synthetic messages
# (windows-tools/README.md 限制节). So this fixture is the one place where the suite can
# assert that an element click has a *real effect* on an application, not just that a
# message was delivered.
#
# It is never activated (ShowWithoutActivation + WS_EX_NOACTIVATE) and closes on demand:
#   * a clicked button writes -MarkerPath, which the case polls for;
#   * the pump is Application.Run() with a WinForms timer for the close command/lifetime.

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$InfoPath,
  [Parameter(Mandatory = $true)][string]$CmdPath,
  [Parameter(Mandatory = $true)][string]$MarkerPath,
  [int]$LifetimeSeconds = 300,
  [int]$X = 40,
  [int]$Y = 420,
  [int]$DemoteDelayMs = 60
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class WtTestFormWin32 : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            return cp;
        }
    }
}

// Delivery probe: counts the mouse messages that actually reach this control's window
// procedure. Unlike a WinForms Button (whose Click decision reads the REAL cursor position
// through Control.MousePosition on mouse-up), this reflects only whether the synthetic
// click was delivered -- which is exactly the claim the suite wants to assert. It derives
// from Label so that its Text becomes its UIA Name (a plain Panel exposes no window text
// and is therefore not selectable by name).
public class WtMessageProbe : Label {
    public int DownCount = 0;
    public int UpCount = 0;
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0201) { DownCount++; }   // WM_LBUTTONDOWN
        if (m.Msg == 0x0202) { UpCount++; }     // WM_LBUTTONUP
        base.WndProc(ref m);
    }
}

public class WtTestWin32Native {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
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
'@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'

$script:MarkerPath = $MarkerPath
$script:CounterPath = Join-Path (Split-Path -Parent $InfoPath) ('messages-' + $Tag + '.txt')
$script:closing = $false
$script:deadline = (Get-Date).AddSeconds($LifetimeSeconds)

# DPI awareness matters for this fixture: the host is DPI-aware and computes the click's
# client point in physical pixels, while a DPI-unaware process gets its window virtualized
# by the OS. The mismatch left the posted point only marginally inside the button in the
# app's own coordinate space, which made the click effect intermittent.
[void][WtTestWin32Native]::SetProcessDPIAware()

$form = New-Object WtTestFormWin32
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point $X, $Y
$form.ClientSize = New-Object System.Drawing.Size 420, 200
$form.TopMost = $false
$form.ShowInTaskbar = $true

$btn = New-Object System.Windows.Forms.Button
$btn.Name = 'btnGo'
$btn.Text = ('Go-' + $Tag)
$btn.Location = New-Object System.Drawing.Point 20, 20
$btn.Size = New-Object System.Drawing.Size 200, 48
$btn.Add_Click({
    try { [System.IO.File]::WriteAllText($script:MarkerPath, 'clicked') } catch { }
  })
$form.Controls.Add($btn)

# The delivery probe sits below the button and is the primary effect channel: its WndProc
# counts the messages regardless of where the real cursor happens to be.
$script:probe = New-Object WtMessageProbe
$script:probe.Name = 'probeArea'
$script:probe.Text = ('Probe-' + $Tag)
$script:probe.AccessibleName = ('Probe-' + $Tag)
$script:probe.AutoSize = $false
$script:probe.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$script:probe.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$script:probe.Location = New-Object System.Drawing.Point 20, 90
$script:probe.Size = New-Object System.Drawing.Size 220, 60
$script:probe.BackColor = [System.Drawing.Color]::LightSteelBlue
$form.Controls.Add($script:probe)
$form.Add_Closed({ $script:closing = $true })
$form.Show()
[System.Windows.Forms.Application]::DoEvents()

# Same scaffold discipline as the WPF fixture: log the *system* foreground occupancy
# (local truth for the suite) and give the foreground straight back if we are ever
# activated. Occupancy is measured with GetForegroundWindow, not with focus proxies.
$script:actLog = Join-Path (Split-Path -Parent $InfoPath) ('activated-' + $Tag + '.txt')
$script:lastActive = $false
$script:fgHistory = New-Object System.Collections.Generic.List[IntPtr]

$script:logNote = {
    param([string]$text)
    try { Add-Content -LiteralPath $script:actLog -Value (('{0} {1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $text)) -Encoding ASCII } catch { }
  }

$script:noteActivation = {
    try {
      $now = ([WtTestWin32Native]::GetForegroundWindow() -eq $form.Handle)
      if ($now -ne $script:lastActive) {
        $script:lastActive = $now
        Add-Content -LiteralPath $script:actLog -Value (('{0} isActive={1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $now)) -Encoding ASCII
      }
    } catch { }
  }

$script:selfDemote = {
    try {
      $handedBack = $false
      foreach ($candidate in $script:fgHistory) {
        if ($candidate -eq [IntPtr]::Zero -or -not [WtTestWin32Native]::IsWindow($candidate)) { continue }
        if ([WtTestWin32Native]::SetForegroundWindow($candidate)) { $handedBack = $true; break }
      }
      if (-not $handedBack) {
        $shell = [WtTestWin32Native]::GetShellWindow()
        if ($shell -ne [IntPtr]::Zero -and [WtTestWin32Native]::IsWindow($shell)) {
          $handedBack = [WtTestWin32Native]::SetForegroundWindow($shell)
        }
      }
      [void][WtTestWin32Native]::SetWindowPos($form.Handle, [IntPtr]1, 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0010 -bor 0x0200)
      # SW_SHOWNA (8), NOT SW_SHOWNOACTIVATE (4): value 4 has SW_SHOWNORMAL semantics and
      # would restore/relocate the window (it broke both the winop state cases and this
      # fixture's own click coordinates).
      [void][WtTestWin32Native]::ShowWindow($form.Handle, 8)
      $released = [WtTestWin32Native]::GetForegroundWindow() -ne $form.Handle
      if ($released -and $script:lastActive) {
        $script:lastActive = $false
        Add-Content -LiteralPath $script:actLog -Value (('{0} isActive=False (released by self-demotion)' -f (Get-Date).ToString('HH:mm:ss.fff'))) -Encoding ASCII
      }
      & $script:logNote ('demote handedBack={0} released={1} candidates={2}' -f $handedBack, $released, $script:fgHistory.Count)
    } catch {
      & $script:logNote ('demote failed: ' + $_.Exception.Message)
    }
  }
$form.Add_Activated({
    & $script:noteActivation
    # Bounded hold: long enough for the host's 10 ms foreground sampler to observe the
    # activation it is required to report, short enough to be imperceptible (the user-facing
    # criterion is < 1 s; this is ~0.06 s). WinForms spells the counterpart event
    # `Deactivate`, not `Deactivated` (that one is WPF's).
    try {
      $script:demoteTimer = New-Object System.Windows.Forms.Timer
      $script:demoteTimer.Interval = $DemoteDelayMs
      $script:demoteTimer.Add_Tick({
          try { $script:demoteTimer.Stop() } catch { }
          & $script:selfDemote
        })
      $script:demoteTimer.Start()
    } catch { & $script:selfDemote }
  })
$form.Add_Deactivate({ & $script:noteActivation })

$info = [ordered]@{
  kind        = 'win32'
  title       = [string]$form.Text
  baseTitle   = $Title
  tag         = $Tag
  pid         = $PID
  hwnd        = [int64]$form.Handle
  buttonId    = 'btnGo'
  buttonName  = ('Go-' + $Tag)
  probeId     = 'probeArea'
  probeName   = ('Probe-' + $Tag)
  markerPath  = $MarkerPath
  counterPath = $script:CounterPath
  activatedLog = $script:actLog
}
$json = ($info | ConvertTo-Json -Compress)
[System.IO.File]::WriteAllText($InfoPath + '.tmp', $json, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath ($InfoPath + '.tmp') -Destination $InfoPath -Force

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    & $script:noteActivation
    # Publish the delivery counters so the suite can observe them from outside.
    try {
      [System.IO.File]::WriteAllText($script:CounterPath, ('down={0} up={1}' -f $script:probe.DownCount, $script:probe.UpCount), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
    try {
      $fg = [WtTestWin32Native]::GetForegroundWindow()
      if ($fg -ne [IntPtr]::Zero -and $fg -ne $form.Handle) {
        if (-not $script:fgHistory.Contains($fg)) { $script:fgHistory.Insert(0, $fg) }
        while ($script:fgHistory.Count -gt 5) { $script:fgHistory.RemoveAt(5) }
      } elseif ($fg -eq $form.Handle) {
        & $script:selfDemote
      }
    } catch { }
    if ($script:closing -or (Get-Date) -gt $script:deadline) {
      try { $timer.Stop() } catch { }
      try { $form.Close() } catch { }
      return
    }
    if (Test-Path -LiteralPath $CmdPath) {
      $command = ''
      try { $command = [System.IO.File]::ReadAllText($CmdPath) } catch { $command = '' }
      if ($command -match 'close') {
        try { $timer.Stop() } catch { }
        try { $form.Close() } catch { }
      }
    }
  })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)

exit 0
