param(
  [Parameter(Mandatory = $true)]
  [string]$BrokerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedClientPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^LLMPET\.TerminalFocus\.v1\.[a-f0-9]{12}$')]
  [string]$PipeName,

  [Parameter(Mandatory = $true)]
  [string]$LogPath,

  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-SingleQuotedLiteral {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-LauncherLog {
  param([string]$Message)
  try {
    $directory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ('[{0:O}] launcher {1}' -f [DateTime]::UtcNow, $Message)
  } catch {}
}

$resolvedBroker = (Resolve-Path -LiteralPath $BrokerPath -ErrorAction Stop).Path
$resolvedClient = (Resolve-Path -LiteralPath $ExpectedClientPath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolvedBroker -PathType Leaf)) { throw 'Broker script is missing.' }

$command = @(
  '&', (ConvertTo-SingleQuotedLiteral $resolvedBroker),
  '-ExpectedClientPath', (ConvertTo-SingleQuotedLiteral $resolvedClient),
  '-PipeName', (ConvertTo-SingleQuotedLiteral $PipeName),
  '-LogPath', (ConvertTo-SingleQuotedLiteral ([IO.Path]::GetFullPath($LogPath)))
) -join ' '
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

if ($SelfTest) {
  [pscustomobject]@{ ok = $true; reason = 'self-test-passed'; pipeName = $PipeName } | ConvertTo-Json -Compress
  exit 0
}

Write-LauncherLog 'requesting elevation for optional broker'
try {
  $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $process = Start-Process -FilePath $powershellPath -Verb RunAs -WindowStyle Hidden -Wait -PassThru `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand)
  Write-LauncherLog ("elevated broker exited code=" + $process.ExitCode)
  exit $process.ExitCode
} catch {
  Write-LauncherLog ("elevation cancelled or failed: " + $_.Exception.Message)
  exit 2
}
