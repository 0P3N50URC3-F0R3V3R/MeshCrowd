#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ -x "runtime/node" ]; then
  ./runtime/node server/index.js
else
  node server/index.js
fi
