# Phone screenshots for Play Console

Play requires **at least 2** phone screenshots (JPEG/PNG, 16:9 or 9:16).

## In repo (ready to upload)

UI mockups matching the app chrome (1080×1920), good enough for Internal testing listing. Prefer replacing with device captures from the release/preview APK before Production.

| File | Scene |
|------|--------|
| `screenshots/01-home.png` | Hosts + projects |
| `screenshots/02-chat.png` | Chat + composer |
| `screenshots/03-approvals.png` | Tool approval sheet |
| `screenshots/04-pair.png` | Empty / pair CTA |

## Specs

| | |
|--|--|
| Min count | 2 |
| Max per type | 8 |
| Phone | 320–3840 px on each side; common: 1080×1920 or 1080×2400 |
| Format | PNG or JPEG |

## How to capture real device shots (optional upgrade)

1. Install preview/production APK from EAS (not Expo Go if possible).  
2. Android screenshot gesture.  
3. Overwrite files in `store/google-play/screenshots/`.  
4. Upload in Play Console → Store listing → Phone screenshots.

## Feature graphic

`feature-graphic.png` (1024×500). High-res icon: `icon-512.png`.

Validate: `npm run validate:play`
