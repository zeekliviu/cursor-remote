#!/usr/bin/env bash
set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
CURSOR_BIN="${CURSOR_BIN:-/Applications/Cursor.app/Contents/MacOS/Cursor}"

if [[ ! -x "$CURSOR_BIN" ]]; then
  echo "Cursor binary not found at $CURSOR_BIN"
  echo "Set CURSOR_BIN to your Cursor executable."
  exit 1
fi

echo "Starting Cursor with remote debugging on 127.0.0.1:${CDP_PORT}"
echo "Keep this port localhost-only. The daemon proxies to the phone."

exec "$CURSOR_BIN" --remote-debugging-port="$CDP_PORT" "$@"
