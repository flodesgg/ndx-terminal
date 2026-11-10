#!/usr/bin/env bash
# Build the macOS .app (and .dmg) with the Python data service bundled as a Tauri sidecar.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

node "$ROOT/scripts/apply-brand.mjs"
"$ROOT/scripts/gen-types.sh"
"$ROOT/scripts/build-sidecar.sh"
cd "$ROOT/app"
pnpm tauri build --config src-tauri/tauri.bundle.conf.json "$@"
BUNDLE="$ROOT/app/src-tauri/target/release/bundle"
echo
echo "built:"
ls -d "$BUNDLE"/macos/*.app "$BUNDLE"/dmg/*.dmg 2>/dev/null || true
