[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "Full")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$reportDir = Join-Path $root "reports"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $reportDir ("milktv-health-{0}-{1}.json" -f $Mode.ToLowerInvariant(), $timestamp)
$preflightIds = "351,17,18,19,20"

if ($Mode -eq "Full") {
  $confirmation = Read-Host "Type RUN to start the full canonical MILK TV health sweep"
  if ($confirmation -cne "RUN") {
    Write-Host "Full health sweep was not started."
    exit 0
  }

  Write-Host "Creating safety snapshot before Full..."
  & $node (Join-Path $root "scripts\snapshot-autonomous-operations-v1.js")
  if ($LASTEXITCODE -ne 0) {
    throw "Safety snapshot failed; Full was not started."
  }
}

New-Item -ItemType Directory -Path $reportDir -Force | Out-Null

# Values are scoped to this launcher process and inherited only by its Node
# child.  They are restored before PowerShell returns and never edit .env.
$temporaryEnvironment = @{
  MILKTV_HEALTH_CLI = "true"
  MILKTV_BACKGROUND_HEALTH_ENABLED = "false"
  MILKTV_AUTOPILOT_ENABLED = "false"
  MILKTV_HEALTH_REPORT_PATH = $reportPath
  MILKTV_HEALTH_RUN_MODE = $Mode.ToLowerInvariant()
}
if ($Mode -eq "Preflight") {
  $temporaryEnvironment.MILKTV_HEALTH_LIMIT = "5"
  $temporaryEnvironment.MILKTV_HEALTH_CHANNEL_IDS = $preflightIds
} else {
  $temporaryEnvironment.MILKTV_HEALTH_LIMIT = ""
  $temporaryEnvironment.MILKTV_HEALTH_CHANNEL_IDS = ""
}

# An inherited test hook must never make a host run simulated.
$temporaryEnvironment.MILKTV_HEALTH_TEST_FORCE_SOURCE_TIMEOUT_CHANNEL_ID = ""
$savedEnvironment = @{}
foreach ($entry in $temporaryEnvironment.GetEnumerator()) {
  $savedEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}

try {
  Write-Host "Starting canonical MILK TV health: $Mode"
  if ($Mode -eq "Preflight") {
    Write-Host "Fixed channels: $preflightIds"
  }
  & $node (Join-Path $root "server.js")
  $nodeExitCode = $LASTEXITCODE
} finally {
  foreach ($entry in $savedEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
  }
}

if (Test-Path $reportPath) {
  $report = Get-Content -Raw $reportPath | ConvertFrom-Json
  Write-Host ""
  Write-Host "JSON REPORT: $reportPath"
  Write-Host ("SELECTED: {0}" -f $report.total)
  Write-Host ("COMPLETED: {0}" -f $report.checked)
  Write-Host ("ONLINE: {0}" -f $report.online)
  Write-Host ("OFFLINE: {0}" -f $report.offline)
  Write-Host ("UNKNOWN: {0}" -f $report.unknown)
  Write-Host ("TIMEOUTS: {0}" -f $report.timeouts)
  Write-Host ("DB ERRORS: {0}" -f $report.db_errors)
  Write-Host ("CIRCUIT BREAKER: {0}" -f $(if ($report.circuit_breaker) { $report.circuit_breaker } else { "not_triggered" }))

  if ($Mode -eq "Preflight") {
    foreach ($channel in $report.selected) {
      if ($channel.milktv_status -eq "unknown") {
        Write-Host ("UNKNOWN channel={0} source={1} reason={2}" -f $channel.id, $channel.current_source_id, $channel.milktv_check_error)
      }
    }
    $readyForFull = $report.online -ge 2 -and $report.online -gt 0 -and -not $report.circuit_breaker
    Write-Host ("READY_FOR_FULL: {0}" -f $(if ($readyForFull) { "YES" } else { "NO" }))
  }
}

exit $nodeExitCode
