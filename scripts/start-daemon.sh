#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PORT="${PORT:-7843}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
export CDP_URL="${CDP_URL:-http://127.0.0.1:${CDP_PORT:-9222}}"
export DATA_DIR="${DATA_DIR:-$HOME/.cursor-remote}"

if [[ ! -f "$ROOT/packages/daemon/dist/index.js" ]]; then
  echo "[cursor-remote] dist missing — building…"
  npm run build
fi

# Ensure node-pty helper is executable (macOS)
node "$ROOT/packages/daemon/scripts/fix-pty-perms.mjs" >/dev/null 2>&1 || true

exec npm run daemon
