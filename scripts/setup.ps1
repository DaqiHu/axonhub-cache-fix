# Setup script for axonhub-cache-fix
# Copies built-in cache-fix extensions from npm, installs custom ones,
# and creates the runtime directory structure.
param(
  [string]$Dir = "$env:USERPROFILE\axonhub"
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodePath = (Get-Command node -ErrorAction Stop).Source

Write-Host "=== axonhub-cache-fix setup ==="

# 1. Verify npm cache-fix is installed
$npmRoot = "$env:APPDATA\npm\node_modules\claude-code-cache-fix\proxy"
if (-not (Test-Path $npmRoot)) {
  Write-Host "ERROR: claude-code-cache-fix not found. Install: npm install -g claude-code-cache-fix"
  exit 1
}
Write-Host "cache-fix proxy found at $npmRoot"

# 2. Create runtime directory
$ExtDir = "$Dir\extensions"
New-Item -ItemType Directory -Path $ExtDir -Force | Out-Null
New-Item -ItemType Directory -Path "$Dir\logs" -Force | Out-Null
Write-Host "Runtime dir: $Dir"

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
    Remove-Item "$ExtDir\$h" -Force -ErrorAction SilentlyContinue
    Copy-Item "$npmRoot\$h" $Dir -Force
  }
}

# 5. Copy our custom extensions
Write-Host "Copying custom extensions..."
Copy-Item "$RepoDir\extensions\*.mjs" $ExtDir -Force

# 6. Copy extensions config
Copy-Item "$RepoDir\extensions\extensions.json" $ExtDir -Force

# 7. Validate the generated runtime with cache-fix's real extension loader
Write-Host "Validating extension runtime..."
& $NodePath "$RepoDir\scripts\validate-runtime.mjs" --dir $Dir
if ($LASTEXITCODE -ne 0) {
  throw "Extension runtime validation failed"
}

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Extensions: $ExtDir"
Write-Host "  Config:     $ExtDir\extensions.json"
Write-Host "  Logs:       $Dir\logs"
Write-Host ""
Write-Host "Next: .\scripts\start.ps1 -Dir `"$Dir`""
