# @zunialab/sdk-react

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
- Updated dependencies [50d52ce]
  - @zunialab/sdk-core@0.1.1
  - @zunialab/sdk-web@0.1.1

## 0.1.0

First public release.

- `useZuniaSession`: status, accounts, chains, pairing, verification code and errors as React state, with restore on mount and `signIn`. The session includes `suggestChain`.
- `ConnectPairingModal`: QR code to scan, then the 6-digit code to compare with the phone.
- `ZuniaQrCode`, `ConnectWithZuniaButton`, `ZuniaMark`.
