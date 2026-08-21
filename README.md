# Cursor Remote Bridge

Your **phone becomes a remote for the Cursor IDE already open on your desk**.

Same Composer chats. Same models. Same continuity. The Expo app talks to a small host daemon; the daemon drives Cursor over **Chrome DevTools Protocol** and reads projects / history from Cursor’s local SQLite. Pair once over LAN, Tailscale, or VPN — then approve tools, pick models, and follow a run from the couch.

```
┌─────────────┐         LAN / Tailscale         ┌──────────────┐  localhost  ┌────────────┐
│  Phone app  │  ─────────────────────────────► │   Daemon     │ ──────────► │ Cursor CDP │
│  (Expo)     │         :7843 + token           │  HTTP + WS   │   :9222     │  (IDE)     │
└─────────────┘                                 └──────────────┘             └────────────┘
```

CDP never leaves the host. Only the daemon is on the network, and every call is Bearer-token authenticated.

> Pairing tokens and uploads live under `~/.cursor-remote/` (Windows: `%USERPROFILE%\.cursor-remote\`). They are **never** committed to git.

---

## Why this exists

Cursor’s agent loop is powerful on a big screen — and awkward when you step away. This bridge keeps the **same** IDE session alive: no second agent, no re-prompting context, no “cloud sync” of your chats. You remote the window that’s already open.

---

## What you can do

### On the host (daemon)

| Capability | What it means |
|------------|----------------|
| **Agents-panel switch** | Focuses the matching repo + chat in Cursor’s Agents → Repositories sidebar (React fiber `onSelectAgent`). Does **not** spawn windows or type into Open Recent. |
| **Messageable vs view-only** | Parent agent chats accept input; explore / subagent transcripts stay read-only on the phone. |
| **Typed approvals** | Classifies shell, network, deletion, external-file, MCP, and browser requests; preserves Skip / Run / Always Run and scopes actions to the exact dialog. |
| **Live agent activity** | One shared, event-driven CDP monitor pushes changed-only activity, approvals, and revisioned chat deltas. Full status strings stay intact for the phone header. |
| **Chat images** | Surfaces Composer attachments and screenshot assets; `GET /media` serves them with token auth. |
| **Latest-turn Files Changed** | Matches Cursor’s per-turn card — not the whole-chat edit history. |
| **Foreground Cursor** | Activates and un-minimizes the existing Cursor app before CDP clicks and when a project is selected (no new instances). |

### On the phone (Expo)

| Capability | What it means |
|------------|----------------|
| **Compact composer** | Attach · model chip · message · queue/send + separate stop on one row; long-press supports Interrupt & send. |
| **Cached model picker** | Opens instantly from a per-host cache; selection is local until you apply. Grouped by vendor (Anthropic, OpenAI, Google, Cursor, …). |
| **Conversation density** | Per-host Compact / Balanced / Detailed transcript modes with persisted expansion state. |
| **Turn summaries** | Cursor-style `Worked for …` rows, semantic tool clusters, visible failures, and the latest three turns kept easy to inspect. |
| **Approvals UI** | Compact approval dock opens a queue-aware sheet with risk/resource context and guarded persistent permissions. |
| **Artifact review** | Full-screen latest-turn file diffs, image gallery, terminal deep links, plan/todo/subagent rows. |
| **Foreground notifications** | Agent finished + needs approval while the app is active. The socket closes in background to save battery and performs a full sync on resume. |
| **Live status pulse** | Full activity label under the chat title (wraps; not truncated). |
| **Scroll-to-latest pill** | When you scroll up mid-run. |
| **Long-press copy / quote** | On message bubbles. |
| **Open in Cursor** | Project screen focuses that repo on the host. |
| **Host running strip** | Home / project when the agent is busy. |
| **Inline chat images** | Rendered under bubbles when the host has the files. |

### Efficient foreground sync

- One foreground WebSocket replaces overlapping activity, approval, health, and full-chat polling.
- Chat subscriptions send an initial snapshot followed by revisioned tail deltas; unchanged state emits no phone traffic.
- The daemon shares one debounced CDP observer across clients and watches Cursor’s SQLite/WAL files only for subscribed chats.
- Composer and terminal sockets close when the app backgrounds; terminal PTYs remain reattachable for up to one hour.
- A capability handshake enables the new protocol immediately while retaining a foreground-only fallback during rolling upgrades.

---

## Prerequisites

- [Node.js](https://nodejs.org/) **≥ 20**
- [Cursor](https://cursor.com/) installed
- Phone on the same network / Tailscale / VPN as the host
- **Windows:** [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (for `node-pty` + `better-sqlite3`)
- Optional: [Expo Go](https://expo.dev/go) for development

---

## First run on a new machine

```bash
git clone git@github.com:zeekliviu/cursor-remote.git
cd cursor-remote
npm run setup
```

`setup` installs deps, builds the daemon, and fixes macOS `node-pty` permissions.

### 1 — Start the daemon

```bash
npm run daemon:start
```

This builds if needed, checks CDP on `:9222`, and **starts Cursor with `--remote-debugging-port` if CDP is down**. If Cursor is already open *without* debugging, it quits and relaunches with CDP (set `CURSOR_REMOTE_NO_RESTART=1` to refuse that, or `CURSOR_REMOTE_SKIP_CDP_ENSURE=1` to skip entirely).

You can still launch CDP yourself first with `npm run cursor`.

You should see `listening on http://0.0.0.0:7843`. Open that URL in a browser on the host to see the pairing QR.

Token file (auto-created):

- macOS/Linux: `~/.cursor-remote/auth.json`
- Windows: `%USERPROFILE%\.cursor-remote\auth.json`

### 2 — Phone (Expo Go)

```bash
npm run mobile
```

Scan the QR from Expo, then in the app: **Add host** → scan the daemon pairing QR (or enter host / port `7843` / token). You can save several hosts (Mac + Windows) and switch between them on the home screen.

> Foreground notifications, clipboard, and haptics work in Expo Go. The app intentionally does not keep a background socket or use remote push.

### 3 — Sanity check

```bash
npm run doctor
```

---

## Local test checklist

| Step | Action | Expect |
|------|--------|--------|
| Setup | `npm run setup` | Build OK |
| Daemon | `npm run daemon:start` | Cursor+CDP up; `/healthz` → `{ ok: true }` |
| CDP | open `http://127.0.0.1:9222/json/version` | Browser shows Chrome version JSON |
| Pair | Phone → Add host → scan `:7843` QR | Projects list loads |
| Chat | Open a **messageable** project chat | Messages stream; Send works when CDP is up |
| Switch | Open another chat / project | Same Cursor window; Agents panel selects repo + chat |
| View-only | Open an explore / subagent chat | Banner + no composer input |
| Approval | Trigger a tool that needs Run/Skip | One clean card; actions work |
| Attach | Send a photo | Path under `~/.cursor-remote/uploads/…`; preview when the host has the file |
| Model | Tap model chip | Sheet opens from cache; Apply switches host model |
| Terminal | Project → Term | Shell in **project root** (PowerShell on Windows) |
| Diff | Project → Diff | Git status for that repo |
| Open | Project → Open | Host Agents panel focuses that repo |
| Multi-host | Add a second machine, Switch | Active host changes; projects refresh |

---

## Everyday commands

| Script | Purpose |
|--------|---------|
| `npm run setup` | Fresh clone: install + build |
| `npm run doctor` | Check Node / build / CDP / daemon |
| `npm run cursor` | Launch Cursor with `--remote-debugging-port=9222` |
| `npm run daemon:start` | Run daemon (builds if needed; ensures Cursor CDP) |
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
CURSOR_REMOTE_SKIP_CDP_ENSURE=1  # daemon:start does not launch/relaunch Cursor
CURSOR_REMOTE_NO_RESTART=1       # do not quit a non-CDP Cursor to relaunch
```

---

## Always-on (optional)

1. Install [Tailscale](https://tailscale.com) (or your VPN) on host + phone.
2. Run the daemon at login (`daemon:start` will bring up Cursor+CDP if needed):
   - **macOS:** edit paths in `scripts/com.cursorremote.daemon.plist` → copy to `~/Library/LaunchAgents/` → `launchctl load …` (helper: `scripts/run-daemon-service.sh`)
   - **Windows:** see [docs/windows.md](docs/windows.md) (Task Scheduler)

Keep CDP off the LAN; bind the daemon on Tailscale / LAN with token auth only.

---

## API (Bearer token)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/projects` | Workspace list |
| POST | `/projects/:id/open` | Select repo in Agents → Repositories panel |
| GET | `/projects/:id/chats` | IDE chats (`messageable` flag) |
| GET | `/chats/:id` | Transcript (+ `images` when available) |
| GET | `/media?path=&token=` | Host image file for chat attachments |
| GET | `/projects/:id/diff` | Git status + patch |
| GET | `/composer/health` | CDP + selector health |
| GET | `/composer/activity` | Live status + `running` + current model |
| GET | `/composer/confirmations` | Pending Run/Skip-style approvals |
| POST | `/composer/confirmations` | Act on an approval |
| POST | `/composer/select` | Bind window by project + select chat |
| POST | `/composer/new-chat` | New Composer chat in project |
| POST | `/composer/stop` | Stop running generation |
| POST | `/composer/send` | Type + submit in Composer |
| POST | `/composer/model` | Pick model / params |
| POST | `/composer/upload` | Base64 attachment → `~/.cursor-remote/uploads` |
| WS | `/terminal?token=` | PTY in project root |
| WS | `/composer?token=` | Initial state + changed-only activity, confirmations, and revisioned chat deltas |

---

## Security

- Treat the phone as a trusted device: terminal + Composer have full host-user power.
- Rotate token: `POST /auth/rotate` (authenticated) — then re-pair the phone.
- Do **not** commit `auth.json`, `.env`, or upload folders (gitignored).
- Do not expose CDP or the daemon to the public internet without Tailscale/ACL.
- `/media` only serves image paths under Cursor user dirs, `~/.cursor`, and `~/.cursor-remote`.

---

## Selector maintenance

Cursor UI updates can break CDP selectors. See [docs/selectors.md](docs/selectors.md) and [docs/cdp-help.md](docs/cdp-help.md).

Helper (with CDP up):

```bash
node scripts/find-onselect.mjs
```

Probes Agents panel React fiber props when selectors drift.

---

## Repo layout

```
packages/shared   # Shared API types
packages/daemon   # Host bridge (HTTP, WS, CDP, SQLite)
packages/mobile   # Expo phone app
scripts/          # setup, cursor launch, daemon, launchd helpers
docs/             # Windows, selectors, CDP tuning
```
