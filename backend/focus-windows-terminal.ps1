param(
  [Parameter(Mandatory = $true)]
  [string]$PidList,

  [Parameter(Mandatory = $true)]
  [string]$Marker,

  [int]$TimeoutMs = 1500
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-LlmpetResult {
  param([bool]$Ok, [string]$Reason, [int]$TargetPid = 0)
  [pscustomobject]@{
    ok = $Ok
    reason = $Reason
    pid = $TargetPid
  } | ConvertTo-Json -Compress
}

if ($PidList -notmatch '^\d+(,\d+)*$' -or $Marker -notmatch '^LLMPET-[0-9a-f]{32}$') {
  Write-LlmpetResult -Ok $false -Reason 'invalid-arguments'
  exit 2
}

$candidatePids = @($PidList.Split(',') | ForEach-Object { [int]$_ } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
if ($candidatePids.Count -eq 0) {
  Write-LlmpetResult -Ok $false -Reason 'no-live-pid'
  exit 2
}

$TimeoutMs = [Math]::Max(250, [Math]::Min(3000, $TimeoutMs))

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LlmpetFocus {
  public static class NativeMethods {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetConsoleTitle(StringBuilder title, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetConsoleTitle(string title);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr handle, int command);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr handle, bool altTab);
  }
}
'@

$result = @{ ok = $false; reason = 'console-not-found'; pid = 0 }

foreach ($candidatePid in $candidatePids) {
  [LlmpetFocus.NativeMethods]::FreeConsole() | Out-Null
  if (-not [LlmpetFocus.NativeMethods]::AttachConsole([uint32]$candidatePid)) {
    continue
  }

  $savedTitle = New-Object System.Text.StringBuilder 32768
  [LlmpetFocus.NativeMethods]::GetConsoleTitle($savedTitle, [uint32]$savedTitle.Capacity) | Out-Null
  $originalTitle = $savedTitle.ToString()

  try {
    if (-not [LlmpetFocus.NativeMethods]::SetConsoleTitle($Marker)) {
      $result = @{ ok = $false; reason = 'title-marker-failed'; pid = $candidatePid }
      continue
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $tabCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem
    )

    while ([DateTime]::UtcNow -lt $deadline) {
      $tabs = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $tabCondition
      )

      foreach ($tab in $tabs) {
        try {
          if ($tab.Current.Name -cne $Marker) { continue }
          $terminalProcess = Get-Process -Id $tab.Current.ProcessId -ErrorAction SilentlyContinue
          if (-not $terminalProcess -or $terminalProcess.ProcessName -ne 'WindowsTerminal') { continue }

          $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          $selection.Select()

          $windowElement = $tab
          $windowHandle = [IntPtr]::Zero
          while ($windowElement) {
            if ($windowElement.Current.NativeWindowHandle -ne 0) {
              $windowHandle = [IntPtr]$windowElement.Current.NativeWindowHandle
            }
            $parent = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($windowElement)
            if (-not $parent -or $parent -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
            $windowElement = $parent
          }

          if ($windowHandle -ne [IntPtr]::Zero) {
            if ([LlmpetFocus.NativeMethods]::IsIconic($windowHandle)) {
              [LlmpetFocus.NativeMethods]::ShowWindowAsync($windowHandle, 9) | Out-Null
            }
            [LlmpetFocus.NativeMethods]::SetForegroundWindow($windowHandle) | Out-Null
            [LlmpetFocus.NativeMethods]::SwitchToThisWindow($windowHandle, $true)
          }

          $result = @{ ok = $true; reason = 'focused'; pid = $candidatePid }
          break
        } catch {
          # UI Automation can invalidate elements while Terminal redraws. Poll
          # again until the bounded deadline instead of failing the whole run.
        }
      }

      if ($result.ok) { break }
      Start-Sleep -Milliseconds 50
    }

    if (-not $result.ok -and $result.reason -eq 'console-not-found') {
      $result = @{ ok = $false; reason = 'tab-not-found'; pid = $candidatePid }
    }
  } finally {
    [LlmpetFocus.NativeMethods]::SetConsoleTitle($originalTitle) | Out-Null
    [LlmpetFocus.NativeMethods]::FreeConsole() | Out-Null
  }

  if ($result.ok) { break }
}

Write-LlmpetResult -Ok $result.ok -Reason $result.reason -TargetPid $result.pid
if (-not $result.ok) { exit 1 }
