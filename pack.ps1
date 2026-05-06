# pack.ps1 — Build a versioned CRX3 from src/ using the project's signing key.
#
# Usage:  .\pack.ps1
#
# Output: build\oc-pilot-<version>.crx
# Reads the version from src\manifest.json automatically.
#
# Requires: Node.js (node in PATH)
# The signing key is oc-pilot.pem in the same directory as this script.

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$src     = Join-Path $root 'src'
$keyFile = Join-Path (Split-Path $root -Parent) 'oc-pilot.pem'
$buildDir= Join-Path $root 'build'
$packJs  = Join-Path $root 'pack-crx.js'

# ── Read version from manifest ────────────────────────────────────────────────
$manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$version  = $manifest.version
$dest     = Join-Path $buildDir "oc-pilot-$version.crx"
Write-Host "Packing OC Pilot v$version ..." -ForegroundColor Cyan

if (Test-Path $dest) {
  Write-Host "  $dest already exists — overwriting." -ForegroundColor Yellow
}

# ── Zip the extension source ──────────────────────────────────────────────────
$tmpZip = Join-Path $env:TEMP "oc-pilot-$version.zip"
if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }

# Compress-Archive with "src\*" puts files at the ZIP root (no src\ prefix).
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $tmpZip -Force
Write-Host "  Zipped source → $tmpZip"

# ── Sign and build CRX3 ───────────────────────────────────────────────────────
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }
node $packJs $keyFile $tmpZip $dest

# ── Clean up temp zip ─────────────────────────────────────────────────────────
Remove-Item $tmpZip -Force

Write-Host "  Done: $dest" -ForegroundColor Green
