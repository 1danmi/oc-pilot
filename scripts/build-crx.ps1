# build-crx.ps1 — Build a versioned CRX3 from extension/ using the project's signing key.
#
# Usage:  .\scripts\build-crx.ps1   (from project root, or anywhere — it resolves
#                                    paths from $PSScriptRoot)
#
# Output: build\oc-pilot-<version>.crx   (in project root)
# Reads the version from extension\manifest.json automatically.
#
# Requires: Node.js (node in PATH)
# The signing key is oc-pilot.pem one level above the project root (so it isn't
# accidentally committed). Run `scripts\crx-signer.js` is invoked under the hood.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent $scriptDir
$src       = Join-Path $root 'extension'
$keyFile   = Join-Path (Split-Path $root -Parent) 'oc-pilot.pem'
$buildDir  = Join-Path $root 'build'
$packJs    = Join-Path $scriptDir 'crx-signer.js'

# ── Read version from manifest ────────────────────────────────────────────────
$manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$version  = $manifest.version
$dest     = Join-Path $buildDir "oc-pilot-$version.crx"
Write-Host "Packing OC Pilot v$version ..." -ForegroundColor Cyan

if (Test-Path $dest) {
  Write-Host "  $dest already exists — overwriting." -ForegroundColor Yellow
}

# ── Stage extension/ to a temp dir ────────────────────────────────────────────
# t.config lives in extension/ for runtime loading by the unpacked extension.
# We stage extension/ to a temp dir and delete t.config before zipping so it
# is never bundled into the CRX. Unpacked installs read the file directly.
$staging = Join-Path $env:TEMP "oc-pilot-stage-$version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $staging -Recurse -Force

# t.config must NEVER end up inside the CRX — delete it from staging.
$stagedTConfig = Join-Path $staging 't.config'
if (Test-Path $stagedTConfig) {
  Remove-Item $stagedTConfig -Force
  Write-Host "  Removed t.config from staging — secrets not bundled in CRX" -ForegroundColor DarkGray
}

# ── Zip the staged extension source ───────────────────────────────────────────
$tmpZip = Join-Path $env:TEMP "oc-pilot-$version.zip"
if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }

# Compress-Archive with "<staging>\*" puts files at the ZIP root.
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $tmpZip -Force
Write-Host "  Zipped staged source → $tmpZip"

# ── Sign and build CRX3 ───────────────────────────────────────────────────────
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }
node $packJs $keyFile $tmpZip $dest

# ── Clean up temp zip + staging ───────────────────────────────────────────────
Remove-Item $tmpZip -Force
Remove-Item $staging -Recurse -Force

Write-Host "  Done: $dest" -ForegroundColor Green
