import 'dart:typed_data';

import 'encoding.dart';
import 'errors.dart';
import 'pairing_uri.dart';

/// Where a session stands.
enum ZuniaSessionStatus {
  /// Nothing started.
  idle,

  /// Creating the session on the relay.
  connecting,

  /// A pairing link is waiting to be scanned or opened.
  awaitingWallet,

  /// Paired. Requests go through.
  connected,

  /// The link to the relay dropped; retrying with the session token.
  reconnecting,

  /// Ended. Pair again.
  disconnected,
}

/// Who is asking, as Zunia shows it on the approval screen.
class ZuniaDappMetadata {
  /// Creates app metadata.
  const ZuniaDappMetadata({
    required this.name,
    required this.url,
    this.description,
    this.icons = const [],
  });

  /// Your app's name.
  final String name;

  /// Your website. Zunia shows it as declared, not verified, unless the relay
  /// saw the same origin (only browsers send one).
  final String url;

  /// One short line, if any.
  final String? description;

  /// Icon URLs, largest first.
  final List<String> icons;

  /// Wire form.
  Map<String, Object?> toJson() => {
        'name': name,
        if (description != null) 'description': description,
        'url': url,
        if (icons.isNotEmpty) 'icons': icons,
      };
}

/// An account Zunia shared, with its chain.
class ZuniaAccount {
  /// Creates an account.
  const ZuniaAccount({
    required this.chainId,
    required this.address,
    required this.algo,
    required this.pubKey,
    this.name,
  });

  /// Reads the wire form. Throws [ZuniaConnectException] when malformed.
  factory ZuniaAccount.fromWire(Object? value) {
    if (value is! Map) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.internal, 'The wallet sent a malformed account');
    }
    final chainId = value['chainId'];
    final address = value['address'];
    final pubKey = value['pubKey'];
    final algo = value['algo'];
    final name = value['name'];
    if (chainId is! String || address is! String || pubKey is! String) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.internal, 'The wallet sent a malformed account');
    }
    final Uint8List key;
    try {
      key = base64ToBytes(pubKey);
    } on FormatException catch (error) {
      throw ZuniaConnectException(
          ZuniaErrorCode.internal, 'The wallet sent a malformed public key',
          cause: error);
    }
    return ZuniaAccount(
      chainId: chainId,
      address: address,
      algo:
          algo == 'ed25519' || algo == 'sr25519' ? algo as String : 'secp256k1',
      pubKey: key,
      name: name is String ? name : null,
    );
  }

  /// Chain id, such as `cosmoshub-4`.
  final String chainId;

  /// Bech32 address.
  final String address;

  /// `secp256k1`, `ed25519` or `sr25519`.
  final String algo;

  /// Compressed public key.
  final Uint8List pubKey;

  /// The account's name in Zunia, if shared.
  final String? name;

  /// Wire form, as the session stores it.
  Map<String, Object?> toWire() => {
        'chainId': chainId,
        'address': address,
        'algo': algo,
        'pubKey': bytesToBase64(pubKey),
        if (name != null) 'name': name,
      };
}

/// A Keplr-style key, for code written against `getKey`.
class ZuniaKey {
  /// Creates a key.
  const ZuniaKey({
    required this.name,
    required this.algo,
    required this.pubKey,
    required this.bech32Address,
  });

  /// The account's name.
  final String name;

  /// Key algorithm.
  final String algo;

  /// Compressed public key.
  final Uint8List pubKey;

  /// Bech32 address.
  final String bech32Address;
}

/// A protobuf `SignDoc` (SIGN_MODE_DIRECT).
class ZuniaSignDoc {
  /// Creates a sign doc.
  const ZuniaSignDoc({
    required this.bodyBytes,
    required this.authInfoBytes,
    required this.chainId,
    required this.accountNumber,
  });

  /// Encoded `TxBody`.
  final Uint8List bodyBytes;

  /// Encoded `AuthInfo`.
  final Uint8List authInfoBytes;

  /// Chain id.
  final String chainId;

  /// The signer's account number.
  final BigInt accountNumber;

