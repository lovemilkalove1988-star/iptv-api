$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Download-EpgFile {
    param([string]$Url, [string]$Name, [bool]$Gzip)
    $final = Join-Path $Root $Name
    $temp = "$final.tmp"
    try {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
        $response = Invoke-WebRequest -Uri $Url -OutFile $temp -TimeoutSec 45 -UseBasicParsing -PassThru
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw "HTTP status $($response.StatusCode)" }
        $item = Get-Item -LiteralPath $temp
        if ($item.Length -le 0) { throw 'Downloaded file is empty' }
        $bytes = [System.IO.File]::ReadAllBytes($temp)
        if ($Gzip) {
            if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x1f -or $bytes[1] -ne 0x8b) { throw 'Gzip header is invalid' }
        } else {
            $head = [System.Text.Encoding]::UTF8.GetString($bytes, 0, [Math]::Min($bytes.Length, 256))
            if ($head -notmatch '<\?xml|<tv\b|<channel\b') { throw 'File does not look like XML/XMLTV' }
        }
        Move-Item -LiteralPath $temp -Destination $final -Force
        $done = Get-Item -LiteralPath $final
        Write-Host ("OK  {0}  {1} bytes  {2}" -f $Name, $done.Length, $done.LastWriteTime)
        return $true
    } catch {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        Write-Warning ("FAILED  {0}: {1}" -f $Name, $_.Exception.Message)
        return $false
    }
}

$ok1 = Download-EpgFile 'https://iptv-epg.org/files/epg-ru.xml' 'epg-ru.xml' $false
$ok2 = Download-EpgFile 'https://iptvx.one/epg/epg.xml.gz' 'epg-iptvx.xml.gz' $true
if (-not ($ok1 -and $ok2)) { exit 1 }
