# Setup script for axonhub-cache-fix
# Copies built-in cache-fix extensions from npm, installs custom ones,
# and creates the runtime directory structure.
param(
  [string]$AxonHubDir = "$env:LOCALAPPDATA\axonhub-cache-fix"
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=== axonhub-cache-fix setup ==="

# 1. Verify npm cache-fix is installed
$npmRoot = "$env:APPDATA\npm\node_modules\claude-code-cache-fix\proxy"
if (-not (Test-Path $npmRoot)) {
  Write-Host "ERROR: claude-code-cache-fix not found. Install: npm install -g claude-code-cache-fix"
  exit 1
}
Write-Host "cache-fix proxy found at $npmRoot"

# 2. Create runtime directory
$ExtDir = "$AxonHubDir\extensions"
New-Item -ItemType Directory -Path $ExtDir -Force | Out-Null
New-Item -ItemType Directory -Path "$AxonHubDir\logs" -Force | Out-Null
Write-Host "Runtime dir: $AxonHubDir"

# 3. Copy built-in extensions from npm
Write-Host "Copying built-in extensions..."
Copy-Item "$npmRoot\extensions\*.mjs" $ExtDir -Force

# 4. Copy helper files (needed by built-in extensions' imports)
$helpers = @(
  "model-families.mjs", "image-dimensions.mjs", "image-hash.mjs",
  "image-resize.mjs", "rates.mjs", "workflow-markers.mjs",
  "session-mirror-envelope.mjs", "session-mirror-writer.mjs",
  "workflow-agent-derivation.mjs"
)
foreach ($h in $helpers) {
  if (Test-Path "$npmRoot\$h") {
    Copy-Item "$npmRoot\$h" $ExtDir -Force
  }
}

# 5. Copy our custom extensions
Write-Host "Copying custom extensions..."
Copy-Item "$RepoDir\extensions\*.mjs" $ExtDir -Force

# 6. Copy extensions config
Copy-Item "$RepoDir\extensions\extensions.json" $ExtDir -Force

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Extensions: $ExtDir"
Write-Host "  Config:     $ExtDir\extensions.json"
Write-Host "  Logs:       $AxonHubDir\logs"
Write-Host ""
Write-Host "Next: .\scripts\start.ps1 -AxonHubDir `"$AxonHubDir`""
