$ErrorActionPreference = 'Stop'
$root = 'f:\claude\Dismesh'
$cfg = Join-Path $env:APPDATA 'Electron\dismesh-client-config.json'
$bak = "$cfg.dmtest.bak"
Copy-Item $cfg $bak -Force
try {
  $j = Get-Content $cfg -Raw | ConvertFrom-Json
  $j.serverUrl = 'http://localhost:8099/'
  $j | ConvertTo-Json -Depth 6 | Set-Content $cfg -Encoding utf8
  $exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
  $p = Start-Process -FilePath $exe -ArgumentList @('electron/main.js', '--remote-debugging-port=9333') -WorkingDirectory $root -PassThru
  Start-Sleep -Seconds 8
  $env:CDP = 'http://localhost:9333'
  Push-Location (Join-Path $root 'scripts\tour')
  node dmgroup.mjs
  Pop-Location
} finally {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq (Join-Path $root 'node_modules\electron\dist\electron.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Copy-Item $bak $cfg -Force
  Remove-Item $bak
}
