$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent $PSScriptRoot
. "$RepoDir\scripts\runtime-common.ps1"
. "$RepoDir\scripts\supervise.ps1"

$script:Passed = 0
$script:Failed = 0
function Test-Case([string]$Name, [scriptblock]$Body) {
  try { & $Body; $script:Passed++; Write-Host "PASS $Name" }
  catch { $script:Failed++; Write-Host "FAIL $Name`: $($_.Exception.Message)" }
}
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ($Actual -ne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }

$Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("cache-fix-service-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path "$Scratch\logs" -Force | Out-Null
try {
  Test-Case "supervisor mutex is stable per runtime directory" {
    $first = Get-SupervisorMutexName -Dir $Scratch
    $second = Get-SupervisorMutexName -Dir $Scratch
    $other = Get-SupervisorMutexName -Dir "$Scratch-other"
    Assert-Equal $first $second "mutex changed"
    Assert-True ($first -ne $other) "different runtimes collide"
  }

  Test-Case "cache-fix environment enables bounded operational logs" {
    $environment = Get-CacheFixEnvironment -Dir $Scratch
    Assert-Equal $environment.CACHE_FIX_UPSTREAM_ERROR_LOG "on" "status log gate"
    Assert-Equal $environment.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG "on" "body log gate"
    Assert-True ($environment.CACHE_FIX_DEBUG_LOG -like "$Scratch*") "debug log outside runtime"
    Assert-True ($environment.CACHE_FIX_UPSTREAM_ERROR_LOG_PATH -like "$Scratch*") "error log outside runtime"
  }

  Test-Case "rotatable logs include every unbounded runtime stream" {
    $paths = @(Get-RotatableLogPaths -Dir $Scratch)
    foreach ($name in @("cache-fix-debug.log", "cache-fix-stderr.log", "cache-fix-stdout.log", "supervisor.jsonl", "supervisor-stdout.log", "supervisor-stderr.log", "upstream-errors.jsonl", "upstream-error-bodies.jsonl")) {
      Assert-True ($paths -contains (Join-Path "$Scratch\logs" $name)) "missing $name"
    }
  }

  Test-Case "cache-fix health accepts only ok without failed extensions" {
    Assert-Equal (Test-CacheFixHealthResponse -Response ([pscustomobject]@{ status = "ok"; failed_extensions = @() })) $true "healthy rejected"
    Assert-Equal (Test-CacheFixHealthResponse -Response ([pscustomobject]@{ status = "degraded"; failed_extensions = @("x") })) $false "degraded accepted"
  }

  Test-Case "cache-fix supervision waits for AxonHub listener" {
    Assert-Equal (Test-CacheFixSupervisionAllowed -AxonHubListeningProcessId $null) $false "missing upstream allowed"
    Assert-Equal (Test-CacheFixSupervisionAllowed -AxonHubListeningProcessId 42) $true "ready upstream rejected"
  }

  Test-Case "runtime health JSON reports WAL threshold without mutating files" {
    Set-Content -LiteralPath "$Scratch\axonhub.db" -Value "db" -NoNewline
    Set-Content -LiteralPath "$Scratch\axonhub.db-wal" -Value ("x" * 20) -NoNewline
    $before = (Get-Item "$Scratch\axonhub.db-wal").Length
    $json = & "$RepoDir\scripts\runtime-health.ps1" -Dir $Scratch -Json -AllowStopped -WalWarningBytes 10 -WalCriticalBytes 30
    $result = $json | ConvertFrom-Json
    Assert-Equal $result.storage.wal.state "warning" "wal state"
    Assert-Equal (Get-Item "$Scratch\axonhub.db-wal").Length $before "health mutated WAL"
  }

  Test-Case "cache-fix environment includes low-cache trace defaults" {
    $environment = Get-CacheFixEnvironment -Dir $Scratch
    Assert-Equal $environment.CACHE_FIX_LOW_CACHE_TRACE "on" "trace gate off"
    Assert-Equal $environment.CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD "80" "wrong threshold"
    Assert-Equal $environment.CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS "7" "wrong retention"
    Assert-True ($environment.CACHE_FIX_LOW_CACHE_TRACE_DIR -like "$Scratch\logs\low-cache-requests*") "trace dir outside logs"
  }
} finally {
  Remove-Item -LiteralPath $Scratch -Recurse -Force
}

Write-Host "`nService scripts: $script:Passed passed, $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
