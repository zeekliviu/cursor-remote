# Google Play Data safety — suggested answers

Fill Play Console → App content → Data safety using these answers. Adjust if you add analytics or accounts later.

## Overview questions

| Question | Answer |
|----------|--------|
| Does your app collect or share any of the required user data types? | **No** — publisher does not collect data on a backend. Pairing tokens and preferences stay **on the device**. Chats/files stay on the **user’s own daemon host**. |
| Is all user data encrypted in transit? | **Yes, with caveats** — declare that traffic to the user-run daemon may use **HTTP on the local network / VPN**; recommend Tailscale/VPN. OS/network encryption applies when using VPN. |
| Do you provide a way for users to request deletion? | **Yes** — user can clear hosts in-app (“Clear all hosts”) which removes stored pairing tokens; uninstall removes local data. No cloud account to delete. |

## Data types

Mark **Not collected** for publisher-operated collection for:

- Name, email, phone, address, user IDs (no accounts)
- Location (precise / approximate)
- Financial info
- Health / fitness
- Messages / photos **as collected by you** — photos/messages are sent only to the user’s daemon; you do not receive them
- App activity / web browsing / crash logs (unless you later add a crash service)
- Device IDs / advertising IDs

Optional disclosure (if the form forces “processed on device”):

- **Photos** — processed on device / sent to user host only when user attaches a file; purpose: App functionality
- **App info / performance** — none by publisher

## Purposes

If any on-device processing is declared: **App functionality** only. Not advertising, not analytics, not fraud prevention by a third party.

## Ephemeral / encrypted

- Data is not sold.
- Data is not shared with third parties for advertising.
- Users can delete local pairing data via Clear all hosts / uninstall.

## Privacy policy URL

https://github.com/zeekliviu/cursor-remote/blob/main/docs/privacy.md
