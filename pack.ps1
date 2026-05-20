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

# ── Stage src/ to a temp dir so we can inject build-time secrets ──────────────
# We never mutate the working tree — placeholders in src/background.js are
# substituted from telemetry-config.json (repo root, .gitignored) on the staged
# copy. If the config file is missing, the placeholders stay and the runtime
# disables telemetry with a single SW console log.
$staging = Join-Path $env:TEMP "oc-pilot-stage-$version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $staging -Recurse -Force

# ── Inject telemetry config if present ────────────────────────────────────────
$telCfgPath = Join-Path $root 'telemetry-config.json'
if (Test-Path $telCfgPath) {
  try {
    $telCfg = Get-Content $telCfgPath -Raw | ConvertFrom-Json
    $bgPath = Join-Path $staging 'background.js'
    $bgText = Get-Content $bgPath -Raw
    $injected = $false
    if ($telCfg.url) {
      $bgText = $bgText.Replace('__OC_PILOT_TELEMETRY_URL__', [string]$telCfg.url)
      $injected = $true
    }
    if ($telCfg.token) {
      $bgText = $bgText.Replace('__OC_PILOT_TELEMETRY_TOKEN__', [string]$telCfg.token)
      $injected = $true
    }
    if ($injected) {
      [System.IO.File]::WriteAllText($bgPath, $bgText, [System.Text.UTF8Encoding]::new($false))
      Write-Host "  Injected telemetry config from telemetry-config.json" -ForegroundColor DarkGray
    } else {
      Write-Host "  telemetry-config.json has no url/token — telemetry disabled in this build" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  Failed to parse telemetry-config.json: $_  — telemetry disabled in this build" -ForegroundColor Yellow
  }
} else {
  Write-Host "  No telemetry-config.json at repo root — telemetry disabled in this build" -ForegroundColor Yellow
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
