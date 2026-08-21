#!/usr/bin/env bash
set -euo pipefail

# Prefer the cross-platform entry (builds + ensures Cursor CDP).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node "$ROOT/scripts/run-daemon.mjs"
