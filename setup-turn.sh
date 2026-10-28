#!/usr/bin/env bash
# Sets up the built-in STUN/TURN server: settings, firewall, port forwarding help, self-test.
# Run with sudo to let it open the firewall (ufw or firewalld).
cd "$(dirname "$0")" || exit 1
if [ -x runtime/node ]; then exec runtime/node server/tools/setupTurn.js "$@"; fi
exec node server/tools/setupTurn.js "$@"
