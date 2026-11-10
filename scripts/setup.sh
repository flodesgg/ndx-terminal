#!/usr/bin/env bash
# One-command setup on a clean Apple Silicon Mac (macOS 14+).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf "\033[33m▶ %s\033[0m\n" "$*"; }

if [[ "$(uname -m)" != "arm64" ]]; then echo "This project targets Apple Silicon (arm64)." >&2; fi

if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools (a dialog will open; re-run this script afterwards)"
  xcode-select --install || true
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required: https://brew.sh — install it, then re-run this script." >&2
  exit 1
fi

say "Homebrew packages (node, pnpm, uv, rustup)"
for pkg in node pnpm uv rustup; do
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

say "Rust stable toolchain"
rustup toolchain list | grep -q stable || rustup default stable
rustup target list --installed | grep -q aarch64-apple-darwin || rustup target add aarch64-apple-darwin

say "Python 3.12 + server dependencies (uv)"
uv python install 3.12
(cd "$ROOT/server" && uv sync)

say "Frontend dependencies (pnpm)"
(cd "$ROOT/app" && pnpm install)

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  say "Created .env from .env.example — add your free API keys there (all optional)"
fi

say "Generating shared TypeScript types"
"$ROOT/scripts/gen-types.sh"

say "Done. Start with: scripts/dev.sh"
