import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

final _base64UrlChars = RegExp(r'^[A-Za-z0-9_-]*$');
final Random _random = Random.secure();

/// Unpadded base64url, as zunia.connect.v2 writes keys, nonces and ciphertexts.
String bytesToBase64Url(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// Reads unpadded base64url. Throws [FormatException] for anything else.
Uint8List base64UrlToBytes(String value) {
  if (!_base64UrlChars.hasMatch(value) || value.length % 4 == 1) {
    throw const FormatException('Expected unpadded base64url');
  }
  return base64Url.decode(base64Url.normalize(value));
}

/// Standard padded base64, as Cosmos signatures and sign docs use.
String bytesToBase64(List<int> bytes) => base64.encode(bytes);

/// Reads standard base64.
Uint8List base64ToBytes(String value) => base64.decode(value);

/// Lowercase hex.
String bytesToHex(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();

/// Reads hex. Throws [FormatException] for odd lengths or non-hex characters.
Uint8List hexToBytes(String hex) {
  if (hex.length.isOdd) throw const FormatException('Odd-length hex');
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// Cryptographically secure random bytes.
Uint8List randomBytes(int length) {
  final out = Uint8List(length);
  for (var i = 0; i < length; i++) {
    out[i] = _random.nextInt(256);
  }
  return out;
}
