$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Root
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'download-real-epg.ps1')
if ($LASTEXITCODE -ne 0) { Write-Error 'Download failed; preview not started.'; exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'epg-ru.xml')) -or -not (Test-Path -LiteralPath (Join-Path $Root 'epg-iptvx.xml.gz'))) { Write-Error 'Expected EPG files are missing.'; exit 1 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'preview-real-epg.ps1')
exit $LASTEXITCODE
