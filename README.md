# Cursor Remote Bridge

Control a **local Cursor IDE** from your phone over LAN / VPN / Tailscale. The phone talks to a host daemon; the daemon drives the open Cursor window via **CDP** (same Composer chats, models, continuity) and reads projects/history from Cursor's local SQLite.

> Pairing tokens and uploads live under `~/.cursor-remote/` (Windows: `%USERPROFILE%\.cursor-remote\`). They are **never** committed to git.

## Architecture

- **Daemon** (macOS / Windows): HTTP + WebSocket on `:7843`, SQLite reader, CDP driver, git diff, PTY terminal
- **Mobile** (Expo iOS / Android): multi-host pair/switch, projects, chats, Composer send, model picker, diff, terminal
- **CDP `:9222` stays on localhost**; only the daemon is reachable on the network (token auth)

```
Phone (Expo)  --LAN/VPN-->  Daemon :7843  --localhost-->  Cursor CDP :9222
```

## Prerequisites

- [Node.js](https://nodejs.org/) **≥ 20**
- [Cursor](https://cursor.com/) installed
- Phone on the same network / Tailscale / VPN as the host
- **Windows:** [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (for `node-pty` + `better-sqlite3` native builds)
- Optional: [Expo Go](https://expo.dev/go) on the phone for development

## First run on a new machine

```bash
git clone git@github.com:zeekliviu/cursor-remote.git
cd cursor-remote
npm run setup
```

`setup` installs deps, builds the daemon, and fixes macOS `node-pty` permissions.

### 1 — Start Cursor with CDP

Quit Cursor completely first, then:

```bash
npm run cursor
```

(macOS/Windows wrapper. Or: `./scripts/launch-cursor-debug.sh` / `.\scripts\launch-cursor-debug.ps1`)

### 2 — Start the daemon

```bash
npm run daemon:start
```

You should see `listening on http://0.0.0.0:7843`. Open that URL in a browser on the host to see the pairing QR.

Token file (auto-created):

- macOS/Linux: `~/.cursor-remote/auth.json`
- Windows: `%USERPROFILE%\.cursor-remote\auth.json`

### 3 — Phone (Expo Go)

```bash
npm run mobile
```

Scan the QR from Expo, then in the app: **Add host** → scan the daemon pairing QR (or enter host / port `7843` / token). You can save several hosts (Mac + Windows) and switch between them on the home screen.

### 4 — Sanity check

```bash
npm run doctor
```

## Local test checklist

| Step | Command / action | Expect |
|------|------------------|--------|
| Setup | `npm run setup` | Build OK |
| CDP | `npm run cursor` | `http://127.0.0.1:9222/json/version` works in browser |
| Daemon | `npm run daemon:start` | `/healthz` → `{ ok: true }` |
| Pair | Phone → Add host → scan `:7843` QR | Projects list loads |
| Chat | Open a project chat | Messages stream; Send works when CDP up |
| Attach | Send a photo | Path under `~/.cursor-remote/uploads/…` in the prompt |
| Terminal | Project → Term | Shell in **project root** (PowerShell on Windows) |
| Diff | Project → Diff | Git status for that repo |
| Multi-host | Add a second machine, Switch | Active host changes; projects refresh |

## Everyday commands

| Script | Purpose |
|--------|---------|
| `npm run setup` | Fresh clone: install + build |
| `npm run doctor` | Check Node / build / CDP / daemon |
| `npm run cursor` | Launch Cursor with `--remote-debugging-port=9222` |
| `npm run daemon:start` | Run daemon (builds if `dist` missing) |
| `npm run daemon:dev` | Daemon with `tsx watch` |
| `npm run mobile` | Expo with `--clear` |
| `npm run build` | Rebuild shared + daemon only |

Env overrides (optional):

```bash
PORT=7843
BIND_HOST=0.0.0.0
CDP_URL=http://127.0.0.1:9222
CDP_PORT=9222
DATA_DIR=~/.cursor-remote   # Windows: %USERPROFILE%\.cursor-remote
CURSOR_BIN=/path/to/Cursor  # if not in the default install location
```

## Always-on (optional)

1. Install [Tailscale](https://tailscale.com) (or your VPN) on host + phone.
2. Start Cursor with CDP at login (`npm run cursor` / scheduled task).
3. Run the daemon at login:
   - **macOS:** edit paths in `scripts/com.cursorremote.daemon.plist` → copy to `~/Library/LaunchAgents/` → `launchctl load …` (helper: `scripts/run-daemon-service.sh`)
   - **Windows:** see [docs/windows.md](docs/windows.md) (Task Scheduler)

Keep CDP off the LAN; bind the daemon on Tailscale / LAN with token auth only.

## API (Bearer token)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/projects` | Workspace list |
| GET | `/projects/:id/chats` | IDE chats |
| GET | `/chats/:id` | Transcript |
| GET | `/projects/:id/diff` | Git status + patch |
| GET | `/composer/health` | CDP + selector health |
| POST | `/composer/send` | Type + submit in Composer |
| POST | `/composer/model` | Pick model / params |
| WS | `/terminal?token=` | PTY in project root |
| WS | `/composer?token=` | Live DOM events |

## Security

- Treat the phone as a trusted device: terminal + Composer have full host-user power.
- Rotate token: `POST /auth/rotate` (authenticated) — then re-pair the phone.
- Do **not** commit `auth.json`, `.env`, or upload folders (gitignored).
- Do not expose CDP or the daemon to the public internet without Tailscale/ACL.

## Selector maintenance

Cursor UI updates can break CDP selectors. See [docs/selectors.md](docs/selectors.md) and [docs/cdp-help.md](docs/cdp-help.md).

## Repo layout

```
packages/shared   # API types
packages/daemon   # bridge server
packages/mobile   # Expo app
scripts/          # setup, cursor, daemon, launchd helpers
docs/             # Windows, selectors, CDP tuning
```
