# Example dApp

A Vite + React app that uses the Zunia SDK the way a real dApp would:

- Connect with the browser extension, a phone by QR code, or WalletConnect.
- Restore the session after a reload, without a prompt.
- Sign in, verified by a small server (`server/sign-in.ts`).
- Send tokens with CosmJS through the session's offline signer.
- Log every event the wallet sends back: account switches, locking, revocation.

It defaults to the Osmosis testnet (`osmo-test-5`), where tokens come from a faucet.

## Run it

From the repository root:

```bash
pnpm install
pnpm build
pnpm --filter zunia-example-dapp dev
```

Open http://localhost:5173 (not 127.0.0.1: the sign-in server only accepts messages signed for `localhost:5173`).

- **Extension:** install the Zunia extension in the same browser.
- **Phone (QR code):** run the relay from [zunia-backend](https://github.com/Zunia-Lab/zunia-backend) (`pnpm dev` listens on port 8788). Your phone must reach it, so set `VITE_ZUNIA_API` to your computer's address on the local network, or to a deployed relay.
- **WalletConnect:** set `VITE_WALLETCONNECT_PROJECT_ID`. The Zunia mobile app does not sign WalletConnect requests yet, so use a wallet that does, or the QR option with Zunia mobile.

## Settings

Put them in `.env.local`:

| Variable | Default |
|----------|---------|
| `VITE_CHAIN_ID` | `osmo-test-5` |
| `VITE_CHAIN_RPC` | `https://rpc.testnet.osmosis.zone` |
| `VITE_CHAIN_DENOM` | `uosmo` |
| `VITE_CHAIN_GAS_PRICE` | `0.025uosmo` |
| `VITE_ZUNIA_API` | `http://localhost:8788` |
| `VITE_WALLETCONNECT_PROJECT_ID` | none |
| `SIGN_IN_DOMAIN` (server side) | `localhost:5173` |

## Where to look

- `src/App.tsx`: connecting, the pairing dialog, restore on load.
- `src/SignInPanel.tsx` and `server/sign-in.ts`: both halves of sign-in. The server keeps nonces in memory; use a shared store when you run several processes.
- `src/SendPanel.tsx`: CosmJS with `session.getOfflineSigner()`.
- `src/useEventLog.ts`: subscribing to session events.

`pnpm build && pnpm preview` serves the production build with the same `/api` routes, which the end-to-end tests use.
