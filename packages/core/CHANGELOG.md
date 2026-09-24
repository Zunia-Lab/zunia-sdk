# @zunialab/sdk-core

## 0.1.0

First public release.

- Sign-in messages: `buildSignInMessage`, `parseSignInMessage`, `createNonce`, and the same domain binding rule the wallet applies (`checkSignInBinding`).
- `verifySignIn` for servers: checks the ADR-036 secp256k1 signature, that the address derives from the key, the domain, URI, nonce, chain and dates.
- `zunia.connect.v2` crypto for QR pairing: X25519, HKDF-SHA256, ChaCha20-Poly1305, sequence numbers against replay, 6-digit verification code. Shared test vectors in `test-vectors/`.
- CosmJS-compatible types (`AccountData`, `StdSignature`, `DirectSignResponse`, `AminoSignResponse`), error codes and result normalizers.
