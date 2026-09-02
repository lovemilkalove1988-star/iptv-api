$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Root
$results = @()
$results += & node scripts/run-local-epg-preview.js epg-ru.xml --provider 'IPTV-EPG Russia' --json-output epg-preview-russia.json
$code1 = $LASTEXITCODE
$results += & node scripts/run-local-epg-preview.js epg-iptvx.xml.gz --provider 'iptvX EPG' --json-output epg-preview-iptvx.json
$code2 = $LASTEXITCODE
$results | ForEach-Object { Write-Host $_ }
if ($code1 -ne 0 -or $code2 -ne 0) { exit 1 }
