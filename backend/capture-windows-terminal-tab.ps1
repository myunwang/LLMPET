param(
  [int]$TimeoutMs = 900,

  [int]$ExpectedProcessId = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$TimeoutMs = [Math]::Max(250, [Math]::Min(2000, $TimeoutMs))
if ($ExpectedProcessId -le 0) {
  Write-Output '{"ok":false,"reason":"session-correlation-required","hwnd":"","runtimeId":[]}'
  exit 2
}

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

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace LlmpetCapture {
  public static class NativeMethods {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
  }
}
'@

$tabCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$result = @{ ok = $false; reason = 'foreground-not-terminal'; hwnd = ''; runtimeId = @() }

while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $windowHandle = [LlmpetCapture.NativeMethods]::GetForegroundWindow()
    if ($windowHandle -eq [IntPtr]::Zero) {
      $result.reason = 'foreground-unavailable'
      Start-Sleep -Milliseconds 30
      continue
    }

    $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
    $terminalProcess = Get-Process -Id $windowElement.Current.ProcessId -ErrorAction SilentlyContinue
    if (-not $terminalProcess -or $terminalProcess.ProcessName -ne 'WindowsTerminal') {
      $result.reason = 'foreground-not-terminal'
      Start-Sleep -Milliseconds 30
      continue
    }
    if ($terminalProcess.Id -ne $ExpectedProcessId) {
      $result.reason = 'foreground-session-mismatch'
      Start-Sleep -Milliseconds 30
      continue
    }

    $tabs = $windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
    foreach ($tab in $tabs) {
      try {
        $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $selection.Current.IsSelected) { continue }
        $runtimeId = @($tab.GetRuntimeId())
        if ($runtimeId.Count -eq 0) { continue }
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
    $result.reason = 'selected-tab-not-found'
  } catch {
    $result.reason = 'uia-failed'
  }
  Start-Sleep -Milliseconds 30
}

Write-LlmpetResult -Ok $result.ok -Reason $result.reason -WindowHandle $result.hwnd -RuntimeId $result.runtimeId
if (-not $result.ok) { exit 1 }
