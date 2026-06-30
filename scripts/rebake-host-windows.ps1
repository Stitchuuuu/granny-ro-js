# rebake-host-windows.ps1 — drive the granny2.dll re-bake against the
# user's data.grf, on Windows native (no wine, direct exec). Produces
# tests/fixtures/rebake-fresh/windows-host/manifest.json for any
# environment (host or devcontainer) to verify.
#
# Prerequisites :
#   1. Node 20+ installed.
#   2. iRO ver12 client at $env:RO_FOLDER (data.grf + granny2.dll).
#   3. tests/fixtures/source/ populated with the .gr2 fixtures of
#      interest. Coverage is content-addressed.
#
# Usage (PowerShell) :
#   $env:RO_FOLDER = "C:\Games\iRO"
#   .\scripts\rebake-host-windows.ps1

$ErrorActionPreference = "Stop"

Set-Location -Path (Join-Path $PSScriptRoot "..")

if (-not $env:RO_FOLDER) {
    Write-Error "RO_FOLDER not set. Point it at your iRO client root."
    exit 2
}

Write-Host "[rebake-host-windows] RO_FOLDER = $env:RO_FOLDER"
Write-Host "[rebake-host-windows] running rebake..."

node .\scripts\rebake.mjs --target windows-host

Write-Host ""
Write-Host "[rebake-host-windows] done. Verify with :"
Write-Host "   npm run verify:rebake -- --target windows-host"
