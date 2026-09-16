import 'constants.dart';
import 'session.dart';

/// Helpers for opening / building Zunia wallet connection URIs.
///
/// For native WebSocket sessions use [ZuniaSession] / [ZuniaNativeSessionClient].
/// Pair WalletConnect with `walletconnect_flutter_v2` (or similar) using a
/// Cloud project id, then open [deepLinkWc] / [universalWalletConnectUri].
class ZuniaConnect {
  ZuniaConnect._();

  static String get walletConnectUniversalLink => ZuniaConstants.universalWc;

  static String get deepLinkWc => '${ZuniaConstants.customScheme}://wc';

  static String get deepLinkConnect => ZuniaNativeConnect.deepLinkPath;

  static String get nativeUniversalConnect => ZuniaNativeConnect.universalPath;

  /// Builds a Universal Link that should open Zunia when App / Universal Links are verified.
  static Uri universalWalletConnectUri({
    String? topic,
    String? uri,
    Map<String, String>? query,
  }) {
    return Uri.https(
      'zunialab.com',
      '/wc',
      {
        if (topic != null) 'topic': topic,
        if (uri != null) 'uri': uri,
        ...?query,
      },
    );
  }

  /// Custom-scheme deep link (always available; less secure than verified HTTPS links).
  static Uri customWalletConnectUri({
    String? topic,
    String? uri,
    Map<String, String>? query,
  }) {
    return Uri(
      scheme: ZuniaConstants.customScheme,
      host: 'wc',
      queryParameters: {
        if (topic != null) 'topic': topic,
        if (uri != null) 'uri': uri,
        ...?query,
      },
    );
  }

  /// Native connect deep link with session id + pairing secret.
  static Uri nativeConnectDeepLink({
    required String sessionId,
    required String pairingSecret,
  }) {
    return Uri.parse(
      '${ZuniaNativeConnect.deepLinkPath}'
      '?sid=${Uri.encodeComponent(sessionId)}'
      '&k=${Uri.encodeComponent(pairingSecret)}',
    );
  }

  /// Whether [uri] looks like a Zunia / WalletConnect inbound link.
  static bool isZuniaConnectUri(Uri uri) {
    if (uri.scheme == ZuniaConstants.walletConnectScheme) return true;
    if (uri.scheme == ZuniaConstants.customScheme ||
        uri.scheme == ZuniaConstants.mobileScheme) {
      return uri.host == 'wc' || uri.host == 'connect' || uri.host == 'dapp';
    }
    if (uri.scheme == 'https' &&
        (uri.host == 'zunialab.com' || uri.host == 'link.zunialab.com')) {
      return uri.path.startsWith('/wc') || uri.path.startsWith('/connect');
    }
    return false;
  }

  /// Convenience: wrap a WC pairing string for the mobile wallet.
  static Uri wrapWcUri(String wcUri, {bool universal = false}) {
    return universal
        ? ZuniaWcUri.universalFromWcUri(wcUri)
        : ZuniaWcUri.deepLinkFromWcUri(wcUri);
  }
}
