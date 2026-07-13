param(
  [switch]$NoCacheFix,
  [switch]$Status,
  [string]$Dir = "$env:LOCALAPPDATA\axonhub-cache-fix"
)

$NodePath = "C:\Program Files\nodejs\node.exe"
$CacheFixServer = "$env:APPDATA\npm\node_modules\claude-code-cache-fix\proxy\server.mjs"

# --- Status ---
if ($Status) {
  Write-Host "`n=== Service Status ==="
  $c8090 = netstat -ano | Select-String "LISTENING" | Select-String ":8090\s"
  $c9801 = netstat -ano | Select-String "LISTENING" | Select-String ":9801\s"

  if ($c8090) { $p = ($c8090 -split '\s+')[-1]; Write-Host "  AxonHub   :8090   RUNNING (PID $p)" }
  else { Write-Host "  AxonHub   :8090   STOPPED" }

  if ($c9801) {
    $p = ($c9801 -split '\s+')[-1]; Write-Host "  cache-fix :9801   RUNNING (PID $p)"
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:9801/health" -TimeoutSec 3
      if ($h.status -eq "ok") { Write-Host "  cache-fix extensions: OK" }
      else { Write-Host "  cache-fix extensions: DEGRADED"; $h.failed_extensions | % { Write-Host "    FAILED: $($_.file)" } }
    } catch { Write-Host "  cache-fix /health: unreachable" }
  } else { Write-Host "  cache-fix :9801   STOPPED" }

  # Check custom extension logs
  $logDir = "$Dir\logs"
  if (Test-Path $logDir) {
    Get-ChildItem $logDir -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 5 | % {
      $last = Get-Content $_.FullName -Tail 1
      Write-Host "  $($_.Name): $last"
    }
  }
  Write-Host ""
  exit 0
}

# --- Start ---
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
New-Item -ItemType Directory -Path "$Dir\logs" -Force | Out-Null

Write-Host "=== AxonHub ==="
if (netstat -ano | Select-String "LISTENING" | Select-String ":8090\s") {
  Write-Host "  Already running on :8090"
} else {
  Write-Host "  Starting on :8090 ..."
  $axonhubExe = "$Dir\..\..\axonhub\axonhub.exe"
  if (Test-Path $axonhubExe) {
    Start-Process -WindowStyle Hidden -FilePath $axonhubExe -WorkingDirectory (Split-Path $axonhubExe)
  } else {
    Write-Host "  WARNING: AxonHub not found at $axonhubExe"
    Write-Host "  Make sure AxonHub is running on :8090"
  }
}

# --- cache-fix ---
Write-Host ""
if ($NoCacheFix) {
  Write-Host "  cache-fix skipped (-NoCacheFix)."
} else {
  if (-not (Test-Path $CacheFixServer)) {
    Write-Host "=== cache-fix ==="
    Write-Host "  ERROR: not found at $CacheFixServer"
    Write-Host "  Run: npm install -g claude-code-cache-fix"
    exit 1
  }

  Write-Host "=== cache-fix ==="
  if (netstat -ano | Select-String "LISTENING" | Select-String ":9801\s") {
    Write-Host "  Already running on :9801. Run .\stop.ps1 first to restart."
  } else {
    $env:CACHE_FIX_PROXY_UPSTREAM = "http://127.0.0.1:8090"
    $env:CACHE_FIX_EXTENSIONS_DIR = "$Dir\extensions"
    $env:CACHE_FIX_EXTENSIONS_CONFIG = "$Dir\extensions\extensions.json"
    $env:CACHE_FIX_DEBUG = "1"
    $env:AXONHUB_CACHE_FIX_LOG_DIR = "$Dir\logs"

    Write-Host "  Starting on :9801 ..."
    Write-Host "  Upstream: http://127.0.0.1:8090"
    Write-Host "  Extensions: $env:CACHE_FIX_EXTENSIONS_DIR"
    Write-Host "  Logs: $Dir\logs"

    Start-Process -WindowStyle Hidden -FilePath $NodePath `
      -ArgumentList $CacheFixServer `
      -WorkingDirectory $Dir `
      -RedirectStandardError "$Dir\logs\cache-fix-stderr.log"

    Start-Sleep 3
    if (netstat -ano | Select-String "LISTENING" | Select-String ":9801\s") {
      Write-Host "  cache-fix started successfully."
    } else {
      Write-Host "  FAILED! Check $Dir\logs\cache-fix-stderr.log"
    }
  }
}

Write-Host ""
Write-Host "Use .\stop.ps1 to stop | .\start.ps1 -Status to check"
