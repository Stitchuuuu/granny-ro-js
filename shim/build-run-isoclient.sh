#!/usr/bin/env bash
# Build + run the EXHAUSTIVE iso-client granny oracle — HOST (mingw-w64 + Wine).
#
# Compiles gr2_worldpose_isoclient.c, drops the exe next to granny2.dll in the
# oracle-run dir, and runs it on guildflag90_1.gr2 (loops ALL meshes, dumps the
# InitialPlacement, compares DLL-deformer vs manual-LBS and NULL-offset vs
# InitialPlacement-offset). Output -> wp-flag-isoclient.log.
#
# Prereqs (host): i686-w64-mingw32-gcc (mingw-w64) + wine (Staging).
#   macOS:  brew install mingw-w64   ;  Wine Staging.app or `brew install --cask wine-stable`
#
# Usage (from anywhere on the HOST — NOT the container; /workspace does not exist on host):
#   bash <repo>/granny-ro-js/shim/build-run-isoclient.sh
#   WINE_BIN="/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine" \
#     bash <repo>/granny-ro-js/shim/build-run-isoclient.sh
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORACLE="$DIR/../../iRO_ver12.0-full-client-data/sandbox/oracle-run"
CC="${MINGW_CC:-i686-w64-mingw32-gcc}"
WINE="${WINE_BIN:-wine}"

command -v "$CC"   >/dev/null || { echo "FATAL: $CC not found (brew install mingw-w64)"; exit 1; }
command -v "$WINE" >/dev/null 2>&1 || "$WINE" --version >/dev/null 2>&1 || { echo "FATAL: wine not runnable — set WINE_BIN"; exit 1; }
[ -f "$ORACLE/granny2.dll" ]        || { echo "FATAL: $ORACLE/granny2.dll missing"; exit 1; }
[ -f "$ORACLE/guildflag90_1.gr2" ]  || { echo "FATAL: $ORACLE/guildflag90_1.gr2 missing"; exit 1; }

echo ">>> compiling gr2_worldpose_isoclient.exe"
"$CC" -static -O2 -o "$ORACLE/gr2_worldpose_isoclient.exe" "$DIR/gr2_worldpose_isoclient.c" -lm \
  || { echo "FATAL: compile failed"; exit 2; }

echo ">>> running under wine (all meshes, guildflag90_1.gr2)"
cd "$ORACLE" || exit 1
export WINEDEBUG="${WINEDEBUG:--all}"
# Fix for the containerized wine (Debian wine-8.0): the default wineserver temp
# dir under /tmp can be non-writable / root-owned → "chdir ... Permission denied".
# Force a prefix WE own and init it once. On macOS, set WINE_BIN to your app and
# this still works (a fresh prefix in $HOME):
#   WINE_BIN="/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine" bash build-run-isoclient.sh
export WINEPREFIX="${WINEPREFIX:-$HOME/.wine-iso}"
if [ ! -f "$WINEPREFIX/system.reg" ]; then
  echo "    initializing WINEPREFIX=$WINEPREFIX"
  "${WINE%wine}wineboot" -i >/dev/null 2>&1 || "$WINE" wineboot -i >/dev/null 2>&1 || true
fi
LOG="$ORACLE/wp-flag-isoclient.log"
"$WINE" gr2_worldpose_isoclient.exe guildflag90_1.gr2 5.6667 24 >"$LOG" 2>&1
echo "    exit=$?"
echo ">>> KEY LINES (InitialPlacement dump, A-vs-B, DLL-vs-LBS, root bone scale):"
grep -iE "model\[0\] float|m\+ ?[0-9]|root bone|A NULL|B Init|DLL deform|LBS manual|mesh\[|RAW mesh|DONE" "$LOG" | sed 's/^/    /'
echo ">>> full log: $LOG"
