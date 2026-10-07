<p align="center">
  <img src="https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-256.png" alt="Zunia" width="96" />
</p>

# zunia-sdk

> Connect your dApp to the Zunia wallet: sign-in, live account events and CosmJS signing, from the browser extension or a phone.

[![License](https://img.shields.io/github/license/Zunia-Lab/zunia-sdk)](LICENSE)
[![Website](https://img.shields.io/badge/website-zunialab.com-FF1B0C)](https://zunialab.com)
[![Docs](https://img.shields.io/badge/docs-docs.zunialab.com-FF1B0C)](https://docs.zunialab.com)

**Status:** 0.1.0 is on npm: `@zunialab/sdk-core`, `@zunialab/sdk-web`, `@zunialab/sdk-react` and `@zunialab/interchain`.

## Packages

| Package | For | What it does |
|---------|-----|--------------|
| [`@zunialab/sdk-web`](./packages/web) | Browser dApps | Connects to Zunia, restores the session after a reload, sign-in, events, CosmJS signers |
| [`@zunialab/sdk-react`](./packages/react) | React dApps | `useZuniaSession`, the pairing dialog, the Connect with Zunia button |
| [`@zunialab/sdk-core`](./packages/core) | Servers and wallets | `verifySignIn` for your backend, shared types and errors, the pairing crypto |
| [`@zunialab/interchain`](./packages/interchain) | Wallets and dApps | IBC routes, denoms, packet-forward memos, packet tracking |
| [`zunia_sdk`](./flutter/zunia_sdk) | Flutter | Deep links and the Connect with Zunia button. Speaks the older pairing protocol; the v2 client is planned |

## How a dApp connects

One session API, three ways to reach the wallet:

1. **Browser extension.** The Zunia extension (Chrome, Edge, Firefox and Safari builds) injects `window.zunia`. Picked first when present.
2. **Phone, by QR code.** The dApp shows a QR code, Zunia mobile scans it, and both sides talk through the Zunia relay. Messages are end-to-end encrypted (X25519, ChaCha20-Poly1305); the relay only forwards ciphertext. Both screens show the same 6-digit code, and the phone sees the site's origin as checked by the relay.
3. **WalletConnect v2.** For other wallets. The Zunia mobile app accepts WalletConnect sessions but does not sign WalletConnect requests yet, so pair Zunia mobile by QR code.

Every transport returns the same shapes (`Uint8Array`, `bigint`), emits the same events and uses the same error codes.

## Quick start (React)

```bash
pnpm add @zunialab/sdk-react @zunialab/sdk-web
```

```tsx
import { ConnectPairingModal, ConnectWithZuniaButton, useZuniaSession } from "@zunialab/sdk-react";

const options = { chains: ["cosmoshub-4"], apiBase: "https://relay.example.com" };

export function Connect() {
  // Restores the previous session on mount, without a prompt.
  const zunia = useZuniaSession({ restore: options });

  if (zunia.connected) return <p>Connected as {zunia.accounts[0]?.address}</p>;
  return (
    <>
      <ConnectWithZuniaButton loading={zunia.connecting} onClick={() => zunia.connect(options)} />
      <ConnectPairingModal
        open={zunia.status === "awaiting_wallet"}
        onOpenChange={(open) => !open && zunia.disconnect()}
        status={zunia.status}
        pairing={zunia.pairing}
        verificationCode={zunia.verificationCode}
        error={zunia.error}
      />
    </>
  );
}
```

`apiBase` is the relay used for QR pairing. Zunia does not host a public relay yet: run [zunia-backend](https://github.com/Zunia-Lab/zunia-backend) or leave `apiBase` out to offer the extension (and WalletConnect) only.

## Sign-in only

When all you need is to know who the user is:

```ts
// Browser
const { nonce } = await (await fetch("/api/nonce", { method: "POST" })).json();
const proof = await zunia.signIn({ nonce }); // the wallet shows your domain and asks to sign
await fetch("/api/verify", { method: "POST", body: JSON.stringify({ nonce, ...proof }) });
```

```ts
// Server
import { verifySignIn } from "@zunialab/sdk-core";

const { address } = verifySignIn({ message, signature, nonce, domain: "app.example.com" });
```

No transaction, no fee. The wallet refuses to sign a message whose domain does not match the site asking, and `verifySignIn` checks the signature, the key, the domain, the nonce and the dates. See [`packages/core`](./packages/core#sign-in-on-your-server).

## Send a transaction

The session hands CosmJS a regular offline signer, picked for the messages you are about to sign, so a contract call reaches the Zunia extension in a mode that build can sign:

```ts
import { SigningStargateClient } from "@cosmjs/stargate";

const signer = zunia.session.getOfflineSignerFor("cosmoshub-4", { messages, memo });
const client = await SigningStargateClient.connectWithSigner(rpc, signer);
await client.signAndBroadcast(address, messages, "auto", memo);
```

## Example

[`examples/dapp`](./examples/dapp) is a Vite + React app with all of the above: the three ways to connect, a verified sign-in with its server half, a CosmJS send and a live event log.

## Development

```bash
pnpm install
pnpm build            # packages first: tests import each other's dist output
pnpm typecheck
pnpm test
pnpm check:packages   # publint and attw on the tarballs pnpm would publish
pnpm smoke:tarballs   # installs those tarballs in a Node script and a Vite app
```

Versions and changelogs go through [Changesets](./.changeset/README.md). A `v*` tag publishes to npm from CI.

## Docs

[docs.zunialab.com](https://docs.zunialab.com)

## License

[Apache-2.0](./LICENSE)
