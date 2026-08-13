param(
  [string]$OutputDirectory = (Join-Path $env:TEMP ('llmpet-terminal-focus-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))),

  [string]$WindowHandle,

  [string]$RuntimeId,

  [int]$ExpectedProcessId = 0,

  [switch]$SkipTaskLifecycle
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$Backend = Join-Path $RepoRoot 'backend'
$EvidencePath = Join-Path $OutputDirectory 'evidence.jsonl'
$SessionTestLog = Join-Path $OutputDirectory 'session-focus.log'
$Installer = Join-Path $Backend 'install-terminal-focus-broker.ps1'
$Launcher = Join-Path $Backend 'terminal-focus-broker-launcher.ps1'
$Broker = Join-Path $Backend 'terminal-focus-broker.ps1'
$CaptureHelper = Join-Path $Backend 'capture-windows-terminal-tab.ps1'
$FocusHelper = Join-Path $Backend 'focus-windows-terminal.ps1'
$PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ClientPath = (Get-Command node.exe -ErrorAction Stop).Source
$ValidationProfile = Join-Path $OutputDirectory 'validation-profile'

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Write-Evidence {
  param([string]$Check, [string]$Status, [object]$Details)
  [pscustomobject]@{
    timestamp = [DateTime]::UtcNow.ToString('O')
    check = $Check
    status = $Status
    details = $Details
  } | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath $EvidencePath -Encoding UTF8
}

function Invoke-ScriptFile {
  param([string]$Path, [string[]]$Arguments)
  $output = @(& $PowerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Path @Arguments 2>&1)
  [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Read-LastJson {
  param([string]$Text)
  $line = @($Text -split '\r?\n' | Where-Object { $_ })[-1]
  return $line | ConvertFrom-Json
}

Write-Evidence -Check 'environment' -Status 'observed' -Details ([pscustomobject]@{
  user = $CurrentIdentity.Name
  userSid = $CurrentIdentity.User.Value
  windowsSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  clientPath = $ClientPath
})

$nodeOutput = @(& $ClientPath (Join-Path $RepoRoot 'test\session-focus.js') 2>&1)
$nodeExitCode = $LASTEXITCODE
$nodeOutput | Set-Content -LiteralPath $SessionTestLog -Encoding UTF8
Write-Evidence -Check 'protocol-reconnect-tests' -Status $(if ($nodeExitCode -eq 0) { 'passed' } else { 'failed' }) `
  -Details ([pscustomobject]@{ exitCode = $nodeExitCode; log = (Split-Path -Leaf $SessionTestLog) })
if ($nodeExitCode -ne 0) { throw "session-focus.js failed with exit code $nodeExitCode" }

$profileKey = ([Security.Cryptography.SHA256]::Create().ComputeHash(
  [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($ValidationProfile).TrimEnd('\').ToLowerInvariant())
) | ForEach-Object { $_.ToString('x2') }) -join ''
$pipeName = 'LLMPET.TerminalFocus.v1.' + $profileKey.Substring(0, 12)
$logPath = Join-Path $OutputDirectory 'broker.log'

$installerSelfTest = Invoke-ScriptFile -Path $Installer -Arguments @(
  '-Mode', 'install', '-InstallRoot', $RepoRoot, '-ClientPath', $ClientPath,
  '-ProfilePath', $ValidationProfile, '-CallerProcessId', [string]$PID, '-NoLaunch', '-SelfTest'
)
$installerSelfTestJson = Read-LastJson -Text $installerSelfTest.Output
Write-Evidence -Check 'installer-self-test' -Status $(if ($installerSelfTest.ExitCode -eq 0 -and $installerSelfTestJson.ok) { 'passed' } else { 'failed' }) `
  -Details $installerSelfTestJson
if ($installerSelfTest.ExitCode -ne 0 -or -not $installerSelfTestJson.ok) { throw 'Installer self-test failed.' }

$launcherSelfTest = Invoke-ScriptFile -Path $Launcher -Arguments @(
  '-BrokerPath', $Broker, '-ExpectedClientPath', $ClientPath, '-PipeName', $pipeName,
  '-LogPath', $logPath, '-SelfTest'
)
$launcherSelfTestJson = Read-LastJson -Text $launcherSelfTest.Output
Write-Evidence -Check 'launcher-self-test' -Status $(if ($launcherSelfTest.ExitCode -eq 0 -and $launcherSelfTestJson.ok) { 'passed' } else { 'failed' }) `
  -Details $launcherSelfTestJson
if ($launcherSelfTest.ExitCode -ne 0 -or -not $launcherSelfTestJson.ok) { throw 'Launcher self-test failed.' }

$brokerSelfTest = Invoke-ScriptFile -Path $Broker -Arguments @('-SelfTest', '-LogPath', $logPath)
$brokerSelfTestJson = Read-LastJson -Text $brokerSelfTest.Output
Write-Evidence -Check 'broker-self-test' -Status $(if ($brokerSelfTest.ExitCode -eq 0 -and $brokerSelfTestJson.ok) { 'passed' } else { 'failed' }) `
  -Details $brokerSelfTestJson
if ($brokerSelfTest.ExitCode -ne 0 -or -not $brokerSelfTestJson.ok) { throw 'Broker self-test failed.' }

if (-not $SkipTaskLifecycle) {
  $registrationAttempted = $false
  try {
    $registrationAttempted = $true
    $installResult = Invoke-ScriptFile -Path $Installer -Arguments @(
      '-Mode', 'install', '-InstallRoot', $RepoRoot, '-ClientPath', $ClientPath,
      '-ProfilePath', $ValidationProfile, '-CallerProcessId', [string]$PID, '-NoLaunch'
    )
    $installJson = Read-LastJson -Text $installResult.Output
    if ($installResult.ExitCode -ne 0 -or -not $installJson.ok) { throw 'Task registration failed.' }
    $task = Get-ScheduledTask -TaskName $installJson.taskName -TaskPath $installJson.taskPath -ErrorAction Stop
    $taskUserSid = if ([string]$task.Principal.UserId -match '^S-1-') {
      [string]$task.Principal.UserId
    } else {
      ([Security.Principal.NTAccount]::new([string]$task.Principal.UserId)).Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
    }
    $validTask = (
      $taskUserSid -eq $CurrentIdentity.User.Value -and
      [string]$task.Principal.RunLevel -eq 'Limited' -and
      [string]$task.Principal.LogonType -eq 'Interactive' -and
      [string]$task.Actions[0].Arguments -like '*terminal-focus-broker-launcher.ps1*'
    )
    Write-Evidence -Check 'per-user-task-registration' -Status $(if ($validTask) { 'passed' } else { 'failed' }) `
      -Details ([pscustomobject]@{
        taskName = $installJson.taskName
        expectedUserSid = $CurrentIdentity.User.Value
        actualUserId = $task.Principal.UserId
        actualUserSid = $taskUserSid
        runLevel = [string]$task.Principal.RunLevel
        logonType = [string]$task.Principal.LogonType
        usesLauncher = ([string]$task.Actions[0].Arguments -like '*terminal-focus-broker-launcher.ps1*')
      })
    if (-not $validTask) { throw 'Registered task is not bound to the actual LLMPET user at limited integrity.' }
  } finally {
    if ($registrationAttempted) {
      $uninstallResult = Invoke-ScriptFile -Path $Installer -Arguments @(
        '-Mode', 'uninstall', '-InstallRoot', $RepoRoot, '-ClientPath', $ClientPath,
        '-ProfilePath', $ValidationProfile, '-CallerProcessId', [string]$PID
      )
      $uninstallJson = Read-LastJson -Text $uninstallResult.Output
      Write-Evidence -Check 'task-cleanup' -Status $(if ($uninstallResult.ExitCode -eq 0 -and $uninstallJson.ok) { 'passed' } else { 'failed' }) `
        -Details $uninstallJson
    }
  }
}

if ($WindowHandle -and $RuntimeId -and $ExpectedProcessId -gt 0) {
  $capture = Invoke-ScriptFile -Path $CaptureHelper -Arguments @('-ExpectedProcessId', [string]$ExpectedProcessId)
  $focus = Invoke-ScriptFile -Path $FocusHelper -Arguments @('-WindowHandle', $WindowHandle, '-RuntimeId', $RuntimeId)
  $captureJson = Read-LastJson -Text $capture.Output
  $focusJson = Read-LastJson -Text $focus.Output
  Write-Evidence -Check 'exact-tab-focus' -Status $(if ($captureJson.ok -and $focusJson.ok) { 'passed' } else { 'failed' }) `
    -Details ([pscustomobject]@{ expectedProcessId = $ExpectedProcessId; capture = $captureJson; focus = $focusJson })
  if (-not $captureJson.ok -or -not $focusJson.ok) { throw 'Exact-tab focus reproduction failed.' }
} else {
  $negativeCapture = Invoke-ScriptFile -Path $CaptureHelper -Arguments @('-ExpectedProcessId', [string]$PID, '-TimeoutMs', '250')
  $negativeJson = Read-LastJson -Text $negativeCapture.Output
  $rejected = -not $negativeJson.ok -and @(
    'foreground-session-mismatch', 'terminal-not-foreground', 'foreground-unavailable'
  ).Contains([string]$negativeJson.reason)
  Write-Evidence -Check 'foreground-correlation-negative' -Status $(if ($rejected) { 'passed' } else { 'failed' }) `
    -Details $negativeJson
  if (-not $rejected) { throw 'Capture helper did not reject an unrelated foreground process.' }
}

Write-Evidence -Check 'validation' -Status 'passed' -Details ([pscustomobject]@{ outputDirectory = $OutputDirectory })
Write-Output $OutputDirectory
