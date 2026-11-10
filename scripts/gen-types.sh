#!/usr/bin/env bash
# Regenerate shared/openapi.json and shared/api.d.ts from the FastAPI schema.
# --check (run by make check): generate into a temp folder and fail if shared/ has drifted from
# the server models, without touching tracked files (SPEC §11 "front and back can't drift").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1
OUT="$ROOT/shared"
[[ $CHECK == 1 ]] && OUT="$TMP/out" && mkdir -p "$OUT"
cd "$ROOT/server"
NDX_KEYRING=0 NDX_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d " \\n")" \
  NDX_DATA_DIR="$TMP/data" NDX_LOG_DIR="$TMP/logs" uv run python -c '
import json, sys
from ndx_server.main import create_app
spec = create_app(start_background=False).openapi()
json.dump(spec, sys.stdout, indent=1, sort_keys=True)
' > "$OUT/openapi.json"
cd "$ROOT/app"
pnpm exec openapi-typescript "$OUT/openapi.json" -o "$OUT/api.d.ts" >/dev/null
if [[ $CHECK == 1 ]]; then
  if ! diff -q "$OUT/openapi.json" "$ROOT/shared/openapi.json" >/dev/null ||
    ! diff -q "$OUT/api.d.ts" "$ROOT/shared/api.d.ts" >/dev/null; then
    echo "type drift: shared/ does not match the server models — run make types" >&2
    diff -u "$ROOT/shared/openapi.json" "$OUT/openapi.json" | head -40 >&2 || true
    exit 1
  fi
  echo "types: shared/ matches the server models"
  exit 0
fi
echo "types written to shared/api.d.ts"
