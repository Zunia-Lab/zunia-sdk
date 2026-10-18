import 'package:url_launcher/url_launcher.dart';

import 'constants.dart';

/// Opens a link in another app. Returns false when nothing could open it.
typedef ZuniaLinkLauncher = Future<bool> Function(Uri link);

/// Opens [link] in the app that owns it (Zunia for `zunia://`), never in an
/// in-app browser.
Future<bool> launchExternal(Uri link) async {
  try {
    return await launchUrl(link, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}

/// Deep links into Zunia mobile.
class ZuniaLinks {
  ZuniaLinks._();

  /// `zunia://`, which opens Zunia's home screen.
  static Uri get home => Uri.parse('${ZuniaConstants.customScheme}://');

  /// Whether Zunia is installed on this device.
  ///
  /// Android needs a `<queries>` entry for the `zunia` scheme and iOS needs
  /// `zunia` in `LSApplicationQueriesSchemes`; without them this answers
  /// false even when Zunia is installed. See the package README.
  static Future<bool> isInstalled() async {
    try {
      return await canLaunchUrl(home);
    } catch (_) {
      return false;
    }
  }

  /// Opens the page where people get Zunia.
  static Future<bool> openInstallPage() =>
      launchExternal(Uri.parse(ZuniaConstants.installUrl));

  /// A WalletConnect pairing URI wrapped for Zunia: `zunia://wc?uri=…`, or
  /// `https://zunialab.com/wc?uri=…` when [universal].
  static Uri walletConnect(String wcUri, {bool universal = false}) => universal
      ? Uri.parse(ZuniaConstants.universalWc)
          .replace(queryParameters: {'uri': wcUri})
      : Uri(
          scheme: ZuniaConstants.customScheme,
          host: 'wc',
          queryParameters: {'uri': wcUri});

  /// Whether [uri] is a Zunia pairing, wake or WalletConnect link.
  static bool isZuniaLink(Uri uri) {
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
}
