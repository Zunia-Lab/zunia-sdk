# @zunialab/sdk-core

The parts of the Zunia SDK that run anywhere: your server, a wallet, the browser.

- `verifySignIn`: checks a Sign in with Zunia result on your server.
- Sign-in messages: build, parse, and the domain rule wallets enforce.
- What a Zunia extension can sign (`zuniaCapabilities`, `zuniaSignMode`), and a check that an Amino signature is over the bytes the chain rebuilds (`checkAminoSignature`).
- Shared types (CosmJS compatible), error codes with words for people (`explainZuniaError`), and result normalizers.
- The `zunia.connect.v2` pairing crypto, with test vectors for other implementations.

Browser dApps want [`@zunialab/sdk-web`](https://www.npmjs.com/package/@zunialab/sdk-web), which uses this package.

```bash
pnpm add @zunialab/sdk-core
```

ESM only. Node 20.19+ and 22.12+ can also `require()` it. No Node built-ins, so it runs in workers and edge runtimes too.

## Sign in on your server

The browser asks your server for a nonce, the wallet signs a message that names your domain, and your server checks it.

```ts
import { createNonce, verifySignIn, ZuniaSignInError } from "@zunialab/sdk-core";

// POST /api/nonce
const nonce = createNonce();
await nonces.save(nonce, { ttlSeconds: 600 }); // your store: Redis, database...

// POST /api/verify  { nonce, message, signature }
if (!(await nonces.consume(nonce))) throw new Error("Unknown or used nonce"); // one attempt per nonce
try {
  const { address, chainId } = verifySignIn({
    message,
    signature,
    nonce,
    domain: "app.example.com", // from your config, never from the request's Host header
    chainId: ["cosmoshub-4"], // optional: chains you accept
  });
  // Start the user's session for `address`.
} catch (error) {
  if (error instanceof ZuniaSignInError) console.warn(error.code); // e.g. DOMAIN_MISMATCH
  throw error;
}
```

`verifySignIn` checks, in order: the message format, the domain, that the URI is on that domain, the nonce, the chain, the address (if you pass one), the dates (issued less than 10 minutes ago by default, not expired, not before `notBefore`), that the key is a compressed secp256k1 key, that it derives the signed address, and the ADR-036 signature. It throws `ZuniaSignInError` with one of these codes:

`INVALID_MESSAGE`, `DOMAIN_MISMATCH`, `URI_MISMATCH`, `NONCE_MISMATCH`, `CHAIN_MISMATCH`, `ADDRESS_MISMATCH`, `ISSUED_IN_FUTURE`, `TOO_OLD`, `EXPIRED`, `NOT_YET_VALID`, `UNSUPPORTED_KEY`, `KEY_MISMATCH`, `INVALID_SIGNATURE`.

Storing nonces and consuming each one once is your job: that is what stops a captured signature from being replayed.

### The message

`session.signIn()` in the web SDK builds it for you. It follows the Sign-In with Ethereum layout with Cosmos fields:

```text
app.example.com wants you to sign in with your Cosmos account:
cosmos1fr389pmrhma7sqmmshzpvg6hyn9jzegzvx6y6x

Sign in to Example.

URI: https://app.example.com
Version: 1
Chain ID: cosmoshub-4
Nonce: 8f1c2a9d4b7e6f30a5c1d2e3f4a5b6c7
Issued At: 2026-09-24T10:00:00.000Z
Expiration Time: 2026-09-24T10:10:00.000Z
```

The wallet signs it as ADR-036 arbitrary data, so it can never be a transaction. Before signing, Zunia checks that the domain and URI match the site that asked (`checkSignInBinding`) and refuses otherwise.

## What a Zunia extension can sign

Zunia 0.1.5 and later say what they sign on `window.zunia`: `extensionVersion` (the extension's own version) and `features`. `version` stays `"0.1.0"`, the provider API version, which is all Zunia 0.1.0 to 0.1.4 report: those builds cannot be told apart.

```ts
import { zuniaCapabilities, zuniaSignMode } from "@zunialab/sdk-core";

const capabilities = zuniaCapabilities(window.zunia);
const mode = zuniaSignMode({ messages, memo, capabilities }); // "direct" or "amino"
```

| `features` | `ZuniaCapabilities` | Meaning |
|------------|---------------------|---------|
| `sign-direct:wasm-contract-32` | `directContractCalls` | Direct decodes contract calls to 32-byte contracts. A build that reports it signs everything Direct. |
| `sign-direct:send-32` | `directSends32` | Direct decodes a send to a 32-byte address (a contract, an interchain account). |
| `sign-direct:osmosis-poolmanager` | `directPoolmanager` | Direct decodes Osmosis pool swaps. `null` for 0.1.0 to 0.1.4: 0.1.3 cannot, 0.1.4 can. |
| `sign-direct:osmosis-exact-out` | `directExactOut` | Direct decodes Osmosis swaps that buy an exact amount. |
| `sign-amino:escaped` | `aminoEscaping` | Amino sign bytes escape `&`, `<`, `>`, U+2028 and U+2029 as the chain does. |
| `sign-amino:osmosis-poolmanager` | `aminoPoolmanager` | Amino describes Osmosis pool swaps instead of refusing them. Optional, so only `features` reports it. |

Without `features`, an `extensionVersion` (or a `version`) of 0.1.5 or later counts as every Direct fix plus Amino escaping, and anything else as 0.1.4 or older. For those older builds `zuniaSignMode` picks Amino for a contract call or a send to a 32-byte address, unless the document holds `&`, `<` or `>` (`aminoNeedsEscaping`), and Direct for everything else. From 0.1.5 it picks Direct. With `@zunialab/sdk-web`, `session.getOfflineSignerFor()` applies this for you.

`checkAminoSignature(signed, signature)` says what an Amino signature is over before you broadcast it: `valid` (the bytes the chain rebuilds), `unescaped` (the same document with the chain's escaping skipped; the chain will refuse it), `invalid`, or `unchecked` (a key it cannot check, such as an Ethereum key). Those bytes come from `serializeAminoSignDoc`: keys sorted, compact JSON, `&<>` written `\u0026 \u003c \u003e`, and U+2028, U+2029 written `\u2028 \u2029` as Go does. CosmJS writes the same bytes for every document without U+2028 or U+2029.

## Errors

Every transport rejects with `ZuniaConnectError` and one `code`:

| Code | Meaning |
|------|---------|
| `USER_REJECTED` | The user said no. |
| `NOT_CONNECTED` | The site has no access to that chain or account. |
| `LOCKED` | The wallet is locked. |
| `UNKNOWN_CHAIN` | The wallet does not know the chain. |
| `ORIGIN_MISMATCH` | A sign-in message names another site. |
| `UNSUPPORTED` | The wallet or transport cannot do this. |
| `INVALID_PARAMS` | Bad arguments. |
| `NOT_INSTALLED` | Nothing to connect to: no extension, relay or WalletConnect setup. |
| `TIMEOUT` | The wallet did not answer in time. |
| `DISCONNECTED` | The session ended while waiting. |
| `PAIRING_FAILED` | QR pairing could not complete. |
| `SESSION_EXPIRED` | The relay no longer knows the session. Pair again. |
| `NETWORK` | The relay or WalletConnect could not be reached. |
| `INTERNAL` | Anything else. |

`error.reason` narrows the cases where the next step differs: `blind-signing` and `amino-escaping` (both `UNSUPPORTED`: this Zunia version cannot sign the transaction as asked, so update it), `prompt-expired` (`TIMEOUT`: nobody answered the wallet's prompt) and `stale-page` (`DISCONNECTED`: the extension was updated or reloaded under the page).

`explainZuniaError(error)` turns any of them into words for a toast or an inline message: a short `title`, a `message` with the next step, whether trying again can help (`retryable`), and the wallet's own text as `detail`.

## For wallet implementers

`ConnectCipher`, `deriveConnectKeys`, `verificationCodeFrom`, `parsePairingUri` and the frame types implement the wallet side of `zunia.connect.v2` as well as the dApp side. `test-vectors/connect-v2-vectors.json` (in this package) has key agreements, frames and pairing URIs to check another implementation against; `test-vectors/sign-in-vectors.json` does the same for sign-in messages.

## License

Apache-2.0
