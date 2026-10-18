/// Sign in with Zunia: a CAIP-122 message (the Cosmos form of Sign-In with
/// Ethereum) that the wallet signs with ADR-036.
///
/// ```text
/// app.example.com wants you to sign in with your Cosmos account:
/// cosmos1...
///
/// Optional statement.
///
/// URI: https://app.example.com
/// Version: 1
/// Chain ID: cosmoshub-4
/// Nonce: 32891756
/// Issued At: 2026-09-24T10:00:00.000Z
/// Expiration Time: 2026-09-24T10:10:00.000Z
/// ```
///
/// The parser is the one the Zunia wallet runs. The shared vectors in
/// `test/fixtures/sign-in-vectors.json` keep them identical.
library;

import 'encoding.dart';
import 'errors.dart';

/// A parsed sign-in message.
class SignInMessage {
  /// Creates a sign-in message.
  const SignInMessage({
    required this.domain,
    required this.address,
    required this.uri,
    required this.chainId,
    required this.nonce,
    required this.issuedAt,
    this.statement,
    this.expirationTime,
    this.notBefore,
    this.requestId,
    this.resources,
  });

  /// Host (and port) of the site asking, such as `app.example.com`.
  final String domain;

  /// The account signing in.
  final String address;

  /// One line shown to the person, if any.
  final String? statement;

  /// The page asking, on [domain].
  final String uri;

  /// Chain of [address].
  final String chainId;

  /// Your server's single-use nonce.
  final String nonce;

  /// RFC 3339.
  final String issuedAt;

  /// RFC 3339, if any.
  final String? expirationTime;

  /// RFC 3339, if any.
  final String? notBefore;

  /// Free-form request id, if any.
  final String? requestId;

  /// URIs the sign-in covers, if any.
  final List<String>? resources;

  /// Always `1`.
  String get version => '1';

  /// The fields, without the absent ones.
  Map<String, Object?> toJson() => {
        'domain': domain,
        'address': address,
        if (statement != null) 'statement': statement,
        'uri': uri,
        'version': version,
        'chainId': chainId,
        'nonce': nonce,
        'issuedAt': issuedAt,
        if (expirationTime != null) 'expirationTime': expirationTime,
        if (notBefore != null) 'notBefore': notBefore,
        if (requestId != null) 'requestId': requestId,
        if (resources != null) 'resources': resources,
      };
}

/// Longest sign-in text.
const int kSignInMaxLength = 4096;

/// Longest statement.
const int kSignInMaxStatement = 512;

/// Longest request id.
const int kSignInMaxRequestId = 256;

/// Most resources.
const int kSignInMaxResources = 32;

const _header = ' wants you to sign in with your Cosmos account:';

final _domain = RegExp(
    r'^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::\d{1,5})?$');
final _address = RegExp(r'^[a-z][a-z0-9]{0,40}1[02-9ac-hj-np-z]{6,100}$');
final _chainId = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
final _nonce = RegExp(r'^[A-Za-z0-9]{8,128}$');
final _dateTime = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$');

// Control, format (bidi overrides, zero-width) and line separator characters.
final _hidden = RegExp(r'[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]', unicode: true);
final _whitespace = RegExp(r'\s');

/// True for anything that reads like a sign-in request. Zunia never signs
/// such text as a plain message.
bool looksLikeSignIn(String text) =>
    RegExp('wants you to sign in with your', caseSensitive: false)
        .hasMatch(text);

Never _invalid(String message) =>
    throw ZuniaConnectException(ZuniaErrorCode.invalidParams, message);

DateTime? _parseDate(String value) {
  final match = _dateTime.firstMatch(value);
  if (match == null) return null;
  int part(int i) => int.parse(match.group(i)!);
  final month = part(2);
  final day = part(3);
  if (month < 1 || month > 12) return null;
  final daysInMonth = DateTime.utc(part(1), month + 1, 0).day;
  if (day < 1 ||
      day > daysInMonth ||
      part(4) > 23 ||
      part(5) > 59 ||
      part(6) > 59) {
    return null;
  }
  if (match.group(7) != null && (part(7) > 23 || part(8) > 59)) return null;
  return DateTime.tryParse(value);
}

String _checkDate(String label, String value) {
  if (_parseDate(value) == null) {
    _invalid('$label must be an RFC 3339 date-time');
  }
  return value;
}

const _hostSchemes = {'http', 'https', 'ws', 'wss', 'ftp'};

String _checkUri(String label, String value) {
  final uri = Uri.tryParse(value);
  if (value.isEmpty ||
      _whitespace.hasMatch(value) ||
      _hidden.hasMatch(value) ||
      uri == null ||
      !uri.hasScheme ||
      (_hostSchemes.contains(uri.scheme) && uri.host.isEmpty)) {
    _invalid('$label is not a valid URI');
  }
  return value;
}

