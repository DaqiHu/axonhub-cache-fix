$found = $false

# Find processes by port
$ports = @(
  @{ Port = 9801; Name = "cache-fix proxy" }
  @{ Port = 8090; Name = "AxonHub" }
)

foreach ($p in $ports) {
  $conn = netstat -ano | Select-String "LISTENING" | Select-String ":$($p.Port)\s"
  if ($conn) {
    $procId = ($conn -split '\s+')[-1]
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) {
      $proc | Stop-Process -Force
      Write-Host "$($p.Name) (PID $procId) stopped."
      $found = $true
    }
  } else {
    Write-Host "$($p.Name) is not running."
  }
}

if (-not $found) {
  Write-Host "No services were running."
}
