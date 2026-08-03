param(
  [Parameter(Mandatory = $true)]
  [string]$Marker,

  [int]$TimeoutMs = 1200
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-LlmpetResult {
  param(
    [bool]$Ok,
    [string]$Reason,
    [string]$WindowHandle = '',
    [int[]]$RuntimeId = @()
  )
  [pscustomobject]@{
    ok = $Ok
    reason = $Reason
    hwnd = $WindowHandle
    runtimeId = @($RuntimeId)
  } | ConvertTo-Json -Compress
}

if ($Marker -notmatch '^LLMPET-[0-9a-f]{32}$') {
  Write-LlmpetResult -Ok $false -Reason 'invalid-arguments'
  exit 2
}

$TimeoutMs = [Math]::Max(250, [Math]::Min(2500, $TimeoutMs))

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LlmpetCapture {
  public static class NativeMethods {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetConsoleTitle(StringBuilder title, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetConsoleTitle(string title);
  }
}
'@

$savedTitle = New-Object System.Text.StringBuilder 32768
[LlmpetCapture.NativeMethods]::GetConsoleTitle($savedTitle, [uint32]$savedTitle.Capacity) | Out-Null
$originalTitle = $savedTitle.ToString()
$marked = $false
$result = @{ ok = $false; reason = 'title-marker-failed'; hwnd = ''; runtimeId = @() }

try {
  $marked = [LlmpetCapture.NativeMethods]::SetConsoleTitle($Marker)
  if (-not $marked) {
    Write-LlmpetResult -Ok $false -Reason 'title-marker-failed'
    exit 1
  }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
  )
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)

  while ([DateTime]::UtcNow -lt $deadline) {
    $tabs = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )

    foreach ($tab in $tabs) {
      try {
        if ($tab.Current.Name -cne $Marker) { continue }
        $terminalProcess = Get-Process -Id $tab.Current.ProcessId -ErrorAction SilentlyContinue
        if (-not $terminalProcess -or $terminalProcess.ProcessName -ne 'WindowsTerminal') { continue }

        $runtimeId = @($tab.GetRuntimeId())
        if ($runtimeId.Count -eq 0) { continue }

        $windowElement = $tab
        $windowHandle = [IntPtr]::Zero
        while ($windowElement) {
          if (
            $windowElement.Current.ProcessId -eq $tab.Current.ProcessId -and
            $windowElement.Current.NativeWindowHandle -ne 0
          ) {
            $windowHandle = [IntPtr]$windowElement.Current.NativeWindowHandle
          }
          $parent = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($windowElement)
          if (-not $parent -or $parent -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
          $windowElement = $parent
        }
        if ($windowHandle -eq [IntPtr]::Zero) { continue }

        $result = @{
          ok = $true
          reason = 'captured'
          hwnd = [string]$windowHandle.ToInt64()
          runtimeId = @($runtimeId)
        }
        break
      } catch {
        # Terminal may redraw while the UI Automation tree is being scanned.
      }
    }

    if ($result.ok) { break }
    Start-Sleep -Milliseconds 40
  }

  if (-not $result.ok) { $result.reason = 'tab-not-found' }
} finally {
  if ($marked) {
    [LlmpetCapture.NativeMethods]::SetConsoleTitle($originalTitle) | Out-Null
  }
}

Write-LlmpetResult -Ok $result.ok -Reason $result.reason -WindowHandle $result.hwnd -RuntimeId $result.runtimeId
if (-not $result.ok) { exit 1 }
