# install.ps1 — Install the OC Pilot CRX via Chrome's enterprise policy.
#
# Chrome blocks direct .crx installs (drag-and-drop, double-click) for any
# extension not from the Chrome Web Store. The supported workaround for
# self-distributed extensions is the ExtensionInstallForcelist policy. It
# also works for personal Chrome installs via HKCU (no admin required).
#
# This script, given the latest CRX in build/:
#   1. Derives the extension ID from oc-pilot.pem (SHA-256 of the public
#      key, first 16 bytes, mapped to a–p).
#   2. Writes an update.xml manifest next to the CRX. Chrome polls this to
#      learn the CRX location and version.
#   3. Sets the ExtensionInstallForcelist entry in HKCU so Chrome installs
#      the extension on its next launch — and re-installs it automatically
#      if you ever uninstall it from chrome://extensions by mistake.
#
# Re-running the script after `.\pack.ps1` upgrades the install in place
# (Chrome picks up the new version on next launch).
#
# Usage:
#   .\install.ps1              # install / upgrade
#   .\install.ps1 -Uninstall   # remove the policy (Chrome will uninstall on restart)

param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $root 'build'
$keyFile  = Join-Path (Split-Path $root -Parent) 'oc-pilot.pem'
$regPath  = 'HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'

# ── Derive extension ID from the PEM private key ─────────────────────────────
# The ID is SHA-256 of the DER-encoded public key (SPKI), first 16 bytes,
# with each hex digit mapped to a letter a–p (0→a, 1→b, …, f→p).
function Get-ExtensionId {
    param([string]$PemPath)

    $pemText = Get-Content $PemPath -Raw
    $rsa = [System.Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($pemText)
        $pubDer = $rsa.ExportSubjectPublicKeyInfo()
    } finally {
        $rsa.Dispose()
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($pubDer)
    } finally {
        $sha.Dispose()
    }

    $hex = ([BitConverter]::ToString($hash[0..15]) -replace '-', '').ToLower()
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $hex.ToCharArray()) {
        [void]$sb.Append([char]([int][char]'a' + [Convert]::ToInt32($c, 16)))
    }
    return $sb.ToString()
}

$extId = Get-ExtensionId -PemPath $keyFile

# ── Uninstall path ───────────────────────────────────────────────────────────
if ($Uninstall) {
    if (Test-Path $regPath) {
        $props = Get-ItemProperty -Path $regPath
        $removed = 0
        foreach ($p in $props.PSObject.Properties) {
            if ($p.Name -notmatch '^\d+$') { continue }
            if ($p.Value -like "$extId;*") {
                Remove-ItemProperty -Path $regPath -Name $p.Name
                $removed++
            }
        }
        Write-Host "Removed $removed forcelist entry/entries for $extId." -ForegroundColor Yellow
    } else {
        Write-Host "No policy entry found." -ForegroundColor DarkGray
    }
    Write-Host "→ Restart Chrome to complete the uninstall." -ForegroundColor Cyan
    return
}

# ── Locate the latest CRX ────────────────────────────────────────────────────
# Sort by version semver-ish: split on '.' and pad numerically.
$crx = Get-ChildItem -Path $buildDir -Filter 'oc-pilot-*.crx' -ErrorAction SilentlyContinue |
       Sort-Object {
           $v = $_.BaseName -replace '^oc-pilot-', ''
           ($v -split '\.' | ForEach-Object { [int]$_ }) -join '.' | ForEach-Object {
               # Pad each segment to 5 digits for lexical sort
               (($_ -split '\.') | ForEach-Object { '{0:D5}' -f [int]$_ }) -join '.'
           }
       } | Select-Object -Last 1

if (-not $crx) {
    Write-Error "No oc-pilot-*.crx found in $buildDir. Run .\pack.ps1 first."
}

$version     = $crx.BaseName -replace '^oc-pilot-', ''
$crxFullPath = $crx.FullName
$crxUri      = ([uri]$crxFullPath).AbsoluteUri  # file:///C:/...

Write-Host "Installing OC Pilot v$version ..." -ForegroundColor Cyan
Write-Host "  Extension ID: $extId" -ForegroundColor DarkGray

# ── Write update.xml ─────────────────────────────────────────────────────────
# Chrome polls this manifest to discover the codebase URL and version.
$updateXmlPath = Join-Path $buildDir 'update.xml'
$updateXml = @"
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="$extId">
    <updatecheck codebase="$crxUri" version="$version"/>
  </app>
</gupdate>
"@
Set-Content -Path $updateXmlPath -Value $updateXml -Encoding utf8
$updateUri = ([uri]$updateXmlPath).AbsoluteUri

# ── Add / update the forcelist entry ─────────────────────────────────────────
# Multi-extension forcelist policies live as numbered string values 1, 2, 3, …
# We reuse our slot if it already exists, otherwise grab the next free number.
if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
}

$entry    = "$extId;$updateUri"
$slotName = $null
$nextNum  = 1
$props    = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
if ($props) {
    foreach ($p in $props.PSObject.Properties) {
        if ($p.Name -notmatch '^\d+$') { continue }
        if ($p.Value -like "$extId;*") { $slotName = $p.Name; break }
        $n = [int]$p.Name
        if ($n -ge $nextNum) { $nextNum = $n + 1 }
    }
}
if (-not $slotName) { $slotName = "$nextNum" }

Set-ItemProperty -Path $regPath -Name $slotName -Value $entry -Type String

Write-Host ""
Write-Host "  CRX:        $crxFullPath" -ForegroundColor DarkGray
Write-Host "  Update XML: $updateXmlPath" -ForegroundColor DarkGray
Write-Host "  Registry:   $regPath\$slotName" -ForegroundColor DarkGray
Write-Host ""
Write-Host "→ Quit Chrome COMPLETELY (close all windows, check Task Manager) and reopen." -ForegroundColor Cyan
Write-Host "  The extension installs automatically — see chrome://extensions." -ForegroundColor Cyan
Write-Host ""
Write-Host "  To uninstall:  .\install.ps1 -Uninstall" -ForegroundColor DarkGray
