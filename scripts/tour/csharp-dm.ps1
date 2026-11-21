$ErrorActionPreference = 'Stop'
$dist = 'f:\claude\Dismesh\ClientC#\dist'
$cfg = Join-Path $dist 'data\dismesh-client-config.json'
$bak = "$cfg.dmtest.bak"
Copy-Item $cfg $bak -Force
try {
  $j = Get-Content $cfg -Raw | ConvertFrom-Json
  $j.serverUrl = 'http://localhost:8099/'
  $j | ConvertTo-Json -Depth 6 | Set-Content $cfg -Encoding utf8
  $env:MESHCROWD_CDP_PORT = '9222'
  $exe = Join-Path $dist 'MeshCrowd-WindowsDotnet.exe'
  Start-Process -FilePath $exe -ArgumentList @('--dev') -WorkingDirectory $dist | Out-Null
  Start-Sleep -Seconds 12
  $env:CDP = 'http://localhost:9222'
  Push-Location 'f:\claude\Dismesh\scripts\tour'
  node dmgroup.mjs
  Pop-Location
} finally {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq (Join-Path $dist 'MeshCrowd-WindowsDotnet.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  Copy-Item $bak $cfg -Force
  Remove-Item $bak
}
