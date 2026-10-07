# @zunialab/sdk-react

React hooks and components for connecting to the Zunia wallet, on top of [`@zunialab/sdk-web`](https://www.npmjs.com/package/@zunialab/sdk-web).

```bash
pnpm add @zunialab/sdk-react @zunialab/sdk-web
```

React 18 or 19. The components are client components (`"use client"`), so they work in the Next.js App Router.

## useZuniaSession

```tsx
import { ConnectPairingModal, ConnectWithZuniaButton, useZuniaSession } from "@zunialab/sdk-react";

const options = {
  chains: ["cosmoshub-4"],
  apiBase: "https://relay.example.com", // QR pairing with Zunia mobile, optional
};

export function Wallet() {
  const zunia = useZuniaSession({ restore: options });

  if (zunia.restoring) return null;
  if (zunia.connected) {
    return (
      <>
        <p>{zunia.accounts[0]?.address}</p>
        <button onClick={() => zunia.disconnect()}>Disconnect</button>
      </>
    );
  }
  return (
    <>
      <ConnectWithZuniaButton loading={zunia.connecting} onClick={() => zunia.connect(options).catch(() => {})} />
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

The hook returns the session snapshot as state, and re-renders on every change, including the ones the user makes in the wallet (switching accounts, locking, revoking your site):

| Field | |
|-------|--|
| `status`, `transport` | See the statuses in `@zunialab/sdk-web`. |
| `accounts`, `chains` | What your site can use right now. |
| `pairing`, `verificationCode` | For the QR dialog. |
| `error` | The last failure, a `ZuniaConnectError`. `explainZuniaError(error)` puts it in words. |
| `connected`, `locked`, `connecting`, `restoring` | Shortcuts for rendering. `locked`: connected, but the wallet is locked. |
| `connect`, `disconnect`, `restore`, `unlock`, `signIn` | Actions. `unlock` opens the wallet's unlock window and keeps your site's grant: call it from a click. |
| `session` | The underlying session: `getOfflineSignerFor`, `signDirect`, `on`... |

`restore` (default `true`) reattaches to the previous session on mount without prompting. Pass the same options as `connect` so it can find a QR or WalletConnect session. When it finds the extension locked, `locked` is true and `accounts` stays empty until the user unlocks: offer a button that calls `unlock`.

Call the hook once near the root and pass values down, or create one session at module scope and give it to every caller: `useZuniaSession({ session })` with `const session = createZuniaSession()`.

## Sign in

```tsx
const signIn = async () => {
  const { nonce } = await (await fetch("/api/nonce", { method: "POST" })).json();
  const proof = await zunia.signIn({ nonce });
  await fetch("/api/verify", { method: "POST", body: JSON.stringify({ nonce, ...proof }) });
};
```

Verify on your server with `verifySignIn` from [`@zunialab/sdk-core`](https://www.npmjs.com/package/@zunialab/sdk-core#sign-in-on-your-server).

## ConnectPairingModal

Shows the QR code to scan, with a link that opens the Zunia app when the page is already on the phone. Once the phone has scanned it, the dialog shows the 6-digit code instead, so the user can check both screens match. Escape and the cancel button call `onOpenChange(false)`: disconnect there to cancel the pairing.

## Other components

- `ZuniaQrCode`: an SVG QR code, rendered locally. No network request.
- `ConnectWithZuniaButton`: the official button. Opens the install page when `installed` is false and there is no `onClick`.
- `ZuniaMark`: the logo.
- `useZunia()`: just detects the extension's `window.zunia`.

## License

Apache-2.0
