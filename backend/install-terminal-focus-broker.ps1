param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Mode,

  [string]$InstallRoot,

  [string]$ClientPath,

  [string]$ProfilePath,

  [int]$CallerProcessId = 0,

  [string]$TargetUserName,

  [string]$TargetUserSid,

  [switch]$NoLaunch,

  [switch]$SelfTest,

  [switch]$Elevated,

  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ProfileKey {
  param([string]$Path)
  $normalized = [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').Substring(0, 12).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function ConvertTo-TaskArgument {
  param([string]$Value)
  if ($Value.Contains('"')) { throw 'Task argument contains an invalid quote.' }
  return '"' + $Value + '"'
}

function ConvertTo-SingleQuotedLiteral {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Publish-Result {
  param([bool]$Ok, [string]$Reason, [string]$State = '')
  $json = [pscustomobject]@{
    ok = $Ok
    reason = $Reason
    state = $State
    taskName = $TaskName
    taskPath = $TaskPath
    taskUser = $TargetUserName
    taskUserSid = $TargetUserSid
    profilePath = $ResolvedProfile
    pipeName = $PipeName
    elevationRequired = -not (Test-IsAdministrator)
  } | ConvertTo-Json -Compress
  if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    Set-Content -LiteralPath $ResultPath -Encoding UTF8 -Value $json
  }
  Write-Output $json
}

$launchIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ([string]::IsNullOrWhiteSpace($TargetUserName)) { $TargetUserName = $launchIdentity.Name }
if ([string]::IsNullOrWhiteSpace($TargetUserSid)) { $TargetUserSid = $launchIdentity.User.Value }
if ($TargetUserSid -notmatch '^S-1-(?:\d+-){1,14}\d+$') { throw 'Target user SID is invalid.' }
if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $ProfilePath = [Environment]::GetFolderPath('UserProfile')
}
$ResolvedProfile = [IO.Path]::GetFullPath($ProfilePath).TrimEnd('\')
$ProfileKey = Get-ProfileKey -Path $ResolvedProfile
$TaskName = "LLMPET Terminal Focus Broker ($ProfileKey)"
$TaskPath = '\'
$PipeName = "LLMPET.TerminalFocus.v1.$ProfileKey"
$LogPath = Join-Path $ResolvedProfile 'AppData\Local\LLMPET\terminal-focus-broker.log'

function Invoke-ElevatedRegistration {
  $temporaryResult = Join-Path $env:TEMP ('llmpet-terminal-focus-' + [Guid]::NewGuid().ToString('N') + '.json')
  $parts = @(
    '&', (ConvertTo-SingleQuotedLiteral $PSCommandPath),
    '-Mode', (ConvertTo-SingleQuotedLiteral $Mode),
    '-InstallRoot', (ConvertTo-SingleQuotedLiteral $InstallRoot),
    '-ClientPath', (ConvertTo-SingleQuotedLiteral $ClientPath),
    '-ProfilePath', (ConvertTo-SingleQuotedLiteral $ResolvedProfile),
    '-CallerProcessId', [string]$CallerProcessId,
    '-TargetUserName', (ConvertTo-SingleQuotedLiteral $TargetUserName),
    '-TargetUserSid', (ConvertTo-SingleQuotedLiteral $TargetUserSid),
    '-ResultPath', (ConvertTo-SingleQuotedLiteral $temporaryResult),
    '-Elevated'
  )
  if ($NoLaunch) { $parts += '-NoLaunch' }
  $command = $parts -join ' '
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  try {
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $process = Start-Process -FilePath $powershellPath -Verb RunAs -WindowStyle Hidden -Wait -PassThru `
      -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand)
    if (Test-Path -LiteralPath $temporaryResult -PathType Leaf) {
      Write-Output (Get-Content -LiteralPath $temporaryResult -Raw -Encoding UTF8).Trim()
      exit $process.ExitCode
    }
    Publish-Result -Ok $false -Reason $(if ($process.ExitCode -eq 0) { 'elevated-result-missing' } else { 'elevation-failed' })
    exit $(if ($process.ExitCode -eq 0) { 1 } else { $process.ExitCode })
  } catch {
    Publish-Result -Ok $false -Reason 'elevation-cancelled'
    exit 2
  } finally {
    if (Test-Path -LiteralPath $temporaryResult) {
      Remove-Item -LiteralPath $temporaryResult -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($SelfTest) {
  if ([string]::IsNullOrWhiteSpace($InstallRoot)) { throw 'InstallRoot is required.' }
  if ([string]::IsNullOrWhiteSpace($ClientPath)) { throw 'ClientPath is required.' }
  Publish-Result -Ok $true -Reason 'self-test-passed' -State 'NotRegistered'
  exit 0
}

if ($CallerProcessId -le 0) { throw 'CallerProcessId is required.' }
if (-not $Elevated -and -not (Test-IsAdministrator)) {
  Invoke-ElevatedRegistration
}
if ($Elevated -and -not (Test-IsAdministrator)) {
  Publish-Result -Ok $false -Reason 'elevation-required'
  exit 1
}

# The target identity was captured before UAC. Validate it against the still-
# running LLMPET process, so alternate administrator credentials cannot retarget
# the task to the administrator account or a different desktop session.
try {
  $caller = Get-CimInstance Win32_Process -Filter "ProcessId=$CallerProcessId" -ErrorAction Stop
  $owner = Invoke-CimMethod -InputObject $caller -MethodName GetOwnerSid -ErrorAction Stop
  if (-not [string]::Equals([string]$owner.Sid, $TargetUserSid, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Caller owner does not match the target user.'
  }
  $currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  if ([int]$caller.SessionId -ne $currentSessionId) { throw 'Caller is in a different Windows session.' }
} catch {
  Publish-Result -Ok $false -Reason 'caller-validation-failed'
  exit 1
}

function Get-BrokerTask {
  Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Remove-BrokerTask {
  $existing = Get-BrokerTask
  if (-not $existing) { return }
  try { Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch {}
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
}

if ($Mode -eq 'status') {
  $existing = Get-BrokerTask
  Publish-Result -Ok ([bool]$existing) -Reason $(if ($existing) { 'installed' } else { 'not-installed' }) `
    -State $(if ($existing) { [string]$existing.State } else { '' })
  exit $(if ($existing) { 0 } else { 1 })
}

if ($Mode -eq 'uninstall') {
  Remove-BrokerTask
  Publish-Result -Ok $true -Reason 'uninstalled'
  exit 0
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { throw 'InstallRoot is required.' }
if ([string]::IsNullOrWhiteSpace($ClientPath)) { throw 'ClientPath is required.' }
$resolvedRoot = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).Path.TrimEnd('\')
$resolvedClient = (Resolve-Path -LiteralPath $ClientPath -ErrorAction Stop).Path
$brokerPath = Join-Path $resolvedRoot 'backend\terminal-focus-broker.ps1'
$launcherPath = Join-Path $resolvedRoot 'backend\terminal-focus-broker-launcher.ps1'
$helperPath = Join-Path $resolvedRoot 'backend\focus-windows-terminal.ps1'
foreach ($requiredPath in @($brokerPath, $launcherPath, $helperPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required broker file is missing: $requiredPath" }
  if (-not $requiredPath.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Broker path escaped the installation root.'
  }
}

$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = @(
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-WindowStyle', 'Hidden',
  '-File', (ConvertTo-TaskArgument $launcherPath),
  '-BrokerPath', (ConvertTo-TaskArgument $brokerPath),
  '-ExpectedClientPath', (ConvertTo-TaskArgument $resolvedClient),
  '-PipeName', (ConvertTo-TaskArgument $PipeName),
  '-LogPath', (ConvertTo-TaskArgument $LogPath)
) -join ' '

Remove-BrokerTask
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $resolvedRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $TargetUserSid
$principal = New-ScheduledTaskPrincipal -UserId $TargetUserSid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "Optional LLMPET Terminal focus launcher for $TargetUserName ($TargetUserSid)."
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null

if (-not $NoLaunch) { Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath }
$registered = Get-BrokerTask
Publish-Result -Ok ([bool]$registered) -Reason $(if ($NoLaunch) { 'installed-not-started' } else { 'installed-started' }) `
  -State $(if ($registered) { [string]$registered.State } else { '' })
if (-not $registered) { exit 1 }
