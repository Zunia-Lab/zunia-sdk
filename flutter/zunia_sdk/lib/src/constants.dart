/// Wallet identity, deep links and WalletConnect values for Zunia.
///
/// Mirrors `ZUNIA_WALLET`, `ZUNIA_DEEP_LINKS`, `ZUNIA_APP_IDS` and
/// `ZUNIA_WALLETCONNECT` in `@zunialab/sdk-core`.
class ZuniaConstants {
  ZuniaConstants._();

  /// The wallet's display name.
  static const String walletName = 'Zunia';

  /// The wallet's website.
  static const String walletUrl = 'https://zunialab.com';

  /// Developer documentation.
  static const String docsUrl = 'https://docs.zunialab.com';

  /// Where to send people who do not have Zunia yet.
  static const String installUrl = 'https://zunialab.com';

  /// The wallet icon, 512 px.
  static const String iconUrl =
      'https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-512.png';

  /// Android application id of Zunia mobile.
  static const String androidApplicationId = 'com.zuniawallet.zunia_mobile';

  /// iOS bundle id of Zunia mobile.
  static const String iosBundleId = 'com.zuniawallet.zuniaMobile';

  /// Custom URL scheme Zunia mobile registers (`zunia://`).
  static const String customScheme = 'zunia';

  /// Second scheme Zunia mobile registers (`zuniamobile://`).
  static const String mobileScheme = 'zuniamobile';

  /// The WalletConnect scheme (`wc:`).
  static const String walletConnectScheme = 'wc';

  /// Universal link for WalletConnect pairing URIs.
  static const String universalWc = 'https://zunialab.com/wc';

  /// Universal link for zunia.connect.v2 pairing.
  static const String universalConnect = 'https://zunialab.com/connect';

  /// Short-link host for WalletConnect pairing URIs.
  static const String linkWc = 'https://link.zunialab.com/wc';

  /// WalletConnect v2 relay.
  static const String walletConnectRelayUrl = 'wss://relay.walletconnect.com';

  /// Cosmos methods Zunia answers over WalletConnect.
  static const List<String> cosmosWcMethods = [
    'cosmos_getAccounts',
    'cosmos_signAmino',
    'cosmos_signDirect',
    'cosmos_signArbitrary',
  ];

  /// Cosmos events Zunia emits over WalletConnect.
  static const List<String> cosmosWcEvents = [
    'accountsChanged',
    'chainChanged',
  ];
}

/// First-party pairing with Zunia mobile through the Zunia relay
/// (zunia.connect.v2).
///
/// Mirrors `ZUNIA_NATIVE_CONNECT`, `ZUNIA_CONNECT_PATHS` and
/// `ZUNIA_CONNECT_CLOSE_CODES` in `@zunialab/sdk-core`.
class ZuniaNativeConnect {
  ZuniaNativeConnect._();

  /// Protocol name, also the WebSocket subprotocol.
  static const String protocolVersion = 'zunia.connect.v2';

  /// Prefix of the subprotocol that carries the session token.
  static const String tokenProtocolPrefix = 'zunia.token.';

  /// The public Zunia relay, open to any app.
  static const String defaultApiBase = 'https://api.zunialab.com';

  /// `POST` creates a session; `DELETE /<id>` ends one.
  static const String httpPath = '/v1/connect/sessions';

  /// WebSocket endpoint.
  static const String wsPath = '/v1/connect/ws';

  /// Pairing deep link base.
  static const String deepLinkPath = 'zunia://connect';

  /// Pairing universal link base.
  static const String universalPath = 'https://zunialab.com/connect';

  /// Wake link base: brings a paired session to the front of Zunia.
  static const String wakeDeepLinkPath = 'zunia://connect/wake';

  /// Wake universal link base.
  static const String wakeUniversalPath = 'https://zunialab.com/connect/wake';

  /// Requests a dApp may send.
  static const List<String> defaultMethods = [
    'get_accounts',
    'sign_amino',
    'sign_direct',
    'sign_arbitrary',
  ];

  /// Events the wallet sends.
  static const List<String> defaultEvents = [
    'accounts_changed',
    'chains_changed',
  ];

  /// How long an unpaired session waits for a scan.
  static const int unpairedTtlSeconds = 600;

  /// How long a session lives once paired.
  static const int pairedTtlSeconds = 86400;

  /// Largest WebSocket frame the relay accepts.
  static const int maxFrameBytes = 512 * 1024;

  /// Frames the relay holds for a peer that is offline, per direction.
  static const int queueMaxFrames = 32;

  /// Bytes the relay holds for offline peers, per session.
  static const int queueMaxBytes = 1024 * 1024;

  /// Longest `ret` (return URL) a wallet accepts.
  static const int maxReturnUrlLength = 512;

  /// Close code: another connection resumed the session.
  static const int closeReplaced = 4000;

  /// Close code: the session ended.
  static const int closeEnded = 4001;

  /// Close code: too many frames.
  static const int closeRateLimited = 4008;

  /// Close code: unknown session or wrong token.
  static const int closeUnauthorized = 4401;
}
