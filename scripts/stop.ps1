param([string]$Dir = "$env:USERPROFILE\axonhub")

$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. "$RepoDir\scripts\runtime-common.ps1"
$found = $false

$supervisorPath = Join-Path $RepoDir "scripts\supervise.ps1"
$supervisorPid = Get-SupervisorProcessId -ScriptPath $supervisorPath
if ($supervisorPid) {
  $childPids = @(Get-DescendantProcessIds -RootProcessId $supervisorPid)
  Stop-Process -Id $supervisorPid -Force -ErrorAction SilentlyContinue
  Write-Host "Supervisor (PID $supervisorPid) stopped."
  $found = $true
  Start-Sleep -Milliseconds 500
  foreach ($childPid in $childPids) {
    if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
      Write-Host "Supervisor child (PID $childPid) stopped."
    }
  }
} else {
  Write-Host "Supervisor is not running."
}

foreach ($service in @(
  @{ Port = 9801; Name = "cache-fix proxy" },
  @{ Port = 8090; Name = "AxonHub" },
  @{ Port = 8317; Name = "CPA (CLIProxyAPI)" }
)) {
  $processId = Get-ListeningProcessId -Port $service.Port
  if ($processId) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Write-Host "$($service.Name) (PID $processId) stopped."
    $found = $true
  } else {
    Write-Host "$($service.Name) is not running."
  }
}

if (-not $found) { Write-Host "No services were running." }
