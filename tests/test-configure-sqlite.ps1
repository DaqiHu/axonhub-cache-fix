$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent $PSScriptRoot
$Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("cache-fix-config-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Scratch | Out-Null

try {
  $config = @"
db:
  dialect: "sqlite3"
  dsn: "file:axonhub.db?cache=shared&_fk=1&_pragma=journal_mode(WAL)"
"@
  Set-Content -LiteralPath "$Scratch\config.yml" -Value $config -NoNewline
  & "$RepoDir\scripts\configure-sqlite.ps1" -Dir $Scratch -BusyTimeoutMs 10000 -SkipValidate
  if ($LASTEXITCODE -ne 0) { throw "first configure failed" }
  $first = Get-Content -Raw "$Scratch\config.yml"
  if ($first -notmatch '_pragma=busy_timeout\(10000\)') { throw "busy timeout missing" }
  if ($first -notmatch '_pragma=journal_mode\(WAL\)') { throw "journal mode lost" }
  if ($first -notmatch '_fk=1') { throw "foreign key setting lost" }

  & "$RepoDir\scripts\configure-sqlite.ps1" -Dir $Scratch -BusyTimeoutMs 10000 -SkipValidate
  if ($LASTEXITCODE -ne 0) { throw "second configure failed" }
  $second = Get-Content -Raw "$Scratch\config.yml"
  $matches = [regex]::Matches($second, '_pragma=busy_timeout\(10000\)')
  if ($matches.Count -ne 1) { throw "configuration is not idempotent" }
  Write-Host "PASS configures SQLite busy timeout idempotently"
} finally {
  Remove-Item -LiteralPath $Scratch -Recurse -Force
}
