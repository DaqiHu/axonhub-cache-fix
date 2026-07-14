param(
  [string]$Dir = "$env:USERPROFILE\axonhub",
  [switch]$Json,
  [switch]$AllowStopped,
  [long]$WalWarningBytes = 1GB,
  [long]$WalCriticalBytes = 2GB,
  [long]$LogWarningBytes = 100MB
)

$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. "$RepoDir\scripts\runtime-common.ps1"

$axonPid = Get-ListeningProcessId -Port 8090
$cachePid = Get-ListeningProcessId -Port 9801
$cacheHealth = $null
if ($cachePid) {
  try { $cacheHealth = Invoke-RestMethod "http://127.0.0.1:9801/health" -TimeoutSec 3 } catch {}
}

$runtimeValid = $null
$configPath = Join-Path $Dir "extensions\extensions.json"
if (Test-Path -LiteralPath $configPath) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    & $node "$RepoDir\scripts\validate-runtime.mjs" --dir $Dir 2>$null | Out-Null
    $runtimeValid = $LASTEXITCODE -eq 0
  }
}

$storage = [ordered]@{
  db = Get-FileHealth -Path (Join-Path $Dir "axonhub.db") -WarningBytes ([long]::MaxValue) -CriticalBytes ([long]::MaxValue)
  wal = Get-FileHealth -Path (Join-Path $Dir "axonhub.db-wal") -WarningBytes $WalWarningBytes -CriticalBytes $WalCriticalBytes
  shm = Get-FileHealth -Path (Join-Path $Dir "axonhub.db-shm") -WarningBytes ([long]::MaxValue) -CriticalBytes ([long]::MaxValue)
}
$logHealth = @()
foreach ($path in @(
  (Join-Path $Dir "logs\cache-fix-debug.log"),
  (Join-Path $Dir "logs\cache-fix-stderr.log"),
  (Join-Path $Dir "logs\supervisor.jsonl"),
  (Join-Path $Dir "logs\upstream-errors.jsonl"),
  (Join-Path $Dir "logs\upstream-error-bodies.jsonl")
)) {
  $logHealth += Get-FileHealth -Path $path -WarningBytes $LogWarningBytes -CriticalBytes ($LogWarningBytes * 2)
}

$result = [ordered]@{
  runtime_valid = $runtimeValid
  services = [ordered]@{
    axonhub = [ordered]@{ running = [bool]$axonPid; pid = $axonPid }
    cache_fix = [ordered]@{
      running = [bool]$cachePid
      pid = $cachePid
      healthy = if ($cachePid) { Test-CacheFixHealthResponse -Response $cacheHealth } else { $false }
    }
  }
  storage = $storage
  logs = $logHealth
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8 -Compress
} else {
  Write-Host "`n=== Runtime Health ==="
  Write-Host "  AxonHub   :8090  $($(if($axonPid){"RUNNING pid=$axonPid"}else{"STOPPED"}))"
  Write-Host "  cache-fix :9801  $($(if($cachePid){"RUNNING pid=$cachePid healthy=$($result.services.cache_fix.healthy)"}else{"STOPPED"}))"
  if ($null -ne $runtimeValid) { Write-Host "  extensions       $($(if($runtimeValid){"VALID"}else{"INVALID"}))" }
  foreach ($entry in $storage.GetEnumerator()) {
    Write-Host ("  {0,-10} {1,10:N1} MiB  {2}" -f $entry.Key, ($entry.Value.Bytes / 1MB), $entry.Value.State)
  }
  foreach ($entry in $logHealth | Where-Object { $_.State -ne "ok" }) {
    Write-Host ("  log WARN  {0} {1:N1} MiB {2}" -f $entry.Path, ($entry.Bytes / 1MB), $entry.State)
  }
}

if (-not $AllowStopped -and (-not $axonPid -or -not $cachePid -or $result.services.cache_fix.healthy -ne $true)) { exit 1 }
if ($runtimeValid -eq $false) { exit 1 }
