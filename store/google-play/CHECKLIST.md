# Google Play — master checklist

Skip Play developer **account verification** (already done). Work top to bottom.

## Repo / app (agent or local)

- [x] Privacy policy (`docs/privacy.md`) + in-app About link
- [x] App identity: `com.cursorremote.app`, version `1.0.0`, `versionCode` 1
- [x] Icons / splash / adaptive icon
- [x] Feature graphic **1024×500** + Play icon **512×512** under `store/google-play/`
- [x] Cleartext LAN for daemon (`expo-build-properties`)
- [x] Camera / photos / notifications plugins + blocked unused storage/mic perms
- [x] EAS build profiles (`eas.json`) + npm scripts
- [x] Listing copy (`LISTING.md`, `short-description.txt`, `full-description.txt`)
- [x] Data safety answers (`DATA_SAFETY.md`)
- [x] Content rating answers (`CONTENT_RATING.md`)
- [x] Ads / audience / news declarations (`DECLARATIONS.md`)
- [x] Screenshot capture guide (`SCREENSHOTS.md`)
- [x] Phone screenshots (4× 1080×1920 UI mockups in `screenshots/`)
- [x] Asset validator (`npm run validate:play`)
- [x] `eas login` + `eas init` (project `d3b29486-57c5-4990-b7e9-d7f7a34b9175`)
- [x] First production **AAB** — [download](https://expo.dev/artifacts/eas/hYZ4H4AJKSJMY47FwqNsflmTlv6IAQO5XNR3F0bxa54.aab) · local `store/google-play/releases/cursor-remote-1.0.0-vc1.aab` · [build logs](https://expo.dev/accounts/zeekliviu/projects/cursor-remote/builds/4eea0978-3e8b-4d78-9dbf-8bd9a4624131)
- [x] **Commit + push** `docs/privacy.md` (and Play prep) to public `main` — https://github.com/zeekliviu/cursor-remote/blob/main/docs/privacy.md
- [ ] Optional: replace mockup screenshots with device captures before Production

## Play Console (you)

- [ ] Create app “Cursor Remote” (free / productivity)
- [ ] Store listing: paste short/full description; upload icon, feature graphic, screenshots
- [ ] Privacy policy URL (GitHub `docs/privacy.md` on `main`)
- [ ] Data safety form (`DATA_SAFETY.md`)
- [ ] Content rating questionnaire (`CONTENT_RATING.md`)
- [ ] Target audience / news / COVID / ads declarations (no ads; not for children; not a news app)
- [ ] Internal testing track → upload AAB (or `eas submit`)
- [ ] Smoke-test installed build (pair, chat, photo, approval)
- [ ] Promote when ready (closed → production)

Details: [`HANDOFF.md`](./HANDOFF.md) · upload steps: [`INTERNAL_UPLOAD.md`](./INTERNAL_UPLOAD.md)
