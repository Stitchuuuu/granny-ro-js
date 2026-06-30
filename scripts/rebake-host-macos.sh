#!/usr/bin/env bash
# rebake-host-macos.sh — drive the wine + granny2.dll re-bake against
# the user's data.grf, on a macOS host, producing
# `tests/fixtures/rebake-fresh/macos-host/manifest.json` for the
# devcontainer (or the same host) to verify.
#
# Prerequisites :
#   1. Wine.app or Wine Staging.app from https://www.winehq.org/download
#      installed under /Applications/. Version 9+ has built-in wow64
#      mode and runs the i386 PE shim without wine32on64.
#   2. Your iRO ver12 client at $RO_FOLDER (data.grf + granny2.dll).
#   3. `tests/fixtures/source/` populated with the same .gr2 fixtures as
#      the devcontainer (or any .gr2s you want to test — coverage is
#      content-addressed).
#
# Usage :
#   RO_FOLDER="$HOME/Games/iRO" ./scripts/rebake-host-macos.sh
#
# The script picks WINE_BIN automatically — set explicitly to override.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${RO_FOLDER:-}" ]; then
    echo "RO_FOLDER not set. Point it at your iRO client root (must contain data.grf + granny2.dll)." >&2
    exit 2
fi

export RO_FOLDER
echo "[rebake-host-macos] RO_FOLDER = $RO_FOLDER"
echo "[rebake-host-macos] running rebake..."
node scripts/rebake.mjs --target macos-host

echo
echo "[rebake-host-macos] done. Verify with :"
echo "   npm run verify:rebake -- --target macos-host"
