$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $PSScriptRoot
. "$RepoDir\scripts\runtime-common.ps1"

$script:Passed = 0
$script:Failed = 0

function Test-Case([string]$Name, [scriptblock]$Body) {
  try {
    & $Body
    $script:Passed++
    Write-Host "PASS $Name"
  } catch {
    $script:Failed++
    Write-Host "FAIL $Name`: $($_.Exception.Message)"
  }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "$Message (expected=$Expected actual=$Actual)"
  }
}

$Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("cache-fix-runtime-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Scratch | Out-Null

try {
  Test-Case "parses exact listening port pid" {
    $text = @"
  TCP    0.0.0.0:8090       0.0.0.0:0       LISTENING       1234
  TCP    0.0.0.0:18090      0.0.0.0:0       LISTENING       9999
"@
    Assert-Equal (Get-ListeningProcessIdFromText -Text $text -Port 8090) 1234 "wrong pid"
  }

  Test-Case "rotates oversized log and keeps bounded generations" {
    $path = Join-Path $Scratch "service.log"
    Set-Content -LiteralPath $path -Value ("x" * 20) -NoNewline
    Set-Content -LiteralPath "$path.1" -Value "old-one" -NoNewline
    Set-Content -LiteralPath "$path.2" -Value "old-two" -NoNewline
    $null = Rotate-LogFile -Path $path -MaxBytes 10 -Keep 2
    Assert-Equal (Test-Path -LiteralPath $path) $false "active file should rotate"
    Assert-Equal (Get-Content -Raw -LiteralPath "$path.1") ("x" * 20) "current log not moved"
    Assert-Equal (Get-Content -Raw -LiteralPath "$path.2") "old-one" "generation shift wrong"
    Assert-Equal (Test-Path -LiteralPath "$path.3") $false "too many generations kept"
  }

  Test-Case "redirect log falls back when the current file is locked" {
    $path = Join-Path $Scratch "locked.log"
    Set-Content -LiteralPath $path -Value "held" -NoNewline
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      $redirect = Get-RedirectLogPath -Path $path
      Assert-Equal ($redirect -ne $path) $true "locked path reused"
      Assert-Equal ($redirect.StartsWith("$path.")) $true "fallback path is unrelated"
    } finally {
      $stream.Dispose()
    }
  }

  Test-Case "restart delay is capped" {
    Assert-Equal (Get-RestartDelaySeconds -Attempt 0) 1 "attempt zero"
    Assert-Equal (Get-RestartDelaySeconds -Attempt 3) 8 "attempt three"
    Assert-Equal (Get-RestartDelaySeconds -Attempt 20) 60 "cap"
  }

  Test-Case "file health reports warning and critical" {
    $path = Join-Path $Scratch "wal"
    Set-Content -LiteralPath $path -Value ("x" * 20) -NoNewline
    Assert-Equal (Get-FileHealth -Path $path -WarningBytes 10 -CriticalBytes 30).State "warning" "warning state"
    Assert-Equal (Get-FileHealth -Path $path -WarningBytes 5 -CriticalBytes 15).State "critical" "critical state"
  }

  Test-Case "cache-fix health requires ok with no failed extensions" {
    Assert-Equal (Test-CacheFixHealthResponse -Response ([pscustomobject]@{ status = "ok"; failed_extensions = @() })) $true "healthy rejected"
    Assert-Equal (Test-CacheFixHealthResponse -Response ([pscustomobject]@{ status = "ok" })) $true "omitted empty failures rejected"
    Assert-Equal (Test-CacheFixHealthResponse -Response ([pscustomobject]@{ status = "degraded"; failed_extensions = @("x") })) $false "degraded accepted"
  }

  Test-Case "maintenance gate rejects active service ports" {
    Assert-Equal (Test-MaintenanceAllowed -ListeningPorts @(8090)) $false "active port allowed"
    Assert-Equal (Test-MaintenanceAllowed -ListeningPorts @()) $true "inactive ports rejected"
  }

  Test-Case "runtime event is append-only jsonl" {
    $path = Join-Path $Scratch "events.jsonl"
    Write-RuntimeEvent -Path $path -Event "started" -Service "cache-fix" -Data @{ pid = 42 }
    Write-RuntimeEvent -Path $path -Event "exited" -Service "cache-fix" -Data @{ exit_code = 1 }
    $records = @(Get-Content -LiteralPath $path | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-Equal $records.Count 2 "record count"
    Assert-Equal $records[0].pid 42 "pid missing"
    Assert-Equal $records[1].exit_code 1 "exit code missing"
  }

  Test-Case "recovery decision ignores upstream 500" {
    Assert-Equal (Get-ServiceRecoveryDecision -ListeningProcessId 42 -HealthFailures 0 -LastUpstreamStatus 500) "none" "500 triggered restart"
    Assert-Equal (Get-ServiceRecoveryDecision -ListeningProcessId $null -HealthFailures 0) "restart" "missing process ignored"
    Assert-Equal (Get-ServiceRecoveryDecision -ListeningProcessId $null -ManagedProcessRunning $true) "wait" "starting process duplicated"
    Assert-Equal (Get-ServiceRecoveryDecision -ListeningProcessId 42 -HealthFailures 3) "restart" "health threshold ignored"
  }

  Test-Case "process tree includes all supervisor descendants" {
    $rows = @(
      [pscustomobject]@{ ProcessId = 20; ParentProcessId = 10 },
      [pscustomobject]@{ ProcessId = 30; ParentProcessId = 10 },
      [pscustomobject]@{ ProcessId = 40; ParentProcessId = 20 },
      [pscustomobject]@{ ProcessId = 50; ParentProcessId = 99 }
    )
    $ids = @(Get-DescendantProcessIdsFromRows -Rows $rows -RootProcessId 10)
    Assert-Equal (($ids | Sort-Object) -join ",") "20,30,40" "wrong process tree"
  }

  Test-Case "managed child exposes exit code and separate output logs" {
    $stdout = Join-Path $Scratch "child.stdout.log"
    $stderr = Join-Path $Scratch "child.stderr.log"
    $process = Start-ManagedProcess `
      -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-Command", "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 7") `
      -WorkingDirectory $Scratch `
      -StdoutPath $stdout `
      -StderrPath $stderr
    Assert-Equal (Wait-ManagedProcess -Process $process) 7 "exit code"
    Assert-Equal (Get-Content -Raw -LiteralPath $stdout) "out" "stdout"
    Assert-Equal (Get-Content -Raw -LiteralPath $stderr) "err" "stderr"
  }

  Test-Case "managed child accepts an empty argument list" {
    $stdout = Join-Path $Scratch "no-args.stdout.log"
    $stderr = Join-Path $Scratch "no-args.stderr.log"
    $process = Start-ManagedProcess `
      -FilePath "whoami.exe" `
      -WorkingDirectory $Scratch `
      -StdoutPath $stdout `
      -StderrPath $stderr
    Assert-Equal (Wait-ManagedProcess -Process $process) 0 "no-args child exit code"
    Assert-Equal ((Get-Content -Raw -LiteralPath $stdout).Trim().Length -gt 0) $true "no stdout"
  }
} finally {
  Remove-Item -LiteralPath $Scratch -Recurse -Force
}

Write-Host "`nRuntime common: $script:Passed passed, $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
