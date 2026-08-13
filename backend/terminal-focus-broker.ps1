param(
  [switch]$SelfTest,

  [string]$ExpectedClientPath,

  [string]$PipeName = 'LLMPET.TerminalFocus.v1',

  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HelperPath = Join-Path $PSScriptRoot 'focus-windows-terminal.ps1'
$MaximumMessageLength = 8192
$InstalledAppPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\LLMPET.exe'))
if (-not [string]::IsNullOrWhiteSpace($ExpectedClientPath)) {
  $InstalledAppPath = [IO.Path]::GetFullPath($ExpectedClientPath)
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $env:LOCALAPPDATA 'LLMPET\terminal-focus-broker.log'
}
$LogPath = [IO.Path]::GetFullPath($LogPath)
$LogDirectory = Split-Path -Parent $LogPath
$script:StopRequested = $false

function Write-BrokerLog {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 262144) {
      Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
    }
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
      '[{0:O}] {1}' -f [DateTime]::UtcNow, $Message
    )
  } catch {}
}

function ConvertTo-BrokerResult {
  param([bool]$Ok, [string]$Reason)
  [pscustomobject]@{ ok = $Ok; reason = $Reason } | ConvertTo-Json -Compress
}

Add-Type -TypeDefinition @'
using System;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace LlmpetBroker {
  public static class NativeMethods {
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeServerProcessId(
      SafePipeHandle pipe,
      out uint serverProcessId
    );

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll")]
    public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
  }
}
'@

function Test-BrokerClient {
  param([System.IO.Pipes.NamedPipeClientStream]$Pipe)
  try {
    [uint32]$serverProcessId = 0
    if (-not [LlmpetBroker.NativeMethods]::GetNamedPipeServerProcessId(
      $Pipe.SafePipeHandle,
      [ref]$serverProcessId
    )) { return $false }
    $serverProcess = Get-Process -Id $serverProcessId -ErrorAction Stop
    $serverPath = [IO.Path]::GetFullPath($serverProcess.Path)
    if (-not [string]::Equals($serverPath, $InstalledAppPath, [StringComparison]::OrdinalIgnoreCase)) {
      Write-BrokerLog ("rejected pipe server pid=$serverProcessId path=$serverPath")
      return $false
    }
    [uint32]$serverSessionId = 0
    [uint32]$brokerSessionId = 0
    $brokerProcessId = [LlmpetBroker.NativeMethods]::GetCurrentProcessId()
    if (-not [LlmpetBroker.NativeMethods]::ProcessIdToSessionId($serverProcessId, [ref]$serverSessionId) -or
        -not [LlmpetBroker.NativeMethods]::ProcessIdToSessionId($brokerProcessId, [ref]$brokerSessionId) -or
        $serverSessionId -ne $brokerSessionId) {
      Write-BrokerLog ("rejected cross-session pipe server pid=$serverProcessId")
      return $false
    }
    return $true
  } catch {
    Write-BrokerLog ("could not validate pipe server: " + $_.Exception.Message)
    return $false
  }
}

function Test-WindowsTerminalWindow {
  param([string]$WindowHandle)
  try {
    $handle = [IntPtr][int64]$WindowHandle
    if (-not [LlmpetBroker.NativeMethods]::IsWindow($handle)) { return $false }
    [uint32]$processId = 0
    [LlmpetBroker.NativeMethods]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
    if ($processId -eq 0) { return $false }
    $process = Get-Process -Id $processId -ErrorAction Stop
    return $process.ProcessName -eq 'WindowsTerminal'
  } catch {
    return $false
  }
}

function Invoke-FocusHelper {
  param([string]$WindowHandle, [int[]]$RuntimeId)
  if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'helper-missing'
  }

  $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $runtimeIdText = $RuntimeId -join ','
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powershellPath
  $startInfo.Arguments = (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -WindowHandle {1} -RuntimeId {2}' -f
      $HelperPath.Replace('"', '""'), $WindowHandle, $runtimeIdText
  )
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(7000)) {
      try { $process.Kill() } catch {}
      return ConvertTo-BrokerResult -Ok $false -Reason 'helper-timeout'
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($stderr) { Write-BrokerLog ("focus helper stderr: " + $stderr.Trim().Substring(0, [Math]::Min(300, $stderr.Trim().Length))) }
    $lines = @($stdout -split '\r?\n' | Where-Object { $_ })
    try {
      $result = $lines[-1] | ConvertFrom-Json
      if ($result.ok -eq $true) { return ConvertTo-BrokerResult -Ok $true -Reason 'focused' }
      $reason = [string]$result.reason
      if ($reason -match '^[a-z0-9-]{1,64}$') {
        return ConvertTo-BrokerResult -Ok $false -Reason $reason
      }
    } catch {}
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-helper-output'
  } catch {
    Write-BrokerLog ("focus helper failed: " + $_.Exception.Message)
    return ConvertTo-BrokerResult -Ok $false -Reason 'helper-failed'
  } finally {
    $process.Dispose()
  }
}

