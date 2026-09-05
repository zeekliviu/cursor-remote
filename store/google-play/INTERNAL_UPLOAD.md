# Play Console — Internal testing upload

Use this after the app exists in Play Console (create “Cursor Remote” if needed).

## Artifact

| | |
|--|--|
| AAB (Expo) | https://expo.dev/artifacts/eas/hYZ4H4AJKSJMY47FwqNsflmTlv6IAQO5XNR3F0bxa54.aab |
| AAB (local copy) | `store/google-play/releases/cursor-remote-1.0.0-vc1.aab` (~80 MB, gitignored) |
| Build | https://expo.dev/accounts/zeekliviu/projects/cursor-remote/builds/4eea0978-3e8b-4d78-9dbf-8bd9a4624131 |
| Package | `com.cursorremote.app` |
| Version | `1.0.0` (versionCode **1**) |

Download the `.aab` (or use the local copy under `releases/`), then: **Play Console → Cursor Remote → Testing → Internal testing → Create new release → Upload**.

Or from this machine after you create a Play Console API service account JSON
(see https://expo.fyi/creating-google-service-account), save it outside git as
e.g. `%USERPROFILE%\play-service-account.json` (never commit it), then:

```bash
cd packages/mobile
npx eas-cli@latest submit -p android --profile production --latest --service-account-path "%USERPROFILE%\play-service-account.json"
```

Without that JSON, upload the AAB manually in Play Console (recommended for first release).

## Store listing assets (local)

| Asset | Path |
|-------|------|
| Short description | `store/google-play/short-description.txt` |
| Full description | `store/google-play/full-description.txt` |
| Icon 512 | `store/google-play/icon-512.png` |
| Feature graphic | `store/google-play/feature-graphic.png` |
| Screenshots | `store/google-play/screenshots/01-home.png` … `04-pair.png` |
| Privacy URL | `https://github.com/zeekliviu/cursor-remote/blob/main/docs/privacy.md` (**push `docs/privacy.md` first**) |

## App content forms

- Data safety → `DATA_SAFETY.md`
- Content rating → `CONTENT_RATING.md`
- Ads / audience / news → `DECLARATIONS.md`
