## 0.1.1

First release on pub.dev, same version as the npm SDK (`@zunialab/sdk-*` 0.1.1).

- `ZuniaConnectClient`: pairs with Zunia mobile over zunia.connect.v2 through the Zunia relay. It covers QR pairing, the 6-digit verification code, Direct, Amino and ADR-036 signing, Sign in with Zunia (Flutter web), account and chain events, restore after a restart through `ZuniaSessionStorage`, automatic reconnection with resend of unanswered requests, and reconnection when the app returns to the foreground.
- Same-phone flow: `openZunia()` opens Zunia with a `ret` return link, and signature requests open the wake link `zunia://connect/wake?sid=…`.
- Requests larger than the relay's 512 KiB frame fail before sending (`INVALID_PARAMS`, reason `too-large`). A relay `QUEUE_FULL` fails the request at once (`NETWORK`, reason `queue-full`).
- `ZuniaPairingView` and `ZuniaQrCode` widgets, and the `ConnectWithZuniaButton` with button semantics.
- Error codes and `explainZuniaError` match `@zunialab/sdk-core`. Crypto, pairing links and sign-in messages pass the shared test vectors.

**Breaking, from the 0.1.0 code on GitHub (never published):**

- The `zunia.connect.v1` client (`ZuniaNativeSessionClient`, `ZuniaSession`) is gone, because the relay only accepts v2.
- `ZuniaConnect` is replaced by `ZuniaLinks` and the pairing helpers.
