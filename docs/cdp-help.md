# Helping tune CDP selectors

The model picker / send / chat list depend on CSS selectors against Cursor’s Electron UI.
Those break when Cursor updates. Live scrape only works if the selectors hit the right nodes.

## What helps most (pick any)

### 1. Screenshot of the open model menu
On the Mac, open Composer → click the model dropdown so the full list + effort options are visible → screenshot → send it in chat.

### 2. Copy selector from Chrome DevTools on the debug port
1. Quit Cursor, start with `./scripts/launch-cursor-debug.sh`
2. In Chrome open `http://127.0.0.1:9222`
3. Open the Cursor workbench target
4. Click the **model picker button**, then an **option row**, then an **effort chip**
5. In Elements, right‑click each → Copy → Copy selector (or Copy JS path)
6. Paste those 3 selectors here

### 3. Dump live scrape output
With daemon + Cursor debug running:

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.cursor-remote/auth.json'))['token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7843/composer/models | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7843/composer/health | python3 -m json.tool
```

Paste the JSON (especially `models`, `efforts`, `issues`).

### 4. Edit the selector pack yourself
File: `packages/daemon/selectors/default.json`

Keys that matter for models:
- `modelPickerButton` (prefer `.ui-model-picker__trigger`)
- `modelOption` (prefer `.ui-model-picker__item-content-name`)

Current Cursor UI: open picker → expand the **Model / Auto** submenu → scrape name rows.
Effort is usually part of the model label (e.g. `Opus 5 High`), not a separate chip.

Then:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"default"}' \
  http://127.0.0.1:7843/selectors/reload
```

Or restart the daemon.

## Goal
`GET /composer/models` should return the same labels you see in the Cursor dropdown (Auto, Composer, Claude… + effort chips), not a single item and not an empty list.
