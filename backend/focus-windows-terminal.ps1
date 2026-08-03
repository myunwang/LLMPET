param(
  [Parameter(Mandatory = $true)]
  [string]$WindowHandle,

  [Parameter(Mandatory = $true)]
  [string]$RuntimeId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-LlmpetResult {
  param([bool]$Ok, [string]$Reason)
  [pscustomobject]@{ ok = $Ok; reason = $Reason } | ConvertTo-Json -Compress
}

if (
  $WindowHandle -notmatch '^[1-9]\d{0,18}$' -or
  $RuntimeId -notmatch '^-?\d+(,-?\d+){0,31}$'
) {
  Write-LlmpetResult -Ok $false -Reason 'invalid-arguments'
  exit 2
}

$handleValue = [int64]$WindowHandle
$targetRuntimeId = @($RuntimeId.Split(',') | ForEach-Object { [int]$_ })
if ($handleValue -le 0 -or $targetRuntimeId.Count -eq 0) {
  Write-LlmpetResult -Ok $false -Reason 'invalid-arguments'
  exit 2
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace LlmpetFocus {
  public static class NativeMethods {
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr handle);

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

function Test-RuntimeIdEqual {
  param([int[]]$Left, [int[]]$Right)
  if ($Left.Count -ne $Right.Count) { return $false }
  for ($index = 0; $index -lt $Left.Count; $index++) {
    if ($Left[$index] -ne $Right[$index]) { return $false }
  }
  return $true
}

$windowHandleValue = [IntPtr]$handleValue
if (-not [LlmpetFocus.NativeMethods]::IsWindow($windowHandleValue)) {
  Write-LlmpetResult -Ok $false -Reason 'window-closed'
  exit 1
}

try {
  $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandleValue)
  $terminalProcess = Get-Process -Id $windowElement.Current.ProcessId -ErrorAction SilentlyContinue
  if (-not $terminalProcess -or $terminalProcess.ProcessName -ne 'WindowsTerminal') {
    Write-LlmpetResult -Ok $false -Reason 'window-mismatch'
    exit 1
  }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
  )
  $tabs = $windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $matched = $null
  foreach ($tab in $tabs) {
    try {
      if (Test-RuntimeIdEqual -Left @($tab.GetRuntimeId()) -Right $targetRuntimeId) {
        $matched = $tab
        break
      }
    } catch {}
  }

  if (-not $matched) {
    Write-LlmpetResult -Ok $false -Reason 'tab-closed'
    exit 1
  }

  $selection = $matched.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $selection.Select()
  if ([LlmpetFocus.NativeMethods]::IsIconic($windowHandleValue)) {
    [LlmpetFocus.NativeMethods]::ShowWindowAsync($windowHandleValue, 9) | Out-Null
  }
  [LlmpetFocus.NativeMethods]::SetForegroundWindow($windowHandleValue) | Out-Null
  [LlmpetFocus.NativeMethods]::SwitchToThisWindow($windowHandleValue, $true)
  Write-LlmpetResult -Ok $true -Reason 'focused'
} catch {
  Write-LlmpetResult -Ok $false -Reason 'uia-failed'
  exit 1
}
