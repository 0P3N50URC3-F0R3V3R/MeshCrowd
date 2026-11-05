#!/bin/bash
# Fresh throwaway server on :8099 + seeded demo world. Data lives in $TMPDIR/tourdata, never the repo.
cd "$(dirname "$0")/../.."
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server*index.js*' -or \$_.CommandLine -like '*world.mjs*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
sleep 2
DATA="${TMPDIR:-/tmp}/tourdata"
rm -rf "$DATA" && mkdir -p "$DATA"
echo '{"useHttps":false,"port":8099}' > "$DATA/config.json"
DISMESH_DATA_DIR="$(cygpath -w "$DATA")" node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DISMESH_DATA_DIR+'/dismesh.db');d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');d.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run('security_settings',JSON.stringify({captcha:{registerRequired:false}}));d.close()"
(DISMESH_DATA_DIR="$(cygpath -w "$DATA")" nohup node server/index.js > "$DATA/../tour-server.log" 2>&1 &)
sleep 6
(cd scripts/tour && nohup node world.mjs > "$DATA/../tour-world.log" 2>&1 &)
for i in $(seq 1 40); do grep -q 'world ready' "$DATA/../tour-world.log" 2>/dev/null && break; sleep 1; done
cat "$DATA/../tour-world.log"
