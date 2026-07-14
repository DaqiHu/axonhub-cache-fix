param(
  [string]$Dir = "$env:USERPROFILE\axonhub",
  [switch]$Execute,
  [switch]$Vacuum
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. "$RepoDir\scripts\runtime-common.ps1"

$db = Join-Path $Dir "axonhub.db"
if (-not (Test-Path -LiteralPath $db)) { throw "DB not found: $db" }
if ($Vacuum -and -not $Execute) { throw "-Vacuum requires -Execute" }

if ($Execute) {
  $active = @(8090, 9801 | Where-Object { Get-ListeningProcessId -Port $_ })
  if (-not (Test-MaintenanceAllowed -ListeningPorts $active)) {
    throw "Offline maintenance requires ports 8090 and 9801 to be stopped. Run scripts\stop.ps1 first."
  }
}

$python = (Get-Command python -ErrorAction Stop).Source
$arguments = @("$RepoDir\scripts\sqlite-maintenance.py", "--db", $db)
if ($Execute) {
  $arguments += @("--execute", "--backup-dir", (Join-Path $Dir "backups"))
  if ($Vacuum) { $arguments += "--vacuum" }
}
& $python @arguments
exit $LASTEXITCODE
