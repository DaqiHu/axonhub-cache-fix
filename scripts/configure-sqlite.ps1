param(
  [string]$Dir = "$env:USERPROFILE\axonhub",
  [int]$BusyTimeoutMs = 10000,
  [switch]$SkipValidate
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $Dir "config.yml"
if (-not (Test-Path -LiteralPath $configPath)) { throw "Config not found: $configPath" }
if ($BusyTimeoutMs -lt 1000) { throw "BusyTimeoutMs must be at least 1000" }

$content = [IO.File]::ReadAllText($configPath)
if ($content -notmatch '(?m)^\s*dialect:\s*["'']?sqlite3["'']?\s*$') {
  Write-Host "Non-SQLite database; no DSN change required."
  exit 0
}

$match = [regex]::Match($content, '(?m)^(\s*dsn:\s*["''])([^"'']+)(["'']\s*)$')
if (-not $match.Success) { throw "SQLite DSN line not found in $configPath" }

$dsn = $match.Groups[2].Value
$dsn = [regex]::Replace($dsn, '&?_pragma=busy_timeout\(\d+\)', '')
$separator = if ($dsn.Contains('?')) { '&' } else { '?' }
$dsn = "$dsn$separator`_pragma=busy_timeout($BusyTimeoutMs)"
$replacement = $match.Groups[1].Value + $dsn + $match.Groups[3].Value
$updated = $content.Substring(0, $match.Index) + $replacement + $content.Substring($match.Index + $match.Length)

if ($updated -ne $content) {
  Copy-Item -LiteralPath $configPath -Destination "$configPath.bak" -Force
  [IO.File]::WriteAllText($configPath, $updated, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Configured SQLite busy timeout: ${BusyTimeoutMs}ms"
} else {
  Write-Host "SQLite busy timeout already configured: ${BusyTimeoutMs}ms"
}

if (-not $SkipValidate) {
  $axonhub = Join-Path $Dir "axonhub.exe"
  if (-not (Test-Path -LiteralPath $axonhub)) { throw "AxonHub executable not found: $axonhub" }
  Push-Location $Dir
  try { & $axonhub config validate }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath "$configPath.bak" -Destination $configPath -Force
    throw "AxonHub rejected updated config; restored config.yml.bak"
  }
}

exit 0
