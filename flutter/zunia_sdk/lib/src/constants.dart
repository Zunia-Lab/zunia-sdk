/// Deep link and WalletConnect constants for Zunia mobile.
class ZuniaConstants {
  ZuniaConstants._();

  static const String walletName = 'Zunia';
  static const String walletUrl = 'https://zuniawallet.com';
  static const String docsUrl = 'https://docs.zuniawallet.com';

  static const String androidApplicationId = 'com.zuniawallet.zunia_mobile';
  static const String iosBundleId = 'com.zuniawallet.zuniaMobile';

  static const String customScheme = 'zunia';
  static const String mobileScheme = 'zuniamobile';
  static const String walletConnectScheme = 'wc';

  static const String universalWc = 'https://zuniawallet.com/wc';
  static const String universalConnect = 'https://zuniawallet.com/connect';
  static const String linkWc = 'https://link.zuniawallet.com/wc';

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
