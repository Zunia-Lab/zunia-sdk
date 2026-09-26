# @zunialab/sdk-web

## 0.1.0

First public release.

- One session API over three transports: the Zunia extension, a phone paired by QR code through the relay (`zunia.connect.v2`, end-to-end encrypted), and WalletConnect v2.
- `session.signIn()` for sign-in only, `restoreSession()` to reattach after a reload without prompting.
- Live events: accounts, chains, locking, disconnection. Snapshots for UI stores.
- QR pairing survives network drops: heartbeat, reconnect with backoff, resend of unconfirmed requests, per-request timeouts.
- Results normalized to `Uint8Array` and `bigint` on every transport, so CosmJS works unchanged.
- `renderQrSvg`, the Connect with Zunia button and its stylesheet (`@zunialab/sdk-web/connect-button.css`).
- `session.suggestChain` asks the extension to add a chain. QR and WalletConnect sessions cannot add chains.
