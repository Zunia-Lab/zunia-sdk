/// End-to-end encryption for zunia.connect.v2.
///
/// - X25519 between the app key (in the pairing link) and the wallet key (in
///   its `hello` frame). The session id and both public keys are bound into
///   the HKDF-SHA256 salt.
/// - One ChaCha20-Poly1305 key per direction, a random 96-bit nonce per
///   frame, and `zunia.connect.v2|<sessionId>|<direction>` as associated data.
/// - A sequence number inside each plaintext; a receiver drops anything not
///   newer than the last frame it accepted.
/// - A 6-digit code from the same secret. Both screens show it; a relay that
///   swapped keys produces two different codes.
///
/// The same construction as `@zunialab/sdk-core` and the Zunia wallet. The
/// shared vectors in `test/fixtures/connect-v2-vectors.json` keep them equal.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hashes;
import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import 'constants.dart';
import 'encoding.dart';
import 'errors.dart';

/// Which side of a session is sealing or opening.
enum ConnectRole {
  /// The app asking for signatures.
  dapp,

  /// Zunia.
  wallet,
}

const _x25519 = DartX25519();
const _aead = DartChacha20.poly1305Aead();
const _protocol = ZuniaNativeConnect.protocolVersion;

ZuniaConnectException _pairingFailed(String message, [Object? cause]) =>
    ZuniaConnectException(ZuniaErrorCode.pairingFailed, message, cause: cause);

/// An X25519 key pair for one pairing.
class ConnectKeyPair {
  ConnectKeyPair._(this.secretKey, this.publicKey, this._pair);

  /// 32 bytes. Never leaves this app.
  final Uint8List secretKey;

  /// 32 bytes. Goes in the pairing link.
  final Uint8List publicKey;

  final SimpleKeyPair _pair;

  /// A fresh random key pair.
  static Future<ConnectKeyPair> generate() => fromSecret(randomBytes(32));

  /// The key pair for a known secret key (tests and vectors).
  static Future<ConnectKeyPair> fromSecret(List<int> secretKey) async {
    if (secretKey.length != 32) {
      throw _pairingFailed('An X25519 secret key is 32 bytes');
    }
    final pair = await _x25519.newKeyPairFromSeed(secretKey);
    final publicKey = await pair.extractPublicKey();
    return ConnectKeyPair._(Uint8List.fromList(secretKey),
        Uint8List.fromList(publicKey.bytes), pair);
  }

  /// The raw X25519 shared secret with [peerPublicKey].
  Future<Uint8List> sharedSecret(List<int> peerPublicKey) async {
    final secret = await _x25519.sharedSecretKey(
      keyPair: _pair,
      remotePublicKey: SimplePublicKey(peerPublicKey, type: KeyPairType.x25519),
    );
    return Uint8List.fromList(await secret.extractBytes());
  }
}

/// The two direction keys and the code both screens show.
class ConnectSessionKeys {
  /// Creates session keys.
  const ConnectSessionKeys({
    required this.dappToWallet,
    required this.walletToDapp,
    required this.verificationCode,
  });

  /// Key for frames the app sends.
  final Uint8List dappToWallet;

  /// Key for frames the wallet sends.
  final Uint8List walletToDapp;

  /// Six digits, zero-padded.
  final String verificationCode;
}

/// The salt: SHA-256("zunia.connect.v2" 0x00 sessionId 0x00 dappPublicKey walletPublicKey).
Uint8List connectTranscript(
    String sessionId, List<int> dappPublicKey, List<int> walletPublicKey) {
  final input = <int>[
    ...utf8.encode(_protocol),
    0,
    ...utf8.encode(sessionId),
    0,
    ...dappPublicKey,
    ...walletPublicKey,
  ];
  return Uint8List.fromList(hashes.sha256.convert(input).bytes);
}

/// Four HKDF bytes, big-endian, modulo one million, zero-padded to six digits.
String verificationCodeFrom(List<int> bytes) {
  // Multiplication, not shifts: on the web a shift past bit 31 goes negative.
  final value =
      bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
  return (value % 1000000).toString().padLeft(6, '0');
}

/// Derives the session keys from [own] and the peer's public key.
///
/// Throws `PAIRING_FAILED` for a key of the wrong length or one that gives an
/// all-zero shared secret.
Future<ConnectSessionKeys> deriveConnectKeys({
  required ConnectRole role,
  required String sessionId,
  required ConnectKeyPair own,
  required List<int> peerPublicKey,
}) async {
  if (peerPublicKey.length != 32) {
    throw _pairingFailed('The peer key must be 32 bytes');
  }
  final dappPublicKey =
      role == ConnectRole.dapp ? own.publicKey : peerPublicKey;
  final walletPublicKey =
      role == ConnectRole.dapp ? peerPublicKey : own.publicKey;
  final Uint8List shared;
  try {
    shared = await own.sharedSecret(peerPublicKey);
  } catch (error) {
    throw _pairingFailed('The peer key is not usable', error);
  }
  if (shared.every((byte) => byte == 0)) {
    throw _pairingFailed('The peer key is not usable');
  }
  final salt = connectTranscript(sessionId, dappPublicKey, walletPublicKey);
  Future<Uint8List> expand(String info, int length) async {
    final hkdf = DartHkdf(hmac: DartHmac.sha256(), outputLength: length);
    final key = await hkdf.deriveKey(
      secretKey: SecretKeyData(shared),
      nonce: salt,
      info: utf8.encode('$_protocol $info'),
    );
    return Uint8List.fromList(await key.extractBytes());
  }

  return ConnectSessionKeys(
    dappToWallet: await expand('dapp->wallet', 32),
    walletToDapp: await expand('wallet->dapp', 32),
    verificationCode:
        verificationCodeFrom(await expand('verification code', 4)),
  );
}

