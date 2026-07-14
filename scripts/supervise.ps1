param(
  [string]$Dir = "$env:USERPROFILE\axonhub",
  [int]$IntervalSeconds = 10,
  [switch]$NoCacheFix
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. "$RepoDir\scripts\runtime-common.ps1"

function Get-SupervisorMutexName {
  param([string]$Dir)
  $normalized = [System.IO.Path]::GetFullPath($Dir).ToLowerInvariant()
  $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "" }
  finally { $sha.Dispose() }
  return "Local\AxonHubCacheFixSupervisor-$($hash.Substring(0, 20))"
}

function Get-CacheFixEnvironment {
  param([string]$Dir)
  $logs = Join-Path $Dir "logs"
  return @{
    CACHE_FIX_PROXY_UPSTREAM = "http://127.0.0.1:8090"
    CACHE_FIX_EXTENSIONS_DIR = (Join-Path $Dir "extensions")
    CACHE_FIX_EXTENSIONS_CONFIG = (Join-Path $Dir "extensions\extensions.json")
    CACHE_FIX_DEBUG = "1"
    CACHE_FIX_DEBUG_LOG = (Join-Path $logs "cache-fix-debug.log")
    CACHE_FIX_UPSTREAM_ERROR_LOG = "on"
    CACHE_FIX_UPSTREAM_ERROR_LOG_PATH = (Join-Path $logs "upstream-errors.jsonl")
    CACHE_FIX_UPSTREAM_ERROR_BODY_LOG = "on"
    CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH = (Join-Path $logs "upstream-error-bodies.jsonl")
    AXONHUB_CACHE_FIX_LOG_DIR = $logs
  }
}

function Get-RotatableLogPaths {
  param([string]$Dir)
  $logs = Join-Path $Dir "logs"
  return @(
    "cache-fix-debug.log",
    "cache-fix-stderr.log",
    "cache-fix-stdout.log",
    "axonhub-stderr.log",
    "axonhub-stdout.log",
    "supervisor.jsonl",
    "supervisor-stdout.log",
    "supervisor-stderr.log",
    "upstream-errors.jsonl",
    "upstream-error-bodies.jsonl"
  ) | ForEach-Object { Join-Path $logs $_ }
}

function Test-CacheFixSupervisionAllowed {
  param($AxonHubListeningProcessId)
  return $null -ne $AxonHubListeningProcessId -and [int]$AxonHubListeningProcessId -gt 0
}

function Start-AxonHubChild {
  param([string]$Dir, [string]$EventLog)
  $exe = Join-Path $Dir "axonhub.exe"
  if (-not (Test-Path -LiteralPath $exe)) {
    Write-RuntimeEvent -Path $EventLog -Event "start_failed" -Service "axonhub" -Data @{ reason = "missing_executable" }
    return $null
  }
  $stdout = Get-RedirectLogPath -Path (Join-Path $Dir "logs\axonhub-stdout.log")
  $stderr = Get-RedirectLogPath -Path (Join-Path $Dir "logs\axonhub-stderr.log")
  $process = Start-ManagedProcess -FilePath $exe -WorkingDirectory $Dir -StdoutPath $stdout -StderrPath $stderr -Hidden
  Write-RuntimeEvent -Path $EventLog -Event "started" -Service "axonhub" -Data @{ pid = $process.Id }
  return $process
}

function Start-CacheFixChild {
  param([string]$Dir, [string]$EventLog)
  $node = (Get-Command node -ErrorAction Stop).Source
  $server = Join-Path $env:APPDATA "npm\node_modules\claude-code-cache-fix\proxy\server.mjs"
  $validator = Join-Path $RepoDir "scripts\validate-runtime.mjs"
  & $node $validator --dir $Dir | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-RuntimeEvent -Path $EventLog -Event "start_failed" -Service "cache-fix" -Data @{ reason = "invalid_runtime" }
    return $null
  }
  foreach ($entry in (Get-CacheFixEnvironment -Dir $Dir).GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
  }
  $stdout = Get-RedirectLogPath -Path (Join-Path $Dir "logs\cache-fix-stdout.log")
  $stderr = Get-RedirectLogPath -Path (Join-Path $Dir "logs\cache-fix-stderr.log")
  $process = Start-ManagedProcess -FilePath $node -ArgumentList @($server) -WorkingDirectory $Dir -StdoutPath $stdout -StderrPath $stderr -Hidden
  Write-RuntimeEvent -Path $EventLog -Event "started" -Service "cache-fix" -Data @{ pid = $process.Id }
  return $process
}

