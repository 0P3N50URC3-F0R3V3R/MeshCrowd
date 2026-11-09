# Builds MeshCrowd.Client/webview2-runtime.bin from an installed WebView2 runtime so the next
# `dotnet publish` embeds it (fixed-version runtime for machines without WebView2).
# Usage: powershell -File bundle-webview2.ps1 [-Source <runtime version folder>]
param([string]$Source)
$ErrorActionPreference = 'Stop'
if (-not $Source) {
  $root = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'
  $Source = Get-ChildItem $root -Directory | ? { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | sort { [version]$_.Name } | select -Last 1 -ExpandProperty FullName
}
if (-not (Test-Path (Join-Path $Source 'msedgewebview2.exe'))) { throw "No WebView2 runtime at $Source" }
$version = Split-Path $Source -Leaf
$skipDirs = 'ResiliencyLinks','undocked_copilot','Installer','BHO','edge_feedback','edge_game_assist','identity_proxy','VisualElements','PdfPreview','WidevineCdm','AdSelectionAttestationsPreloaded'
$keepLocales = 'en-US.pak','en-GB.pak','hu.pak'
$out = Join-Path $PSScriptRoot 'MeshCrowd.Client'
$stage = Join-Path $env:TEMP "mc-wv2-$version"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Get-ChildItem $Source -Force | ? { $skipDirs -notcontains $_.Name } | % { Copy-Item $_.FullName $stage -Recurse -Force }
Get-ChildItem (Join-Path $stage 'Locales') -File | ? { $keepLocales -notcontains $_.Name } | Remove-Item -Force
$bin = Join-Path $out 'webview2-runtime.bin'
Remove-Item $bin -Force -ErrorAction SilentlyContinue
dotnet run (Join-Path $PSScriptRoot 'tools\PackRuntime.cs') -- $stage $bin
if ($LASTEXITCODE -ne 0) { throw 'pack failed' }
Set-Content (Join-Path $out 'webview2-runtime.version') $version -NoNewline
Remove-Item $stage -Recurse -Force
"{0}: {1:N0} MB packed" -f $version, ((Get-Item $bin).Length / 1MB)
