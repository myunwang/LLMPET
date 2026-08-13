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
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr handle, bool altTab);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int needed);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    public static uint CurrentProcessId() {
      return GetCurrentProcessId();
    }

    public static int GetProcessIntegrityRid(uint processId) {
      const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      const uint TOKEN_QUERY = 0x0008;
      const int TOKEN_INTEGRITY_LEVEL = 25;
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      IntPtr token = IntPtr.Zero;
      IntPtr buffer = IntPtr.Zero;
      if (process == IntPtr.Zero || !OpenProcessToken(process, TOKEN_QUERY, out token)) {
        if (process != IntPtr.Zero) CloseHandle(process);
        return -1;
      }
      try {
        int needed;
        GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, IntPtr.Zero, 0, out needed);
        if (needed <= 0) return -1;
        buffer = Marshal.AllocHGlobal(needed);
        if (!GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buffer, needed, out needed)) return -1;
        IntPtr sid = Marshal.ReadIntPtr(buffer);
        byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        return count > 0 ? Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))) : -1;
      } finally {
        if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        CloseHandle(token);
        CloseHandle(process);
      }
    }
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
  [uint32]$targetProcessId = 0
  [LlmpetFocus.NativeMethods]::GetWindowThreadProcessId($windowHandleValue, [ref]$targetProcessId) | Out-Null
  $terminalProcess = Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue
  if (-not $terminalProcess -or $terminalProcess.ProcessName -ne 'WindowsTerminal') {
    Write-LlmpetResult -Ok $false -Reason 'window-mismatch'
    exit 1
  }

  $currentIntegrity = [LlmpetFocus.NativeMethods]::GetProcessIntegrityRid(
    [LlmpetFocus.NativeMethods]::CurrentProcessId()
  )
  $targetIntegrity = [LlmpetFocus.NativeMethods]::GetProcessIntegrityRid($targetProcessId)
  if ($currentIntegrity -gt 0 -and $targetIntegrity -gt $currentIntegrity) {
    Write-LlmpetResult -Ok $false -Reason 'elevation-required'
    exit 3
  }

  $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandleValue)

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
