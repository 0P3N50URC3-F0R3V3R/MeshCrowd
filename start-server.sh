#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -x "runtime/node" ]; then NODE=./runtime/node; else NODE=node; fi
while true; do
  code=0
  "$NODE" server/supervisor.js || code=$?
  [ "$code" = 42 ] || break
done
exit "$code"