function Invoke-Supervisor {
  param([string]$Dir, [int]$IntervalSeconds, [switch]$NoCacheFix)
  New-Item -ItemType Directory -Path (Join-Path $Dir "logs") -Force | Out-Null
  $eventLog = Join-Path $Dir "logs\supervisor.jsonl"
  foreach ($path in (Get-RotatableLogPaths -Dir $Dir)) {
    if ($path -like "*stdout.log" -or $path -like "*stderr.log") { continue }
    try { $null = Rotate-LogFile -Path $path } catch {}
  }

  $createdNew = $false
  $mutex = New-Object Threading.Mutex($true, (Get-SupervisorMutexName -Dir $Dir), [ref]$createdNew)
  if (-not $createdNew) { return }
  Write-RuntimeEvent -Path $eventLog -Event "supervisor_started" -Service "supervisor" -Data @{ pid = $PID }

  $axonProcess = $null
  $cacheProcess = $null
  $axonAttempt = 0
  $cacheAttempt = 0
  $cacheHealthFailures = 0
  $nextAxonStart = [DateTime]::MinValue
  $nextCacheStart = [DateTime]::MinValue

  try {
    while ($true) {
      if ($axonProcess -and $axonProcess.HasExited) {
        $axonProcess.Refresh()
        Write-RuntimeEvent -Path $eventLog -Event "exited" -Service "axonhub" -Data @{ pid = $axonProcess.Id; exit_code = $axonProcess.ExitCode }
        $axonProcess = $null
      }
      if ($cacheProcess -and $cacheProcess.HasExited) {
        $cacheProcess.Refresh()
        Write-RuntimeEvent -Path $eventLog -Event "exited" -Service "cache-fix" -Data @{ pid = $cacheProcess.Id; exit_code = $cacheProcess.ExitCode }
        $cacheProcess = $null
      }

      $axonPid = Get-ListeningProcessId -Port 8090
      if ($axonPid) {
        $axonAttempt = 0
      } elseif ((Get-ServiceRecoveryDecision `
          -ListeningProcessId $axonPid `
          -ManagedProcessRunning ([bool]($axonProcess -and -not $axonProcess.HasExited))) -eq "restart" `
          -and [DateTime]::UtcNow -ge $nextAxonStart) {
        try { $axonProcess = Start-AxonHubChild -Dir $Dir -EventLog $eventLog } catch {
          Write-RuntimeEvent -Path $eventLog -Event "start_failed" -Service "axonhub" -Data @{ reason = $_.Exception.Message }
        }
        $delay = Get-RestartDelaySeconds -Attempt $axonAttempt
        $axonAttempt++
        $nextAxonStart = [DateTime]::UtcNow.AddSeconds($delay)
      }

      if (-not $NoCacheFix -and (Test-CacheFixSupervisionAllowed -AxonHubListeningProcessId $axonPid)) {
        $cachePid = Get-ListeningProcessId -Port 9801
        if ($cachePid) {
          try {
            $health = Invoke-RestMethod "http://127.0.0.1:9801/health" -TimeoutSec 3
            if (Test-CacheFixHealthResponse -Response $health) { $cacheHealthFailures = 0 }
            else { $cacheHealthFailures++ }
          } catch { $cacheHealthFailures++ }
          if ((Get-ServiceRecoveryDecision -ListeningProcessId $cachePid -HealthFailures $cacheHealthFailures) -eq "restart") {
            Write-RuntimeEvent -Path $eventLog -Event "health_restart" -Service "cache-fix" -Data @{ pid = $cachePid; failures = $cacheHealthFailures }
            Stop-Process -Id $cachePid -Force -ErrorAction SilentlyContinue
            $cacheHealthFailures = 0
          } else {
            $cacheAttempt = 0
          }
        } elseif ((Get-ServiceRecoveryDecision `
            -ListeningProcessId $cachePid `
            -ManagedProcessRunning ([bool]($cacheProcess -and -not $cacheProcess.HasExited))) -eq "restart" `
            -and [DateTime]::UtcNow -ge $nextCacheStart) {
          try { $cacheProcess = Start-CacheFixChild -Dir $Dir -EventLog $eventLog } catch {
            Write-RuntimeEvent -Path $eventLog -Event "start_failed" -Service "cache-fix" -Data @{ reason = $_.Exception.Message }
          }
          $delay = Get-RestartDelaySeconds -Attempt $cacheAttempt
          $cacheAttempt++
          $nextCacheStart = [DateTime]::UtcNow.AddSeconds($delay)
        }
      } elseif (-not $NoCacheFix) {
        $cacheHealthFailures = 0
      }
      Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds))
    }
  } finally {
    Write-RuntimeEvent -Path $eventLog -Event "supervisor_stopped" -Service "supervisor" -Data @{ pid = $PID }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}

if ($MyInvocation.InvocationName -ne ".") {
  Invoke-Supervisor -Dir $Dir -IntervalSeconds $IntervalSeconds -NoCacheFix:$NoCacheFix
}
