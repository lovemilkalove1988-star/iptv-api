$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
node .\scripts\run-milktv-health-recovery-local.js
