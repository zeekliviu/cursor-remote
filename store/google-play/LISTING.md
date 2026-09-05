# Google Play — Cursor Remote

Use these strings in Play Console. Update dates/URLs if needed.

## App identity

| Field | Value |
|-------|--------|
| Application id | `com.cursorremote.app` |
| Default language | English (United States) |
| App name | Cursor Remote |
| Version name | 1.0.0 |
| Version code | 1 |

## Short description (≤80 characters)

```
Remote Cursor IDE from your phone — chats, approvals, models, terminal.
```

## Full description

```
Cursor Remote turns your phone into a companion for Cursor on your Mac or Windows PC.

Pair over Wi‑Fi, VPN, or Tailscale with a QR code from the host daemon. Then:

• Browse projects and open agent chats
• Send follow-ups, queue messages, and stop the agent
• Approve or deny tool requests when Cursor needs you
• Switch models and options from your phone
• Attach photos to Composer
• Open a project terminal when you need a shell

Everything stays on your machine. The phone talks only to the daemon you run locally — there is no Cursor Remote cloud account and no analytics backend.

Requirements: Cursor IDE with remote debugging, the open-source Cursor Remote daemon on the same network as your phone, and Expo/Android build from this project.
```

## Privacy policy URL

https://github.com/zeekliviu/cursor-remote/blob/main/docs/privacy.md

## Category

Productivity (or Tools)

## Contact

Use your Play Console developer email as the support email.

## Graphics checklist

| Asset | Spec | Status in repo |
|-------|------|----------------|
| App icon | 512×512 Play upload (EAS also embeds from `assets/icon.png`) | `packages/mobile/assets/icon.png` |
| Feature graphic | 1024×500 | `store/google-play/feature-graphic.png` (correct size) |
| High-res icon | 512×512 | `store/google-play/icon-512.png` |
| Phone screenshots | min 2, 16:9 or 9:16 | **TODO — capture on device** (`SCREENSHOTS.md`) |
| Tablet screenshots | optional | skip for v1 |

## Data safety (suggested answers)

- **Collects personal data?** No cloud collection by the publisher. App stores pairing tokens and preferences **on device** only.
- **Data shared with third parties?** No (except Google Play / OS).
- **Collected / processed on device / your daemon:** approximate location not collected; photos only if user attaches; messages only between phone and user host.
- **Security practices:** Data encrypted in transit if you use VPN/Tailscale; cleartext HTTP is used for LAN daemon by design — disclose “data may travel on the local network”.
- **Children:** Not targeted at children; no COPPA appeal needed if “not for children”.

## Content rating

See [`CONTENT_RATING.md`](./CONTENT_RATING.md). Expect “Everyone” / equivalent.

## Permissions declarations (Play Console forms)

- **Camera** — QR pairing + optional photo capture for Composer
- **Photos** — attach gallery images to Composer
- **Notifications** — local agent status / approval alerts (no FCM remote push)

## Release track plan

1. Internal testing — upload first AAB, add yourself as tester
2. Closed testing (optional)
3. Production

## Build commands (after `eas login` + `eas init`)

```bash
cd packages/mobile
npx eas-cli@latest login
npx eas-cli@latest init   # paste projectId into app.json extra.eas.projectId
npx eas-cli@latest build -p android --profile production
npx eas-cli@latest submit -p android --profile production   # or upload AAB manually
```
