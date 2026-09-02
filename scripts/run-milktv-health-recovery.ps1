param(
  [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"
$cookie = Read-Host "Admin session cookie (connect.sid=...)"
$csrf = Read-Host "CSRF token"
$confirm = Read-Host "Start one full canonical MILK TV health check? Type RUN"
if ($confirm -ne "RUN") { Write-Host "Cancelled (no request sent)."; exit 0 }

$headers = @{
  "Cookie" = $cookie
  "X-CSRF-Token" = $csrf
  "Accept" = "application/json"
}
$result = Invoke-RestMethod -Method Post -Uri ($BaseUrl.TrimEnd('/') + "/admin/milktv/check") -Headers $headers -ContentType "application/json" -Body "{}"
$result | ConvertTo-Json -Depth 5
Write-Host "Health check started. Poll /api/admin/milktv/check-progress from the authenticated admin session; no client/source policy was changed by this runner."