String _direction(ConnectRole sender) =>
    sender == ConnectRole.dapp ? 'dapp->wallet' : 'wallet->dapp';

/// Associated data for frames [sender] seals.
Uint8List frameAad(String sessionId, ConnectRole sender) => Uint8List.fromList(
    utf8.encode('$_protocol|$sessionId|${_direction(sender)}'));

/// ChaCha20-Poly1305; the result is the ciphertext followed by the 16-byte tag.
Uint8List encryptFrame(
    List<int> key, List<int> nonce, List<int> aad, List<int> plaintext) {
  final box = _aead.encryptSync(plaintext,
      secretKey: SecretKeyData(key), nonce: nonce, aad: aad);
  return Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
}

/// Throws [SecretBoxAuthenticationError] when the tag does not match.
Uint8List decryptFrame(
    List<int> key, List<int> nonce, List<int> aad, List<int> ciphertext) {
  if (ciphertext.length < 16) throw SecretBoxAuthenticationError();
  final split = ciphertext.length - 16;
  final box = SecretBox(ciphertext.sublist(0, split),
      nonce: nonce, mac: Mac(ciphertext.sublist(split)));
  return Uint8List.fromList(
      _aead.decryptSync(box, secretKey: SecretKeyData(key), aad: aad));
}

/// A sealed frame as it crosses the relay.
class SealedFrame {
  /// Creates a sealed frame.
  const SealedFrame({required this.n, required this.c});

  /// 12-byte nonce, unpadded base64url.
  final String n;

  /// Ciphertext and 16-byte tag, unpadded base64url.
  final String c;
}

/// The plaintext inside a sealed frame.
class ConnectEnvelope {
  /// Creates an envelope.
  const ConnectEnvelope(
      {required this.seq, required this.type, this.id, this.payload});

  /// Strictly increasing per direction.
  final int seq;

  /// Message type, such as `sign_direct` or `result`.
  final String type;

  /// Request id, on requests and their answers.
  final String? id;

  /// Message body.
  final Object? payload;
}

/// Seals outgoing frames and opens incoming ones for one side of a session.
class ConnectCipher {
  /// Creates a cipher for [role]. Pass the saved sequence numbers to resume.
  ConnectCipher({
    required ConnectRole role,
    required String sessionId,
    required List<int> dappToWallet,
    required List<int> walletToDapp,
    int sendSeq = 0,
    int receiveSeq = 0,
    Uint8List Function(int length)? nonceSource,
  })  : _sendKey = Uint8List.fromList(
            role == ConnectRole.dapp ? dappToWallet : walletToDapp),
        _receiveKey = Uint8List.fromList(
            role == ConnectRole.dapp ? walletToDapp : dappToWallet),
        _sendAad = frameAad(sessionId, role),
        _receiveAad = frameAad(sessionId,
            role == ConnectRole.dapp ? ConnectRole.wallet : ConnectRole.dapp),
        _sendSeq = sendSeq,
        _receiveSeq = receiveSeq,
        _nonce = nonceSource ?? randomBytes;

  final Uint8List _sendKey;
  final Uint8List _receiveKey;
  final Uint8List _sendAad;
  final Uint8List _receiveAad;
  final Uint8List Function(int length) _nonce;
  int _sendSeq;
  int _receiveSeq;

  /// Sequence number of the last frame sealed.
  int get sendSeq => _sendSeq;

  /// Sequence number of the last frame accepted.
  int get receiveSeq => _receiveSeq;

  /// Seals one message with the next sequence number.
  SealedFrame seal({required String type, String? id, Object? payload}) {
    final seq = _sendSeq + 1;
    final envelope = <String, Object?>{
      'seq': seq,
      'type': type,
      if (id != null) 'id': id,
      if (payload != null) 'payload': payload,
    };
    final nonce = _nonce(12);
    final ciphertext = encryptFrame(
        _sendKey, nonce, _sendAad, utf8.encode(jsonEncode(envelope)));
    _sendSeq = seq;
    return SealedFrame(
        n: bytesToBase64Url(nonce), c: bytesToBase64Url(ciphertext));
  }

  /// Throws `PAIRING_FAILED` for a forged, tampered, replayed or reordered frame.
  ConnectEnvelope open(SealedFrame frame) {
    final envelope = openFresh(frame);
    if (envelope == null) {
      throw _pairingFailed('A frame was replayed or reordered');
    }
    return envelope;
  }

  /// Like [open], but returns null for an authentic frame that is not newer
  /// than the last one accepted: a copy the other side resent after a
  /// reconnect. Forged and tampered frames still throw.
  ConnectEnvelope? openFresh(SealedFrame frame) {
    Object? decoded;
    try {
      final plaintext = decryptFrame(_receiveKey, base64UrlToBytes(frame.n),
          _receiveAad, base64UrlToBytes(frame.c));
      decoded = jsonDecode(utf8.decode(plaintext));
    } catch (error) {
      throw _pairingFailed('A frame failed to decrypt', error);
    }
    if (decoded is! Map<String, Object?>) {
      throw _pairingFailed('A frame has no valid envelope');
    }
    final seq = decoded['seq'];
    final type = decoded['type'];
    final id = decoded['id'];
    if (seq is! int ||
        seq < 0 ||
        type is! String ||
        (id != null && id is! String)) {
      throw _pairingFailed('A frame has no valid envelope');
    }
    if (seq <= _receiveSeq) return null;
    _receiveSeq = seq;
    return ConnectEnvelope(
        seq: seq, type: type, id: id as String?, payload: decoded['payload']);
  }
}
