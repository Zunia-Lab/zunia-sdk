<p align="center">
  <img src="https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-256.png" alt="Zunia" width="96" />
</p>

# zunia-sdk

> Official developer SDKs for integrating **Zunia** into dApps, websites, and mobile apps.

[![License](https://img.shields.io/github/license/Zunia-Lab/zunia-sdk)](LICENSE)
[![Website](https://img.shields.io/badge/website-zunialab.com-FF1B0C)](https://zunialab.com)
[![Docs](https://img.shields.io/badge/docs-docs.zunialab.com-FF1B0C)](https://docs.zunialab.com)

## Packages

| Package | Platform | Purpose |
|---------|----------|---------|
| [`@zunialab/sdk-core`](./packages/core) | Shared | Types, connect constants, `zunia.connect.v1`, `ZuniaSession` contracts |
| [`@zunialab/sdk-web`](./packages/web) | Browser | Extension detect, `connectWithZunia`, Native WS + WC transports |
| [`@zunialab/sdk-react`](./packages/react) | React | `useZuniaSession`, Connect button, pairing modal |
| [`zunia_sdk`](./flutter/zunia_sdk) | Flutter | Deep links, native WS client, Connect with Zunia button |

## Transports

1. **Extension** — `window.zunia` (preferred in browsers)
2. **Native WS** — first-party broker (`ws://` local / `wss://` prod) for mobile QR
3. **WalletConnect v2** — ecosystem interop (`@walletconnect/sign-client` optional peer)

## Quick start (web)

```bash
pnpm add @zunialab/sdk-web
```

```ts
import { connectWithZunia, enableZunia } from "@zunialab/sdk-web";

// Extension
await enableZunia("cosmoshub-4");

// Auto: extension → native WS → WC
const session = await connectWithZunia({
  chains: ["cosmoshub-4"],
  prefer: "auto",
  apiBase: "http://localhost:8788",
  walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID,
  metadata: { name: "My dApp", url: "https://example.com" },
});
```

## React

```tsx
import { ConnectWithZuniaButton, useZuniaSession, ConnectPairingModal } from "@zunialab/sdk-react";

const { connect, pairing, status, connecting } = useZuniaSession();

<ConnectWithZuniaButton
  loading={connecting}
  onClick={() => connect({ chains: ["cosmoshub-4"], prefer: "auto", apiBase: "http://localhost:8788" })}
/>
<ConnectPairingModal open={status === "awaiting_wallet"} onOpenChange={() => {}} status={status} pairing={pairing} />
```

## Flutter

```yaml
dependencies:
  zunia_sdk:
    path: flutter/zunia_sdk
```

See `flutter/zunia_sdk` for `ZuniaNativeSessionClient` and URI helpers.

## Docs

- [dApp API](https://docs.zunialab.com/connect/dapp-api)
- [Native WebSocket](https://docs.zunialab.com/connect/native-ws)
- [WalletConnect](https://docs.zunialab.com/connect/walletconnect)
