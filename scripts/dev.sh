#!/usr/bin/env bash
# Start the data service and the desktop app together (hot reload on both sides).
#   scripts/dev.sh          backend + Tauri window
#   scripts/dev.sh --web    backend + Vite only (open http://localhost:1420 in a browser)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

node "$ROOT/scripts/apply-brand.mjs" >/dev/null
export NDX_APP_NAME="$(node -p "require('$ROOT/brand.json').name")"
# Random free port and a per-launch random token (SPEC §1.5); no fixed-port fallback.
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
[[ ${#TOKEN} -eq 64 ]] || { echo "cannot generate a launch token" >&2; exit 1; }
MODE="${1:-tauri}"
# DEMO only when explicitly on; never pass an empty or "0" NDX_DEMO through to the backend.
case "${NDX_DEMO:-}" in 1 | true | yes | on) NDX_DEMO=1 ;; *) unset NDX_DEMO ;; esac

cleanup() {
  [[ -n "${BACK_PID:-}" ]] && kill "$BACK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ data service on 127.0.0.1:$PORT"
# Token via environment only: never argv (ps), never a VITE_* variable (would be inlined into the
# JS bundle). The Vite dev server hands it to same-origin pages at /__ndx/backend (vite.config.ts).
(cd "$ROOT/server" && NDX_PORT="$PORT" NDX_TOKEN="$TOKEN" NDX_DEV=1 ${NDX_DEMO:+NDX_DEMO=1} \
  exec uv run python -m ndx_server.main --reload) &
BACK_PID=$!

export NDX_DEV_PORT="$PORT" NDX_DEV_TOKEN="$TOKEN"
unset TOKEN
cd "$ROOT/app"
if [[ "$MODE" == "--web" ]]; then
  echo "▶ web UI on http://localhost:1420"
  pnpm dev
else
  echo "▶ Tauri window"
  pnpm tauri dev
fi
