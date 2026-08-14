# Selector fine-tuning guide

CDP automation targets Cursor's Electron DOM. After a Cursor update, send/model/chat selectors may break.

## Symptoms

- `GET /composer/health` reports `selectorsOk: false`
- Mobile banner: "selectors need tune"
- Send succeeds in API but nothing appears in Composer

## How to update

1. Launch Cursor with debugging:
   - macOS: `./scripts/launch-cursor-debug.sh`
   - Windows: `./scripts/launch-cursor-debug.ps1`
2. Open Chrome/Edge at `http://127.0.0.1:9222` and inspect the workbench page.
3. Find:
   - chat input (`contenteditable` / textarea)
   - send button
   - sidebar chat rows
   - model picker button + options
   - confirmation dialogs
4. Edit `packages/daemon/selectors/default.json` (or add `selectors/<version>.json`).
5. Reload without restart:
   ```bash
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"name":"default"}' \
     http://127.0.0.1:7843/selectors/reload
   ```
6. Re-check `/composer/health`.

## Tips

- Prefer stable attributes (`aria-label`, `data-testid`) over hashed class names.
- Keep multiple fallbacks in each array; first match wins.
- Confirmations must stay explicit on the phone — never auto-accept high-risk actions.
