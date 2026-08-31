import 'constants.dart';

/// Helpers for opening / building Zunia wallet connection URIs.
///
/// WalletConnect session handling is not implemented in this scaffold —
/// pair this with `walletconnect_flutter_v2` (or similar) using [projectId].
class ZuniaConnect {
  ZuniaConnect._();

  static String get walletConnectUniversalLink => ZuniaConstants.universalWc;

  static String get deepLinkWc => '${ZuniaConstants.customScheme}://wc';

  /// Builds a Universal Link that should open Zunia when App / Universal Links are verified.
  static Uri universalWalletConnectUri({String? topic, Map<String, String>? query}) {
    return Uri.https(
      'zuniawallet.com',
      '/wc',
      {
        if (topic != null) 'topic': topic,
        ...?query,
      },
    );
  }

  /// Custom-scheme deep link (always available; less secure than verified HTTPS links).
  static Uri customWalletConnectUri({String? topic, Map<String, String>? query}) {
    return Uri(
      scheme: ZuniaConstants.customScheme,
      host: 'wc',
      queryParameters: {
        if (topic != null) 'topic': topic,
        ...?query,
      },
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
        (uri.host == 'zuniawallet.com' || uri.host == 'link.zuniawallet.com')) {
      return uri.path.startsWith('/wc') || uri.path.startsWith('/connect');
    }
    return false;
  }
}
