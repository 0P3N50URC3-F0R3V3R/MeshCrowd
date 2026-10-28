#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f "node_modules/electron/dist/electron" ] && [ ! -f "node_modules/electron/dist/Electron" ]; then
  echo "Electron isn't installed yet. Run this once with an internet connection:"
  echo "  npm install"
  exit 1
fi
./node_modules/.bin/electron electron/main.js
