# Privacy Policy — Cursor Remote

**Last updated:** 2026-09-05

This privacy policy applies to the **Cursor Remote** mobile application (`com.cursorremote.app`) published by the developer of this open-source project.

## What the app does

Cursor Remote is a companion app that connects your phone to a **Cursor Remote daemon** you run on your own computer (Mac or Windows). The daemon talks to the Cursor IDE on that machine. Pairing uses a host address, port, and token that you scan or enter yourself.

## Data we collect

**We do not operate a cloud backend for this app.** There is no Cursor Remote account, no analytics SDK, and no advertising network in the mobile app.

Data that may be stored **on your device**:

- Saved host profiles (label, IP/hostname, port, pairing token)
- Local UI preferences (for example chat density / expansion state)
- Message drafts for open chats

Data that may travel **only between your phone and your daemon** (on your LAN, VPN, or Tailscale):

- Chat transcripts and project metadata read from Cursor on your host
- Messages, attachments, and approvals you send from the phone
- Terminal input/output if you use the in-app terminal
- Local notification content for agent status on the phone

The developer of Cursor Remote does **not** receive your code, chats, tokens, or photos.

## Permissions

The app may request:

| Permission | Why |
|------------|-----|
| **Camera** | Scan the daemon pairing QR code; optionally capture a photo to attach to Composer |
| **Photos / media** | Attach images from your gallery to Composer messages |
| **Notifications** | Local alerts when the agent needs approval or finishes work (no remote push server) |
| **Network** | Reach your daemon over the local network or VPN |

You can deny optional permissions; core pairing still works if you enter host details manually.

## Data sharing

We do not sell or share personal data with third parties. Traffic goes to the host you configure. If that host is a machine you control, you control the data. Third-party services are limited to distribution (e.g. Google Play) and whatever network path you use to reach your own daemon.

## Security

Pairing tokens are stored on-device. Keep your daemon token private. Prefer trusted networks (home LAN, VPN, Tailscale). The daemon binds on your network; do not expose it to the public internet without additional protections.

## Children’s privacy

The app is not directed at children under 13. Do not use it if you are under 13.

## Changes

We may update this policy in the repository. Continued use after an update constitutes acceptance of the revised policy.

## Contact

Questions about this policy: open an issue on the project repository  
[https://github.com/zeekliviu/cursor-remote](https://github.com/zeekliviu/cursor-remote)  
or contact the Play Store listing support email for the published app.
