---
"@zunialab/sdk-core": minor
"@zunialab/sdk-web": minor
"@zunialab/sdk-react": minor
---

App-to-app return for QR pairing with Zunia mobile, and the relay's limits.

- sdk-core: pairing links take `ret`, where the wallet returns after the user answers when the link opened it on the same device (`returnUrl` in `buildPairingUri`/`parsePairingUri`, rule in `isValidReturnUrl`). `buildWakeUri`/`parseWakeUri` for `zunia://connect/wake?sid=…`. `ZUNIA_CONNECT_LIMITS`, `sealedFrameBytes` and `ConnectCipher.sealedBytes`. New error reasons `too-large` and `queue-full`. `ZuniaPairing.appUri`. Shared vectors gain return targets and wake links.
- sdk-web: `NativeWsTransport` options `returnUrl` and `openWallet: "auto" | "never"`. On a phone browser the pairing's `appUri` carries `ret` (default: this page), and once paired from the phone each signing request opens Zunia with a wake link. `session.openWallet()`, `isPhoneBrowser()`. A request over 512 KiB once encrypted is refused before it leaves (`INVALID_PARAMS`, `too-large`); a relay `QUEUE_FULL` fails that request at once (`NETWORK`, `queue-full`) instead of at the timeout, and it is not sent again.
- sdk-react: `ConnectPairingModal` shows "Open the Zunia app" (now `pairing.appUri`) only in phone and tablet browsers, first, with the QR code below for another phone; `showAppLink` overrides. `useZuniaSession` returns `openWallet`.
