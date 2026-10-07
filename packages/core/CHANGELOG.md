# @zunialab/sdk-core

## 0.1.1

### Patch Changes

- 50d52ce: Sign with every Zunia extension the way it can, and say what to do when it cannot.
  
  - `session.getOfflineSignerFor(chainId, { messages, memo })`, with `zuniaCapabilities(provider)`, `zuniaSignMode()` and `aminoNeedsEscaping()`: on Zunia 0.1.4 or older a contract call or a send to a 32-byte address gets the Amino-only signer (their Direct decoder refuses 32-byte contracts and recipients); everything else, and everything from Zunia 0.1.5, keeps Direct.
  - `ZuniaProvider` types `extensionVersion`, `features` and `isZunia` (Zunia 0.1.5). `ZUNIA_SIGNING_FEATURES` and `ZuniaCapabilities` cover every feature 0.1.5 reports: `directContractCalls`, `directSends32`, `directPoolmanager`, `directExactOut`, `aminoEscaping` and `aminoPoolmanager`. `getZunia({ preferAlias: true })` no longer takes another wallet's `window.keplr` for Zunia.
  - An Amino signature over unescaped `&`, `<`, `>` (Zunia 0.1.4 or older) is refused before broadcast: `UNSUPPORTED`, `reason: "amino-escaping"`. `checkAminoSignature()` does the same check for raw `window.zunia` callers.
  - Behaviour change: `serializeAminoSignDoc()` writes U+2028 and U+2029 as `\u2028` and `\u2029`, as the chain does (Go's `json.Marshal`). For a document holding either character its bytes now differ from CosmJS `serializeSignDoc`, and `checkAminoSignature()` reads a signature over them unescaped as `unescaped`. Every other document gives the same bytes as before.
  - `explainZuniaError()`: a title and a next step for every error. `ZuniaConnectError.reason` names blind signing, Amino escaping, an expired prompt and a stale page. An expired Zunia prompt is now `TIMEOUT` (was `USER_REJECTED`); an extension updated under the page is `DISCONNECTED` (was `INTERNAL`).
  - `session.unlock()`, and `locked` / `unlock` on `useZuniaSession`: after a restore that found Zunia locked, one click opens the unlock window and keeps the site's grant. CosmJS's first `getAccounts` unlocks the same way instead of failing with no account. `connect()` over a live extension session no longer revokes the grant first.
  - `ZUNIA_EXTENSION_IDS.gecko` is the published Firefox add-on id, `wallet@zunialab.com`.

## 0.1.0

First public release.

- Sign-in messages: `buildSignInMessage`, `parseSignInMessage`, `createNonce`, and the same domain binding rule the wallet applies (`checkSignInBinding`).
- `verifySignIn` for servers: checks the ADR-036 secp256k1 signature, that the address derives from the key, the domain, URI, nonce, chain and dates.
- `zunia.connect.v2` crypto for QR pairing: X25519, HKDF-SHA256, ChaCha20-Poly1305, sequence numbers against replay, 6-digit verification code. Shared test vectors in `test-vectors/`.
- CosmJS-compatible types (`AccountData`, `StdSignature`, `DirectSignResponse`, `AminoSignResponse`), error codes and result normalizers.
- `SuggestedChain`, the chain description a site passes when it asks the extension to add a network.
