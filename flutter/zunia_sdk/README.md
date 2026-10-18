# zunia_sdk

Connect a Flutter app to [Zunia](https://zunialab.com), the self-custody Cosmos wallet, and ask it for signatures.

- **QR pairing.** Show a QR code; the person scans it with Zunia on their phone. This works from a tablet, a desktop app or Flutter web.
- **Same phone.** "Open Zunia on this device" opens the wallet. After the person answers, Zunia returns to your app.
- **End-to-end encrypted.** Pairing uses zunia.connect.v2: X25519 key agreement, HKDF-SHA256 and ChaCha20-Poly1305. The relay only forwards sealed frames, and both screens show the same 6-digit code.
- **Cosmos signing.** `signDirect`, `signAmino`, ADR-036 `signArbitrary`, and Sign in with Zunia (CAIP-122) on Flutter web.
- **Sessions that last.** The session survives restarts (with storage you provide), reconnects by itself, and catches up when the app returns to the foreground. A session lasts 24 hours.

This package speaks the same protocol as [`@zunialab/sdk-web`](https://www.npmjs.com/package/@zunialab/sdk-web) on npm. It checks itself against the same test vectors, byte for byte.

## Install

```sh
flutter pub add zunia_sdk
```

Requirements:

- Flutter 3.27 or later.
- Android, iOS, macOS, Windows, Linux or web.

## Connect and sign

```dart
import 'package:zunia_sdk/zunia_sdk.dart';

final zunia = ZuniaConnectClient(
  metadata: const ZuniaDappMetadata(name: 'My app', url: 'https://myapp.example'),
  storage: SecureSessionStorage(const FlutterSecureStorage()), // see below
  returnUrl: 'myapp://zunia', // where Zunia returns on the same phone
);

// On start: pick up the saved session without asking anything.
final restored = await zunia.restore(chains: ['cosmoshub-4']);

// On "Connect": show the QR code while this waits for the approval.
if (!restored) {
  showModalBottomSheet(
    context: context,
    builder: (_) => ZuniaPairingView(client: zunia),
  );
  await zunia.connect(chains: ['cosmoshub-4']);
}

final account = zunia.accounts.first;

final signed = await zunia.signDirect('cosmoshub-4', account.address, ZuniaSignDoc(
  bodyBytes: bodyBytes,
  authInfoBytes: authInfoBytes,
  chainId: 'cosmoshub-4',
  accountNumber: BigInt.from(accountNumber),
));
// signed.signature.signatureBytes is the 64-byte secp256k1 signature.
// Put it in a TxRaw with signed.signed.bodyBytes and authInfoBytes, then broadcast.
```

To skip the QR code when Zunia is on the same phone, call `connect(chains: [...], openZunia: true)`. If Zunia is not installed, this throws `NOT_INSTALLED`.

`ZuniaConnectClient` is a `ChangeNotifier`, so you can rebuild with `ListenableBuilder(listenable: zunia, ...)`. It also exposes streams:

- `statusChanges`
- `accountsChanges`
- `chainsChanges`
- `pairings`
- `verificationCodes`
- `disconnects`
- `errors`

## What you can call

| Call | What it does |
| --- | --- |
| `connect(chains:, timeout:, openZunia:)` | Creates a session and waits for approval. |
| `restore(chains:)` | Reattaches to the saved session. Answers `false` when there is none. |
| `openZunia()` | While pairing, opens the pairing link with `ret`. Once paired, opens the session's wake link. |
| `accounts`, `chains`, `getKey(chainId)` | What Zunia shared. `getKey` gives a Keplr-style key. |
| `refreshAccounts()` | Asks Zunia for the accounts again. |
| `signDirect(chainId, signer, ZuniaSignDoc)` | Signs in SIGN_MODE_DIRECT. |
| `signAmino(chainId, signer, Map signDoc)` | Signs Amino JSON. Broadcast `response.signed`, because Zunia may set the fee. |
| `signArbitrary(chainId, signer, text)`, `signArbitraryBytes(...)` | Signs with ADR-036. |
| `signIn(nonce:, statement:, ...)` | Signs a CAIP-122 sign-in message (Flutter web only, see below). |
| `disconnect()` | Ends the session on both sides. |
| `dispose()` | Stops the client but keeps the session, so `restore` picks it up later. |

Errors are `ZuniaConnectException` with a `code`:

- `USER_REJECTED`, `NOT_CONNECTED`, `LOCKED`, `UNKNOWN_CHAIN`, `ORIGIN_MISMATCH`, `UNSUPPORTED`, `INVALID_PARAMS`, `INTERNAL`: the same codes as the npm SDK and the Zunia extension.
- `NOT_INSTALLED`, `TIMEOUT`, `DISCONNECTED`, `PAIRING_FAILED`, `SESSION_EXPIRED`, `NETWORK`: connection failures.

`explainZuniaError(error)` turns any error into a short title and a sentence you can show to the person.

A few failures are refused before they reach the phone:

- **Request too large.** A request bigger than the relay's 512 KiB frame limit fails at once with `INVALID_PARAMS`, reason `too-large`.
- **Phone offline, queue full.** If Zunia is offline and the relay's queue for it is full (32 frames or 1 MiB), the request fails with `NETWORK`, reason `queue-full`. It does not wait for a timeout.

## Same phone: open Zunia, come back

1. `connect(openZunia: true)`, or the button in `ZuniaPairingView`, opens `zunia://connect?...&ret=<returnUrl>`.
2. The person approves in Zunia. Zunia then opens your `returnUrl`.
3. Later, every signature request opens `zunia://connect/wake?sid=<session id>`. This brings the waiting request to the front of Zunia, and Zunia returns to your app afterwards.

The wake link carries only the session id: no secret, and it never pairs. Pass `openWallet: ZuniaOpenWallet.never` to stop the automatic wake links.

A session paired by QR never opens Zunia by itself.

The `returnUrl` must be one of:

- an `https:` link your app handles;
- your own scheme, such as `myapp://zunia`.

It can be at most 512 characters. Zunia ignores the `zunia`, `zuniamobile`, `wc`, `javascript`, `data`, `file`, `blob`, `about`, `content`, `intent` and `http` schemes.

### Android

```xml
<!-- AndroidManifest.xml, inside <manifest>: lets ZuniaLinks.isInstalled() see Zunia -->
<queries>
  <intent>
    <action android:name="android.intent.action.VIEW" />
    <data android:scheme="zunia" />
  </intent>
</queries>

<!-- inside your <activity>: receive the return link -->
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="myapp" android:host="zunia" />
</intent-filter>
```

### iOS

```xml
<!-- Info.plist -->
<key>LSApplicationQueriesSchemes</key>
<array><string>zunia</string></array>
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>myapp</string></array>
  </dict>
</array>
```

Your app only needs to open when the return link arrives. It does not need to read it, because the result comes over the relay. On iOS, sockets pause in the background. The client reconnects as soon as your app is in the foreground again, and the relay keeps frames for up to 10 minutes.

## Keep the session across restarts

The saved session holds its encryption keys and its relay token. Back it with the platform keystore:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureSessionStorage implements ZuniaSessionStorage {
  const SecureSessionStorage(this.storage);
  final FlutterSecureStorage storage;

  @override
  Future<String?> read(String key) => storage.read(key: key);
  @override
  Future<void> write(String key, String value) => storage.write(key: key, value: value);
  @override
  Future<void> delete(String key) => storage.delete(key: key);
}
```

Without storage, the session lives in memory and ends with the app.

## Sign in with Zunia

`signIn(nonce: ...)` builds the CAIP-122 message for the origin the relay verified. Zunia checks that origin before it signs. Send the result to your server and verify it there, for example with `verifySignIn` from `@zunialab/sdk-core`.

Only browsers send an origin, so sign-in works from **Flutter web**. A native app has none, and `signIn` throws `ORIGIN_MISMATCH` without asking the phone. In a native app, have your server issue a challenge, sign it with `signArbitrary`, and verify the ADR-036 signature on the server.

## The relay

The public Zunia relay is `https://api.zunialab.com`, open to any app, and it is the default. Pass `apiBase:` to use your own deployment of `zunia-backend`.

Session limits:

- A session waits 10 minutes for a scan.
- Once paired, it lasts 24 hours.
- Frames are at most 512 KiB.
- While a side is offline, the relay holds up to 32 frames (1 MiB) for it.

## Lower level

These pieces are exported for wallets and tests:

- `buildPairingUri` and `parsePairingUri`, including `ret`;
- `buildWakeLink` and `parseWakeLink`;
- `ConnectCipher`, `deriveConnectKeys` and `verificationCodeFrom`;
- `parseSignInMessage` and `buildSignInMessage`;
- `ZuniaQrCode`, a QR code painter with no other dependency;
- `ConnectWithZuniaButton`, the official button.

## Links

- Documentation: https://docs.zunialab.com/docs/integrate/flutter
- Protocol reference: https://docs.zunialab.com/docs/reference/connect-v2
- Source: https://github.com/Zunia-Lab/zunia-sdk/tree/main/flutter/zunia_sdk
- Security: security@zunialab.com
