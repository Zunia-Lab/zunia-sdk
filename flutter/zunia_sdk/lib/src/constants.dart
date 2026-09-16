/// Deep link and WalletConnect constants for Zunia mobile.
class ZuniaConstants {
  ZuniaConstants._();

  static const String walletName = 'Zunia';
  static const String walletUrl = 'https://zunialab.com';
  static const String docsUrl = 'https://docs.zunialab.com';

  static const String androidApplicationId = 'com.zuniawallet.zunia_mobile';
  static const String iosBundleId = 'com.zuniawallet.zuniaMobile';

  static const String customScheme = 'zunia';
  static const String mobileScheme = 'zuniamobile';
  static const String walletConnectScheme = 'wc';

  static const String universalWc = 'https://zunialab.com/wc';
  static const String universalConnect = 'https://zunialab.com/connect';
  static const String linkWc = 'https://link.zunialab.com/wc';

  static const String walletConnectRelayUrl = 'wss://relay.walletconnect.com';

  static const List<String> cosmosWcMethods = [
    'cosmos_getAccounts',
    'cosmos_signAmino',
    'cosmos_signDirect',
    'cosmos_signArbitrary',
  ];

  static const List<String> cosmosWcEvents = [
    'accountsChanged',
    'chainChanged',
  ];
}

/// First-party Zunia-native connect (HTTP + WebSocket broker).
///
/// Mirrors `@zunialab/sdk-core` `ZUNIA_NATIVE_CONNECT`.
class ZuniaNativeConnect {
  ZuniaNativeConnect._();

  static const String protocolVersion = 'zunia.connect.v1';
  static const String httpPath = '/v1/connect/sessions';
  static const String wsPath = '/v1/connect/ws';
  static const String deepLinkPath = 'zunia://connect';
  static const String universalPath = 'https://zunialab.com/connect';

  static const List<String> defaultMethods = [
    'enable',
    'getKey',
    'getAccounts',
    'signAmino',
    'signDirect',
    'signArbitrary',
  ];

  static const List<String> defaultEvents = [
    'accountsChanged',
    'chainChanged',
  ];

  static const int unpairedTtlSeconds = 900;
  static const int pairedTtlSeconds = 86400;
}
