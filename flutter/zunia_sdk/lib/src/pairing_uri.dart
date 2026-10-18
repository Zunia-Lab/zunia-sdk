/// zunia.connect.v2 pairing and wake links.
///
/// ```text
/// zunia://connect?v=2&sid=<22>&t=<43>&pk=<43>&r=<relay ws base>[&ret=<return URL>]
/// zunia://connect/wake?sid=<22>
/// ```
///
/// An `https://zunialab.com/connect?...` link carries the same query. The
/// parser accepts what `parsePairingUri` in `@zunialab/sdk-core` and the Zunia
/// wallet accept.
library;

import 'constants.dart';
import 'errors.dart';

final _sessionId = RegExp(r'^[A-Za-z0-9_-]{22}$');
final _token = RegExp(r'^[A-Za-z0-9_-]{43}$');
final _scheme = RegExp(r'^[A-Za-z][A-Za-z0-9+.-]*$');
// RFC 3986 characters only, and every % starts a valid escape.
final _uriChars =
    RegExp(r"^(?:[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})+$");

/// Schemes a wallet never opens as a return target.
const Set<String> blockedReturnSchemes = {
  'zunia',
  'zuniamobile',
  'wc',
  'javascript',
  'data',
  'file',
  'blob',
  'about',
  'content',
  'intent',
  'http',
};

/// True when Zunia would open [value] after an approval or a rejection:
/// an `https:` URL, or a custom-scheme URL (`myapp://zunia-return`) whose
/// scheme is not in [blockedReturnSchemes], RFC 3986 valid, at most 512
/// characters.
bool isAllowedReturnUrl(String value) {
  if (value.isEmpty || value.length > ZuniaNativeConnect.maxReturnUrlLength) {
    return false;
  }
  if (!_uriChars.hasMatch(value)) return false;
  final colon = value.indexOf(':');
  if (colon <= 0) return false;
  final scheme = value.substring(0, colon);
  if (!_scheme.hasMatch(scheme)) return false;
  final lower = scheme.toLowerCase();
  if (blockedReturnSchemes.contains(lower)) return false;
  final uri = Uri.tryParse(value);
  if (uri == null) return false;
  if (lower == 'https') return uri.host.isNotEmpty;
  return true;
}

/// What a pairing link carries.
class ZuniaPairingUri {
  /// Creates pairing parameters.
  const ZuniaPairingUri({
    required this.sessionId,
    required this.joinToken,
    required this.dappPublicKey,
    required this.relay,
    this.returnUrl,
  });

  /// 22-character session id.
  final String sessionId;

  /// Single-use token the wallet joins with. 43 characters.
  final String joinToken;

  /// The app's X25519 public key, unpadded base64url.
  final String dappPublicKey;

  /// Relay WebSocket base, for example `wss://api.zunialab.com`.
  final String relay;

  /// Where Zunia returns after the person answers, when the link was opened
  /// on the same device. Null when absent or not allowed.
  final String? returnUrl;
}

Map<String, String> _query(ZuniaPairingUri params, {bool withReturn = true}) {
  final returnUrl = params.returnUrl;
  if (withReturn && returnUrl != null && !isAllowedReturnUrl(returnUrl)) {
    throw ZuniaConnectException(ZuniaErrorCode.invalidParams,
        'returnUrl must be an https URL or your own app scheme, at most 512 characters');
  }
  return {
    'v': '2',
    'sid': params.sessionId,
    't': params.joinToken,
    'pk': params.dappPublicKey,
    'r': params.relay,
    if (withReturn && returnUrl != null) 'ret': returnUrl,
  };
}

String _encode(Map<String, String> query) => query.entries
    .map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}')
    .join('&');

/// `zunia://connect?v=2&sid=…&t=…&pk=…&r=…`, plus `ret` when [ZuniaPairingUri.returnUrl] is set.
///
/// Throws `INVALID_PARAMS` for a return URL Zunia would ignore.
String buildPairingUri(ZuniaPairingUri params) =>
    '${ZuniaNativeConnect.deepLinkPath}?${_encode(_query(params))}';

/// The same pairing as an `https://zunialab.com/connect?…` link.
String buildPairingUniversalLink(ZuniaPairingUri params) =>
    '${ZuniaNativeConnect.universalPath}?${_encode(_query(params))}';

String? _first(Uri uri, String key) {
  final values = uri.queryParametersAll[key];
  return values == null || values.isEmpty ? null : values.first;
}

/// Reads a v2 pairing link (custom scheme or https). Returns null for
/// anything else, including v1 links. An unusable `ret` is dropped, not fatal.
ZuniaPairingUri? parsePairingUri(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null) return null;
  final isScheme = uri.scheme == ZuniaConstants.customScheme &&
      (uri.host == 'connect' ||
          uri.path.replaceFirst(RegExp(r'^/+'), '') == 'connect');
  final isLink = uri.scheme == 'https' &&
      uri.host.isNotEmpty &&
      uri.path.replaceFirst(RegExp(r'/$'), '') == '/connect';
  if (!isScheme && !isLink) return null;
  final sessionId = _first(uri, 'sid') ?? '';
  final joinToken = _first(uri, 't') ?? '';
  final dappPublicKey = _first(uri, 'pk') ?? '';
  final relay = _first(uri, 'r') ?? '';
  if (_first(uri, 'v') != '2' ||
      !_sessionId.hasMatch(sessionId) ||
      !_token.hasMatch(joinToken) ||
      !_token.hasMatch(dappPublicKey)) {
    return null;
  }
  final relayUri = Uri.tryParse(relay);
  if (relayUri == null ||
      (relayUri.scheme != 'wss' && relayUri.scheme != 'ws') ||
      relayUri.host.isEmpty) {
    return null;
  }
  final ret = _first(uri, 'ret');
  return ZuniaPairingUri(
    sessionId: sessionId,
    joinToken: joinToken,
    dappPublicKey: dappPublicKey,
    relay: relay,
    returnUrl: ret != null && isAllowedReturnUrl(ret) ? ret : null,
  );
}

/// `zunia://connect/wake?sid=…`: brings a paired session to the front of
/// Zunia so the person sees the request waiting. It carries no secret and
/// never pairs; Zunia ignores a session id it does not know.
///
/// Throws `INVALID_PARAMS` for a malformed session id.
Uri buildWakeLink(String sessionId, {bool universal = false}) {
  if (!_sessionId.hasMatch(sessionId)) {
    throw const ZuniaConnectException(ZuniaErrorCode.invalidParams,
        'A session id is 22 base64url characters');
  }
  final base = universal
      ? ZuniaNativeConnect.wakeUniversalPath
      : ZuniaNativeConnect.wakeDeepLinkPath;
  return Uri.parse('$base?sid=$sessionId');
}

/// The session id in a wake link, or null when [value] is not one.
String? parseWakeLink(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null) return null;
  final path = uri.path.replaceFirst(RegExp(r'/$'), '');
  final isScheme = uri.scheme == ZuniaConstants.customScheme &&
      uri.host == 'connect' &&
      path == '/wake';
  final isLink = uri.scheme == 'https' &&
      (uri.host == 'zunialab.com' || uri.host == 'link.zunialab.com') &&
      path == '/connect/wake';
  if (!isScheme && !isLink) return null;
  final sid = _first(uri, 'sid') ?? '';
  return _sessionId.hasMatch(sid) ? sid : null;
}