function Invoke-BrokerRequest {
  param([string]$Line)
  if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -gt $MaximumMessageLength) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-request'
  }

  try { $request = $Line | ConvertFrom-Json } catch {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-request'
  }
  $properties = @($request.PSObject.Properties.Name)
  if (-not ($properties -contains 'protocol') -or -not ($properties -contains 'operation')) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-request'
  }
  if ([int]$request.protocol -ne 1) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'unsupported-protocol'
  }
  if ([string]$request.operation -eq 'health') {
    return ConvertTo-BrokerResult -Ok $true -Reason 'ready'
  }
  if ([string]$request.operation -eq 'shutdown') {
    $script:StopRequested = $true
    return ConvertTo-BrokerResult -Ok $true -Reason 'stopping'
  }
  if ([string]$request.operation -ne 'focus-windows-terminal-tab') {
    return ConvertTo-BrokerResult -Ok $false -Reason 'operation-denied'
  }
  if (-not ($properties -contains 'windowHandle') -or -not ($properties -contains 'runtimeId')) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-request'
  }

  $windowHandle = [string]$request.windowHandle
  if ($windowHandle -notmatch '^[1-9]\d{0,18}$') {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-arguments'
  }
  try {
    if ([int64]$windowHandle -le 0) { throw 'invalid handle' }
  } catch {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-arguments'
  }

  $values = @($request.runtimeId)
  if ($values.Count -lt 1 -or $values.Count -gt 32) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-arguments'
  }
  $runtimeId = @()
  foreach ($value in $values) {
    $text = [string]$value
    if ($text -notmatch '^-?\d{1,10}$') {
      return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-arguments'
    }
    try { $number = [int64]$text } catch {
      return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-arguments'
    }
    if ($number -lt [int]::MinValue -or $number -gt [int]::MaxValue) {
      return ConvertTo-BrokerResult -Ok $false -Reason 'invalid-arguments'
    }
    $runtimeId += [int]$number
  }

  if (-not (Test-WindowsTerminalWindow -WindowHandle $windowHandle)) {
    return ConvertTo-BrokerResult -Ok $false -Reason 'window-mismatch'
  }
  Invoke-FocusHelper -WindowHandle $windowHandle -RuntimeId $runtimeId
}

if ($SelfTest) {
  try {
    if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) { throw 'focus helper missing' }
    if (-not ([LlmpetBroker.NativeMethods].GetMethod('GetNamedPipeServerProcessId'))) {
      throw 'pipe server validation API missing'
    }
    ConvertTo-BrokerResult -Ok $true -Reason 'self-test-passed'
    exit 0
  } catch {
    ConvertTo-BrokerResult -Ok $false -Reason 'self-test-failed'
    Write-BrokerLog ("self-test failed: " + $_.Exception.Message)
    exit 1
  }
}

$created = $false
$mutexName = 'Local\LLMPET.TerminalFocusBroker.' + ($PipeName -replace '[^A-Za-z0-9_.-]', '_')
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
if (-not $created) { exit 0 }

Write-BrokerLog 'broker started'
try {
  while (-not $script:StopRequested) {
    $pipe = $null
    $reader = $null
    $writer = $null
    try {
      $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.',
        $PipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::None
      )
      try {
        $pipe.Connect(1000)
      } catch [TimeoutException] {
        $pipe.Dispose()
        Start-Sleep -Milliseconds 250
        continue
      } catch [IO.IOException] {
        $pipe.Dispose()
        Start-Sleep -Milliseconds 250
        continue
      }
      if (-not (Test-BrokerClient -Pipe $pipe)) {
        $pipe.Dispose()
        Start-Sleep -Seconds 1
        continue
      }
      Write-BrokerLog 'connected to LLMPET'
      $encoding = New-Object System.Text.UTF8Encoding($false)
      $reader = New-Object System.IO.StreamReader($pipe, $encoding, $false, 4096, $true)
      $writer = New-Object System.IO.StreamWriter($pipe, $encoding, 4096, $true)
      $writer.AutoFlush = $true
      while ($pipe.IsConnected -and -not $script:StopRequested) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { break }
        $writer.WriteLine((Invoke-BrokerRequest -Line $line))
      }
    } catch {
      Write-BrokerLog ("request failed: " + $_.Exception.Message)
      try { if ($writer) { $writer.WriteLine((ConvertTo-BrokerResult -Ok $false -Reason 'broker-failed')) } } catch {}
    } finally {
      try { if ($writer) { $writer.Dispose() } } catch {}
      try { if ($reader) { $reader.Dispose() } } catch {}
      try { if ($pipe) { $pipe.Dispose() } } catch {}
    }
  }
} finally {
  Write-BrokerLog 'broker stopped'
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
