# Windows setup

## One-time

1. Install [Node.js ≥ 20](https://nodejs.org/) and [Cursor](https://cursor.com/).
2. Install **Desktop development with C++** (Visual Studio Build Tools) so `node-pty` and `better-sqlite3` compile.
3. Clone and setup:

```powershell
git clone https://github.com/zeekliviu/cursor-remote.git
cd cursor-remote
npm run setup
```

## Local test (each session)

```powershell
# Terminal A — daemon (auto-starts Cursor with CDP if needed)
npm run daemon:start

# Terminal B — Expo (from your Mac is fine too; phone only needs the Windows host reachable)
npm run mobile
```

If Cursor was already open without debugging, `daemon:start` quits and relaunches it with `--remote-debugging-port=9222`. To skip that: `$env:CURSOR_REMOTE_NO_RESTART=1`.

Open `http://127.0.0.1:7843` on the PC, scan the QR in the phone app (**Add host**, label e.g. `PC birou`).

Check:

```powershell
npm run doctor
```

Token / uploads: `%USERPROFILE%\.cursor-remote\` (not in the git repo).

## Notes vs macOS

| Area | Windows |
|------|---------|
| Terminal PTY | PowerShell in the **project root** |
| Uploads | Saved under `%USERPROFILE%\.cursor-remote\uploads\` |
| Cursor data | `%APPDATA%\Cursor\User\…` |
| CDP launch | `npm run cursor` or `.\scripts\launch-cursor-debug.ps1` |

## Always-on (Task Scheduler)

At logon, call `npm run daemon:start` (or `node scripts\run-daemon.mjs`) after `npm run setup` once. That entry point ensures Cursor is running with CDP, then starts the daemon.

Alternatively, point Task Scheduler at:

- Program: `node`
- Arguments: `C:\path\to\cursor-remote\scripts\run-daemon.mjs`
- Start in: `C:\path\to\cursor-remote`
- Env (optional): `PORT=7843`, `BIND_HOST=0.0.0.0`, `CDP_URL=http://127.0.0.1:9222`, `DATA_DIR=%USERPROFILE%\.cursor-remote`
