Set-StrictMode -Version Latest

function Get-ListeningProcessIdFromText {
  param(
    [string]$Text,
    [int]$Port
  )

  foreach ($line in ($Text -split "`r?`n")) {
    $parts = @($line.Trim() -split '\s+' | Where-Object { $_ })
    if ($parts.Count -lt 5 -or $parts[0] -ne "TCP" -or $parts[-2] -ne "LISTENING") {
      continue
    }
    $localEndpoint = $parts[1]
    if ($localEndpoint -match ':(\d+)$' -and [int]$Matches[1] -eq $Port) {
      return [int]$parts[-1]
    }
  }
  return $null
}

function Get-ListeningProcessId {
  param([int]$Port)
  $text = (netstat -ano | Out-String)
  return Get-ListeningProcessIdFromText -Text $text -Port $Port
}

function Rotate-LogFile {
  param(
    [string]$Path,
    [long]$MaxBytes = 100MB,
    [int]$Keep = 5,
    [switch]$Always
  )

  if ($Keep -lt 1 -or -not (Test-Path -LiteralPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path
  if (-not $Always -and $item.Length -le $MaxBytes) { return $false }

  $oldest = "$Path.$Keep"
  if (Test-Path -LiteralPath $oldest) {
    Remove-Item -LiteralPath $oldest -Force
  }
  for ($index = $Keep - 1; $index -ge 1; $index--) {
    $source = "$Path.$index"
    if (Test-Path -LiteralPath $source) {
      Move-Item -LiteralPath $source -Destination "$Path.$($index + 1)" -Force
    }
  }
  Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
  return $true
}

function Get-RedirectLogPath {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $Path }
  try {
    $null = Rotate-LogFile -Path $Path -Always
    return $Path
  } catch {
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
    $fallback = "$Path.$stamp.$PID"
    Write-Warning "Log is busy; using $fallback instead of $Path"
    return $fallback
  }
}

function Get-RestartDelaySeconds {
  param(
    [int]$Attempt,
    [int]$MaximumSeconds = 60
  )
  if ($Attempt -lt 0) { $Attempt = 0 }
  $power = [Math]::Min($Attempt, 30)
  return [int][Math]::Min([Math]::Pow(2, $power), $MaximumSeconds)
}

function Get-DirectoryHealth {
  param(
    [string]$Path,
    [long]$WarningBytes,
    [long]$CriticalBytes
  )
  $bytes = 0
  if (Test-Path -LiteralPath $Path) {
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File | Measure-Object -Property Length -Sum).Sum
    # Measure-Object -Sum returns $null for empty collections; guard keeps $bytes=0
    if ($sum) { $bytes = [long]$sum }
  }
  $state = if ($bytes -ge $CriticalBytes) {
    "critical"
  } elseif ($bytes -ge $WarningBytes) {
    "warning"
  } else {
    "ok"
  }
  return [pscustomobject]@{ Path = $Path; Bytes = $bytes; State = $state }
}

function Get-FileHealth {
  param(
    [string]$Path,
    [long]$WarningBytes,
    [long]$CriticalBytes
  )
  $bytes = if (Test-Path -LiteralPath $Path) {
    (Get-Item -LiteralPath $Path).Length
  } else {
    0
  }
  $state = if ($bytes -ge $CriticalBytes) {
    "critical"
  } elseif ($bytes -ge $WarningBytes) {
    "warning"
  } else {
    "ok"
  }
  return [pscustomobject]@{ Path = $Path; Bytes = $bytes; State = $state }
}

function Test-CacheFixHealthResponse {
  param($Response)
  if ($null -eq $Response -or $Response.status -ne "ok") { return $false }
  $failedProperty = $Response.PSObject.Properties["failed_extensions"]
  if ($null -eq $failedProperty) { return $true }
  return @($failedProperty.Value).Count -eq 0
}

function Test-MaintenanceAllowed {
  param([int[]]$ListeningPorts)
  if (-not $PSBoundParameters.ContainsKey("ListeningPorts")) {
    $ListeningPorts = @(8090, 9801 | Where-Object { Get-ListeningProcessId -Port $_ })
  }
  return @($ListeningPorts).Count -eq 0
}

function Write-RuntimeEvent {
  param(
    [string]$Path,
    [string]$Event,
    [string]$Service,
    [hashtable]$Data = @{}
  )
  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $record = [ordered]@{
    ts = [DateTime]::UtcNow.ToString("o")
    event = $Event
    service = $Service
  }
  foreach ($key in $Data.Keys) { $record[$key] = $Data[$key] }
  Add-Content -LiteralPath $Path -Value ($record | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
}

function Get-ServiceRecoveryDecision {
  param(
    $ListeningProcessId,
    [int]$HealthFailures = 0,
    [int]$HealthFailureLimit = 3,
    [Nullable[int]]$LastUpstreamStatus,
    [bool]$ManagedProcessRunning = $false
  )
  if ($null -eq $ListeningProcessId -or [int]$ListeningProcessId -le 0) {
    if ($ManagedProcessRunning) { return "wait" }
    return "restart"
  }
  if ($HealthFailures -ge $HealthFailureLimit) {
    return "restart"
  }
  return "none"
}

function Get-DescendantProcessIdsFromRows {
  param(
    [object[]]$Rows,
    [int]$RootProcessId
  )
  $result = @()
  $frontier = @($RootProcessId)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($row in $Rows) {
      $processId = [int]$row.ProcessId
      if ($frontier -contains [int]$row.ParentProcessId -and $result -notcontains $processId) {
        $result += $processId
        $next += $processId
      }
    }
    $frontier = $next
  }
  return $result
}

function Get-DescendantProcessIds {
  param([int]$RootProcessId)
  $rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Select-Object ProcessId, ParentProcessId)
  return @(Get-DescendantProcessIdsFromRows -Rows $rows -RootProcessId $RootProcessId)
}

function Start-ManagedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory,
    [string]$StdoutPath,
    [string]$StderrPath,
    [switch]$Hidden
  )
  foreach ($path in @($StdoutPath, $StderrPath)) {
    if ($path) {
      $directory = Split-Path -Parent $path
      if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    }
  }
  $parameters = @{
    FilePath = $FilePath
    WorkingDirectory = $WorkingDirectory
    PassThru = $true
  }
  if ($ArgumentList.Count -gt 0) { $parameters.ArgumentList = $ArgumentList }
  if ($StdoutPath) { $parameters.RedirectStandardOutput = $StdoutPath }
  if ($StderrPath) { $parameters.RedirectStandardError = $StderrPath }
  if ($Hidden) { $parameters.WindowStyle = "Hidden" }
  $process = Start-Process @parameters
  $process.EnableRaisingEvents = $true
  return $process
}

function Wait-ManagedProcess {
  param([System.Diagnostics.Process]$Process)
  $Process.WaitForExit()
  $Process.Refresh()
  return $Process.ExitCode
}

function Get-SupervisorProcessId {
  param([string]$ScriptPath)
  $target = [System.IO.Path]::GetFullPath($ScriptPath).ToLowerInvariant()
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $PID -and $_.CommandLine -and
      $_.CommandLine.ToLowerInvariant().Contains($target)
    }
  $first = @($processes | Sort-Object ProcessId | Select-Object -First 1)
  if ($first.Count -eq 0) { return $null }
  return [int]$first[0].ProcessId
}
