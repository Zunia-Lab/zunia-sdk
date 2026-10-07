# @zunialab/sdk-web

Connect a web dApp to the Zunia wallet: the browser extension, a phone paired by QR code, or WalletConnect. One session API, the same results and events whichever carries it.

```bash
pnpm add @zunialab/sdk-web
# only if you offer WalletConnect:
pnpm add @walletconnect/sign-client
```

ESM only, for browsers and bundlers (Vite, webpack, Next.js). React apps can use [`@zunialab/sdk-react`](https://www.npmjs.com/package/@zunialab/sdk-react) on top.

## Connect

```ts
import { createZuniaSession } from "@zunialab/sdk-web";

const options = {
  chains: ["cosmoshub-4"],
  metadata: { name: "My dApp", url: location.origin },
};

const session = createZuniaSession();

// After a reload: reattach without prompting. Resolves false when there is nothing to restore.
if (!(await session.restore(options))) {
  await session.connect(options); // opens the extension's approval window
}

const [account] = session.accounts; // { address, pubkey, algo, chainId, name? }
```

`prefer` picks the transport. The default, `auto`, tries the extension, then QR pairing when `apiBase` is set, then WalletConnect when a project id and loader are set. When none can work, `connect` opens the install page (turn off with `openInstallIfMissing: false`) and throws `NOT_INSTALLED`.

| `prefer` | Needs | Where the wallet is |
|----------|-------|---------------------|
| `extension` | The Zunia extension | This browser |
| `native-ws` | `apiBase`: a Zunia relay | Zunia mobile, scanning a QR code |
| `walletconnect` | `walletConnectProjectId` and `loadWalletConnect` | A WalletConnect v2 wallet |

### QR pairing with Zunia mobile

```ts
import { renderQrSvg } from "@zunialab/sdk-web";

session.on("pairing", ({ uri }) => {
  dialog.innerHTML = renderQrSvg(uri, { size: 240, label: "Scan with Zunia" });
});
session.on("verification", (code) => {
  // Both screens now show this 6-digit code. Show it and ask the user to compare.
  dialog.textContent = `Check that your phone shows ${code.slice(0, 3)} ${code.slice(3)}`;
});

await session.connect({ ...options, prefer: "native-ws", apiBase: "https://relay.example.com" });
```

The QR code holds a one-time join token and the dApp's public key. The phone and the page agree on keys (X25519) and encrypt every message (ChaCha20-Poly1305), so the relay only sees ciphertext. The relay checks the page's `Origin` and hands it to the phone, which shows it and binds sign-in messages to it. An unscanned code expires after 10 minutes; a paired session lasts 24 hours.

Zunia does not host a public relay yet. Run [zunia-backend](https://github.com/Zunia-Lab/zunia-backend) and pass its URL as `apiBase`.

On a phone browser, link to the app instead of showing a QR code: the pairing URI (`zunia://connect?...`) opens Zunia mobile directly.

### WalletConnect

```ts
await session.connect({
  ...options,
  prefer: "walletconnect",
  walletConnectProjectId: "your WalletConnect Cloud project id",
  loadWalletConnect: () => import("@walletconnect/sign-client"),
});
```

WalletConnect is loaded through the function you pass, so apps that do not use it never bundle it. Show `session.pairing.uri` as a QR code the same way. The Zunia mobile app accepts WalletConnect sessions but does not sign WalletConnect requests yet: pair it with `native-ws` instead.

## Sign in

```ts
const { nonce } = await (await fetch("/api/nonce", { method: "POST" })).json();
const { message, signature, address } = await session.signIn({
  nonce,
  statement: "Sign in to My dApp.", // optional
});
await fetch("/api/verify", { method: "POST", body: JSON.stringify({ nonce, message, signature }) });
```

The message names `location.host` and expires after 10 minutes unless you pass `expirationTime`. The wallet shows the site, the account and the expiry, and refuses a message whose domain is not the site asking. Check it on your server with `verifySignIn` from [`@zunialab/sdk-core`](https://www.npmjs.com/package/@zunialab/sdk-core#sign-in-on-your-server).

## Sign transactions with CosmJS

```ts
import { SigningStargateClient } from "@cosmjs/stargate";

const messages = [
  {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: account.address, toAddress: recipient, amount: [{ denom: "uatom", amount: "1000" }] },
  },
];
const signer = session.getOfflineSignerFor("cosmoshub-4", { messages, memo });
const client = await SigningStargateClient.connectWithSigner(rpcUrl, signer);
await client.signAndBroadcast(account.address, messages, "auto", memo);
```

CosmJS signs Direct whenever its signer can. `getOfflineSignerFor` hands it the signer for these messages: Amino-only when the Zunia extension connected can only sign them in Amino (a contract call, or a send to a 32-byte address, on Zunia 0.1.4 or older), the full signer everywhere else, and for everything from Zunia 0.1.5. `session.capabilities` says what the connected extension can sign (`null` on other transports); see [`zuniaCapabilities`](https://www.npmjs.com/package/@zunialab/sdk-core#what-a-zunia-extension-can-sign).

`getOfflineSigner(chainId)` (Direct and Amino), `getOfflineSignerOnlyAmino(chainId)`, `signAmino`, `signDirect` and `signArbitrary` are there too. Results use `Uint8Array` and `bigint` on every transport, as CosmJS expects.

On the extension, an Amino signature the chain would refuse because Zunia 0.1.4 or older did not escape `&`, `<` or `>` in it is stopped before anything is broadcast: `UNSUPPORTED`, with `reason: "amino-escaping"`. `explainZuniaError(error)` puts any failure in words for your UI.

`session.suggestChain(chain)` asks the extension to add a chain it does not already know. The wallet shows the endpoints and asks before it saves anything. QR and WalletConnect sessions cannot add chains.

## Events

```ts
session.on("accountsChanged", (accounts) => render(accounts));
session.on("disconnect", (reason) => showSignedOut(reason));
```

| Event | Payload | When |
|-------|---------|------|
| `status` | status | Every change, see below. |
| `accountsChanged` | accounts | The user switched accounts or unlocked the wallet. |
| `chainChanged` | chain ids | Chains were added or revoked for your site. |
| `pairing` | `{ transport, uri, expiresAt }` | A QR code or WalletConnect link is ready. |
| `verification` | 6-digit code | QR pairing: the code both screens must show. |
| `disconnect` | reason | The user revoked your site, the session expired, or you called `disconnect()`. |
| `error` | `ZuniaConnectError` | A connection failed or a message could not be read. |

Status is one of `idle`, `connecting`, `awaiting_wallet` (waiting for a scan or approval), `connected`, `locked` (connected, the wallet is locked), `reconnecting` (the relay link dropped and is coming back), `disconnected` and `error`.

For UI stores, `session.subscribe(listener)` and `session.getSnapshot()` work with React's `useSyncExternalStore` and similar.

### A locked wallet

A restore never opens the extension's unlock window by itself. When it finds Zunia locked, the status is `locked` and `accounts` stays empty until the user unlocks. `session.unlock()` opens the unlock window (call it from a click), reads the accounts again and keeps your site's grant. CosmJS's first `getAccounts` through a session signer unlocks the same way, so a transaction started while locked goes through. Calling `connect()` again over a live extension session does not revoke the grant either.

## When the network drops

Over QR pairing, the session pings the relay every 20 seconds, reopens the link with backoff when it goes quiet, and resends requests the relay had not confirmed. The wallet ignores duplicates. Each request times out after 5 minutes (`requestTimeoutMs`). If the relay no longer knows the session, the session ends with `SESSION_EXPIRED` and the user pairs again.

## What is stored, and where

To restore sessions after a reload, the SDK writes to `localStorage`:

- `zunia.session.transport`: which transport was used.
- `zunia.connect.v2.session`: for QR pairing, the relay URL, session id, dApp token, the two session keys and the message counters. Never the pairing secret key or the QR join token.
- `zunia.walletconnect.session`: the WalletConnect topic and accounts. WalletConnect keeps its own keys.

Any script running on your origin can read these, as with any session token: keep a strict Content Security Policy. Pass `storage: null` to keep everything in memory (users pair again after a reload), or your own `{ getItem, setItem, removeItem }`.

## Extension helpers

`getZunia()` waits for the extension to inject `window.zunia` (it dispatches `zunia#initialized`) and resolves `undefined` when it is not installed. `isZuniaInstalled()` checks synchronously. The Keplr-compatible alias `window.keplr` is only used with `getZunia({ preferAlias: true })`, and only when it says it is Zunia (`isZunia`): without `window.zunia`, a `window.keplr` belongs to another wallet.

## Connect with Zunia button

```ts
import { createConnectWithZuniaButton } from "@zunialab/sdk-web";

document.querySelector("#connect")!.append(
  createConnectWithZuniaButton({ size: "md", onClick: () => session.connect(options) }),
);
```

The button injects its styles. To ship them as a file instead: `import "@zunialab/sdk-web/connect-button.css"`.

## License

Apache-2.0