/// Reads a sign-in text, or throws `INVALID_PARAMS` naming the first problem.
SignInMessage parseSignInMessage(String text) {
  if (text.length > kSignInMaxLength) {
    _invalid('The sign-in message is too long');
  }
  final lines = text.split('\n');
  var at = 0;
  String? line(int index) => index < lines.length ? lines[index] : null;

  final header = line(at++) ?? '';
  if (!header.endsWith(_header)) {
    _invalid(
        'Zunia signs in with Cosmos accounts only, in the CAIP-122 format');
  }
  final domain = header.substring(0, header.length - _header.length);
  if (!_domain.hasMatch(domain)) {
    _invalid('The sign-in message names an invalid domain');
  }

  final address = line(at++) ?? '';
  if (!_address.hasMatch(address)) {
    _invalid('The sign-in message names an invalid address');
  }
  if (line(at++) != '') _invalid('A blank line must follow the address');

  String? statement;
  final next = line(at);
  if (next != null && !next.startsWith('URI: ')) {
    statement = next;
    at += 1;
    if (statement.trim().isEmpty || _hidden.hasMatch(statement)) {
      _invalid('The sign-in statement must be one line of visible text');
    }
    if (statement.length > kSignInMaxStatement) {
      _invalid('The sign-in statement is too long');
    }
    if (line(at++) != '') _invalid('A blank line must follow the statement');
  }

  String field(String name) {
    final value = line(at);
    final prefix = '$name: ';
    if (value == null || !value.startsWith(prefix)) {
      _invalid('Expected "$name:" on line ${at + 1}');
    }
    at += 1;
    return value.substring(prefix.length);
  }

  String? optional(String name) =>
      (line(at)?.startsWith('$name: ') ?? false) ? field(name) : null;

  final uri = _checkUri('URI', field('URI'));
  if (field('Version') != '1') {
    _invalid('Only version 1 sign-in messages are supported');
  }
  final chainId = field('Chain ID');
  if (!_chainId.hasMatch(chainId)) {
    _invalid('The sign-in message names an invalid chain ID');
  }
  final nonce = field('Nonce');
  if (!_nonce.hasMatch(nonce)) {
    _invalid('The nonce must be 8 to 128 letters or digits');
  }
  final issuedAt = _checkDate('Issued At', field('Issued At'));

  final expirationTime = optional('Expiration Time');
  if (expirationTime != null) _checkDate('Expiration Time', expirationTime);
  final notBefore = optional('Not Before');
  if (notBefore != null) _checkDate('Not Before', notBefore);
  final requestId = optional('Request ID');
  if (requestId != null &&
      (requestId.isEmpty ||
          _hidden.hasMatch(requestId) ||
          requestId.length > kSignInMaxRequestId)) {
    _invalid('The request ID must be one line of visible text');
  }

  List<String>? resources;
  if (line(at) == 'Resources:') {
    at += 1;
    resources = [];
    while (line(at)?.startsWith('- ') ?? false) {
      resources.add(_checkUri('Resource', lines[at].substring(2)));
      at += 1;
    }
    if (resources.isEmpty) _invalid('Resources: must list at least one URI');
    if (resources.length > kSignInMaxResources) {
      _invalid('The sign-in message lists too many resources');
    }
  }

  if (at != lines.length) _invalid('Unexpected content on line ${at + 1}');

  return SignInMessage(
    domain: domain,
    address: address,
    statement: statement,
    uri: uri,
    chainId: chainId,
    nonce: nonce,
    issuedAt: issuedAt,
    expirationTime: expirationTime,
    notBefore: notBefore,
    requestId: requestId,
    resources: resources,
  );
}

/// Writes the exact text Zunia expects. Throws `INVALID_PARAMS` when a field
/// would not survive the wallet's parser unchanged.
String buildSignInMessage(SignInMessage message) {
  final lines = <String>['${message.domain}$_header', message.address, ''];
  if (message.statement != null) lines.addAll([message.statement!, '']);
  lines.addAll([
    'URI: ${message.uri}',
    'Version: ${message.version}',
    'Chain ID: ${message.chainId}',
    'Nonce: ${message.nonce}',
    'Issued At: ${message.issuedAt}',
  ]);
  if (message.expirationTime != null) {
    lines.add('Expiration Time: ${message.expirationTime}');
  }
  if (message.notBefore != null) lines.add('Not Before: ${message.notBefore}');
  if (message.requestId != null) lines.add('Request ID: ${message.requestId}');
  if (message.resources != null) {
    lines
      ..add('Resources:')
      ..addAll(message.resources!.map((resource) => '- $resource'));
  }
  final text = lines.join('\n');
  final parsed = parseSignInMessage(text);
  final want = message.toJson();
  final got = parsed.toJson();
  final same = want.length == got.length &&
      want.keys.every((key) => _sameValue(want[key], got[key]));
  if (!same) {
    _invalid('A sign-in field contains text the wallet would read differently');
  }
  return text;
}

bool _sameValue(Object? a, Object? b) {
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
  return a == b;
}

/// 128 random bits as 32 hex characters, a valid sign-in nonce. Issue one per
/// attempt, on your server.
String createNonce() => bytesToHex(randomBytes(16));

/// RFC 3339 in UTC with milliseconds, as JavaScript's `toISOString` writes it.
String toIsoString(DateTime time) {
  final utc = time.toUtc();
  String two(int v) => v.toString().padLeft(2, '0');
  final ms = utc.millisecond.toString().padLeft(3, '0');
  return '${utc.year.toString().padLeft(4, '0')}-${two(utc.month)}-${two(utc.day)}'
      'T${two(utc.hour)}:${two(utc.minute)}:${two(utc.second)}.${ms}Z';
}