  /// Wire form: bytes as base64, the account number as a decimal string.
  Map<String, Object?> toWire() => {
        'bodyBytes': bytesToBase64(bodyBytes),
        'authInfoBytes': bytesToBase64(authInfoBytes),
        'chainId': chainId,
        'accountNumber': accountNumber.toString(),
      };
}

/// A Cosmos `StdSignature`: base64 key and signature.
class ZuniaStdSignature {
  /// Creates a signature.
  const ZuniaStdSignature({
    required this.pubKeyType,
    required this.pubKey,
    required this.signature,
  });

  /// Reads what the wallet returned. Throws [ZuniaConnectException] when it
  /// is not a signature.
  factory ZuniaStdSignature.fromJson(Object? value) {
    final key = value is Map ? value['pub_key'] : null;
    final signature = value is Map ? value['signature'] : null;
    if (key is! Map || key['value'] is! String || signature is! String) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.internal, 'The wallet returned no signature');
    }
    final type = key['type'];
    return ZuniaStdSignature(
      pubKeyType: type is String ? type : 'tendermint/PubKeySecp256k1',
      pubKey: key['value'] as String,
      signature: signature,
    );
  }

  /// Amino type of the key, such as `tendermint/PubKeySecp256k1`.
  final String pubKeyType;

  /// Base64 public key.
  final String pubKey;

  /// Base64 signature (64 bytes r||s for secp256k1).
  final String signature;

  /// The signature bytes.
  Uint8List get signatureBytes => base64ToBytes(signature);

  /// JSON as Cosmos SDK and CosmJS write it.
  Map<String, Object?> toJson() => {
        'pub_key': {'type': pubKeyType, 'value': pubKey},
        'signature': signature,
      };
}

/// A Direct signature with the document Zunia signed.
class ZuniaDirectSignResponse {
  /// Creates a response.
  const ZuniaDirectSignResponse(
      {required this.signed, required this.signature});

  /// What was signed. Zunia never changes the bytes it was sent.
  final ZuniaSignDoc signed;

  /// The signature.
  final ZuniaStdSignature signature;
}

/// An Amino signature with the document Zunia signed.
class ZuniaAminoSignResponse {
  /// Creates a response.
  const ZuniaAminoSignResponse({required this.signed, required this.signature});

  /// The `StdSignDoc` signed. The wallet may have changed the fee, so
  /// broadcast this one, not the one you sent.
  final Map<String, Object?> signed;

  /// The signature.
  final ZuniaStdSignature signature;
}

/// What to show while a phone pairs.
class ZuniaPairing {
  /// Creates pairing details.
  const ZuniaPairing({required this.params, required this.expiresAt});

  /// The values in the link.
  final ZuniaPairingUri params;

  /// When the relay forgets an unpaired session.
  final DateTime expiresAt;

  /// The session id.
  String get sessionId => params.sessionId;

  /// The QR code payload: `zunia://connect?v=2&…`, without a return URL.
  String get uri => buildPairingUri(
        ZuniaPairingUri(
          sessionId: params.sessionId,
          joinToken: params.joinToken,
          dappPublicKey: params.dappPublicKey,
          relay: params.relay,
        ),
      );

  /// The link that opens Zunia on this device. With [returnUrl], Zunia
  /// returns there after the person answers.
  Uri deepLink({String? returnUrl}) => Uri.parse(buildPairingUri(
        ZuniaPairingUri(
          sessionId: params.sessionId,
          joinToken: params.joinToken,
          dappPublicKey: params.dappPublicKey,
          relay: params.relay,
          returnUrl: returnUrl,
        ),
      ));
}

/// Send all of it to your server and verify it there.
class ZuniaSignInResult {
  /// Creates a sign-in result.
  const ZuniaSignInResult({
    required this.message,
    required this.signature,
    required this.address,
    required this.chainId,
    required this.pubKey,
  });

  /// The exact text signed.
  final String message;

  /// ADR-036 signature over [message].
  final ZuniaStdSignature signature;

  /// The account that signed.
  final String address;

  /// Its chain.
  final String chainId;

  /// Its public key.
  final Uint8List pubKey;
}
