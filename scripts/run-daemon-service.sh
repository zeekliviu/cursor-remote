# Always-on helper for macOS launchd (optional)
# Install:
#   cp scripts/com.cursorremote.daemon.plist ~/Library/LaunchAgents/
#   # edit paths inside the plist first
#   launchctl load ~/Library/LaunchAgents/com.cursorremote.daemon.plist

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export PORT="${PORT:-7843}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
export CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
export DATA_DIR="${DATA_DIR:-$HOME/.cursor-remote}"

cd "$ROOT"
exec node "$ROOT/packages/daemon/dist/index.js"
