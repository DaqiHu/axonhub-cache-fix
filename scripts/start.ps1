param(
  [switch]$NoCacheFix,
  [switch]$Status,
  [switch]$Once,
  [int]$StartupTimeoutSeconds = 180,
  [string]$Dir = "$env:USERPROFILE\axonhub",
  [switch]$NoCPA,
  [string]$CPADir = "$env:USERPROFILE\cpa-proxy"
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SupervisorPath = Join-Path $RepoDir "scripts\supervise.ps1"
$HealthPath = Join-Path $RepoDir "scripts\runtime-health.ps1"
. "$RepoDir\scripts\runtime-common.ps1"

if ($Status) {
  & $HealthPath -Dir $Dir
  exit $LASTEXITCODE
}

New-Item -ItemType Directory -Path (Join-Path $Dir "logs") -Force | Out-Null

if ($Once) {
  . $SupervisorPath
  $eventLog = Join-Path $Dir "logs\supervisor.jsonl"
  if (-not (Get-ListeningProcessId -Port 8090)) {
    $null = Start-AxonHubChild -Dir $Dir -EventLog $eventLog
  }
  if (-not $NoCacheFix -and -not (Get-ListeningProcessId -Port 19801)) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Get-ListeningProcessId -Port 8090) -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 250
    }
    $null = Start-CacheFixChild -Dir $Dir -EventLog $eventLog
  }
  if (-not $NoCPA -and -not (Get-ListeningProcessId -Port 8317)) {
    $null = Start-CPAChild -CpaDir $CPADir -EventLog $eventLog
  }
  Start-Sleep -Seconds 3
  & $HealthPath -Dir $Dir -AllowStopped:$NoCacheFix
  exit $LASTEXITCODE
}

$supervisorPid = Get-SupervisorProcessId -ScriptPath $SupervisorPath
if ($supervisorPid) {
  Write-Host "Supervisor already running (PID $supervisorPid)."
} else {
  $stdout = Get-RedirectLogPath -Path (Join-Path $Dir "logs\supervisor-stdout.log")
  $stderr = Get-RedirectLogPath -Path (Join-Path $Dir "logs\supervisor-stderr.log")
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$SupervisorPath`"",
    "-Dir", "`"$Dir`"",
    "-CPADir", "`"$CPADir`""
  )
  if ($NoCacheFix) { $arguments += "-NoCacheFix" }
  if ($NoCPA) { $arguments += "-NoCPA" }
  $process = Start-ManagedProcess `
    -FilePath $powershell `
    -ArgumentList $arguments `
    -WorkingDirectory $Dir `
    -StdoutPath $stdout `
    -StderrPath $stderr `
    -Hidden
  Write-Host "Supervisor launched (PID $($process.Id)), waiting for services..."
}

$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $StartupTimeoutSeconds))
$lastProgress = [DateTime]::MinValue
$progressInterval = [TimeSpan]::FromSeconds(1.5)
$prevAxonReady = $false
$prevCacheReady = [bool]$NoCacheFix
$prevCpaReady = [bool]$NoCPA

do {
  $axonReady = [bool](Get-ListeningProcessId -Port 8090)
  $cacheReady = [bool]$NoCacheFix
  if (-not $NoCacheFix -and (Get-ListeningProcessId -Port 19801)) {
    try {
      $cacheHealth = Invoke-RestMethod "http://127.0.0.1:19801/health" -TimeoutSec 3
      $cacheReady = Test-CacheFixHealthResponse -Response $cacheHealth
    } catch {
      $cacheReady = $false
    }
  }
  $cpaReady = [bool]$NoCPA
  if (-not $NoCPA -and (Get-ListeningProcessId -Port 8317)) {
    try {
      $cpaHealth = Invoke-RestMethod "http://127.0.0.1:8317/v1/models" -TimeoutSec 5 -Headers @{ "Authorization" = "Bearer cpa-local-key-2026" }
      $cpaReady = Test-CPAHealthResponse -StatusCode 200 -Body ($cpaHealth | ConvertTo-Json -Compress)
    } catch {
      $cpaReady = $false
    }
  }

  $stateChanged = ($axonReady -ne $prevAxonReady) -or ($cacheReady -ne $prevCacheReady) -or ($cpaReady -ne $prevCpaReady)
  $now = [DateTime]::UtcNow
  if ($stateChanged -or ($now - $lastProgress) -ge $progressInterval) {
    $elapsed = $now - $deadline.AddSeconds(-$StartupTimeoutSeconds)
    $pct = [Math]::Min(100, [Math]::Floor($elapsed.TotalSeconds / $StartupTimeoutSeconds * 100))
    $barW = 20
    $filled = [Math]::Floor($pct * $barW / 100)
    $bar = "[" + ("=" * $filled) + ">" + (" " * [Math]::Max(0, $barW - $filled - 1)) + "]"

    $parts = @()
    $parts += "$(if($axonReady){"[OK]"}else{"[..]"}) AxonHub"
    if (-not $NoCacheFix) { $parts += "$(if($cacheReady){"[OK]"}else{"[..]"}) cache-fix" }
    if (-not $NoCPA) { $parts += "$(if($cpaReady){"[OK]"}else{"[..]"}) CPA" }

    $line = "$bar $($pct)%  $($parts -join '  ')  ($([Math]::Floor($elapsed.TotalSeconds))s timeout=$($StartupTimeoutSeconds)s)"
    Write-Host -NoNewline "`r$($line.PadRight(120))"
    $lastProgress = $now
  }

  $prevAxonReady = $axonReady
  $prevCacheReady = $cacheReady
  $prevCpaReady = $cpaReady

  if ($axonReady -and $cacheReady) { break }
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)

Write-Host ""

if (-not $axonReady -or -not $cacheReady) {
  $waitSec = [Math]::Floor(([DateTime]::UtcNow - $deadline.AddSeconds(-$StartupTimeoutSeconds)).TotalSeconds)
  Write-Host "Timed out after ${waitSec}s (limit ${StartupTimeoutSeconds}s)." -ForegroundColor Yellow
}

& $HealthPath -Dir $Dir -AllowStopped:$NoCacheFix
exit $LASTEXITCODE
