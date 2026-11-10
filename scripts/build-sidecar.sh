#!/usr/bin/env bash
# Build the Python data service for the Tauri sidecar.
#
# PyInstaller --onedir (fast start: no per-launch unpacking, ~0.7 s warm vs ~6 s for --onefile)
# goes into the bundle's Resources/server; the sidecar registered with Tauri (externalBin) is a tiny
# launcher that execs it, so Tauri still owns the process (same PID) for spawn/kill.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}')"
TRIPLE="${TRIPLE:-aarch64-apple-darwin}"
TAURI="$ROOT/app/src-tauri"
mkdir -p "$TAURI/binaries" "$TAURI/resources"

cd "$ROOT/server"
uv sync --quiet
uv run pyinstaller run_server.py \
  --name ndx-server \
  --onedir \
  --noconfirm \
  --clean \
  --log-level WARN \
  --distpath build/dist \
  --workpath build/work \
  --specpath build \
  --collect-submodules uvicorn \
  --collect-submodules websockets \
  --collect-submodules ndx_server \
  --collect-all exchange_calendars \
  --collect-all yfinance \
  --collect-all curl_cffi \
  --collect-data certifi \
  --add-data "$ROOT/data/symbology:symbology" \
  --exclude-module tkinter \
  --exclude-module matplotlib \
  --exclude-module IPython \
  --exclude-module pytest

rm -rf "$TAURI/resources/ndx-server"
cp -R build/dist/ndx-server "$TAURI/resources/ndx-server"

LAUNCHER="$TAURI/binaries/ndx-server-$TRIPLE"
cat > "$LAUNCHER" <<'SH'
#!/bin/sh
# Tauri sidecar launcher: Contents/MacOS/ndx-server -> Contents/Resources/server/ndx-server
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/../Resources/server/ndx-server" "$@"
SH
chmod +x "$LAUNCHER"
echo "sidecar: $LAUNCHER -> resources/ndx-server ($(du -sh "$TAURI/resources/ndx-server" | cut -f1))"
