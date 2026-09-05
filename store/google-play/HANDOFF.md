# Google Play release handoff

Follow [`CHECKLIST.md`](./CHECKLIST.md). Repo prep is largely done; remaining steps need your Expo + Play Console login (account verification already done — skip it).

## Already in the repo

| Item | Path |
|------|------|
| Privacy policy | [`docs/privacy.md`](../../docs/privacy.md) |
| In-app About | [`packages/mobile/app/about.tsx`](../../packages/mobile/app/about.tsx) |
| Icons / splash | [`packages/mobile/assets/`](../../packages/mobile/assets/) |
| App config (`1.0.0` / `versionCode` 1 / cleartext) | [`packages/mobile/app.json`](../../packages/mobile/app.json) |
| EAS profiles | [`packages/mobile/eas.json`](../../packages/mobile/eas.json) |
| Listing copy | [`LISTING.md`](./LISTING.md), [`short-description.txt`](./short-description.txt), [`full-description.txt`](./full-description.txt) |
| Data safety | [`DATA_SAFETY.md`](./DATA_SAFETY.md) |
| Content rating | [`CONTENT_RATING.md`](./CONTENT_RATING.md) |
| Other App content forms | [`DECLARATIONS.md`](./DECLARATIONS.md) |
| Screenshot guide | [`SCREENSHOTS.md`](./SCREENSHOTS.md) |
| Feature graphic (1024×500) | [`feature-graphic.png`](./feature-graphic.png) |
| High-res Play icon (512×512) | [`icon-512.png`](./icon-512.png) |

## Your steps

### 1. Commit + push privacy policy to `main`

The repo is **already public**. Play only needs `docs/privacy.md` on `main` (local file is ready; GitHub still 404 until push):

`https://github.com/zeekliviu/cursor-remote/blob/main/docs/privacy.md`

No separate gist/hosting needed.

### 2. Link EAS

```bash
cd packages/mobile
npx eas-cli@latest login
npx eas-cli@latest init
```

Confirm `extra.eas.projectId` appears in `app.json` (CLI usually writes it).

### 3. Build the AAB

```bash
# from repo root
npm run mobile:build:android

# or
cd packages/mobile && npx eas-cli@latest build -p android --profile production
```

First production build: let EAS generate and store the Android keystore (choose yes when prompted). Save the credentials backup from the Expo dashboard.

### 4. Play Console app

1. Create app → name **Cursor Remote** → free / Productivity  
2. Store listing: paste from `short-description.txt` / `full-description.txt`  
3. Upload `icon-512.png`, `feature-graphic.png`, and **at least 2** phone screenshots (see `SCREENSHOTS.md`)  
4. Privacy policy URL (step 1)  
5. Data safety → `DATA_SAFETY.md`  
6. Content rating → `CONTENT_RATING.md`  
7. Ads: **No**; Target audience: not primarily children; News app: **No**  
8. **Internal testing** → upload AAB from EAS (or `npm run mobile:submit:android` with a Play service account JSON)

### 5. Smoke-test the release build

Install the internal-test build on a phone (not Expo Go):

- Pair with daemon over LAN  
- Open a chat, send a message  
- Attach a photo  
- Trigger an approval notification if possible  

### 6. Production

When Internal testing looks good → promote to Production (or closed testing first).

## Remaining manual TODOs

- [x] Commit + push (privacy URL live)
- [x] `eas login` + `eas init`  
- [x] First production AAB + keystore — [AAB](https://expo.dev/artifacts/eas/hYZ4H4AJKSJMY47FwqNsflmTlv6IAQO5XNR3F0bxa54.aab)  
- [ ] Play Console forms + Internal track upload (use `screenshots/` + `icon-512.png` + `feature-graphic.png`)  
- [ ] Optional: replace mockup screenshots with device captures; Play service account JSON for `eas submit`
