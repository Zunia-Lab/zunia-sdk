import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'connect_crypto.dart';
import 'constants.dart';
import 'encoding.dart';
import 'errors.dart';
import 'links.dart';
import 'pairing_uri.dart';
import 'sign_in.dart';
import 'storage.dart';
import 'types.dart';

/// Opens a WebSocket to the relay offering [protocols].
typedef ZuniaSocketFactory = WebSocketChannel Function(
    Uri url, List<String> protocols);

/// Whether the client opens Zunia by itself.
enum ZuniaOpenWallet {
  /// On a phone, once the session was paired with [ZuniaConnectClient.openZunia]
  /// on that same phone, every signature request also opens Zunia so the
  /// person sees it at once.
  auto,

  /// Never. Your app tells people to open Zunia.
  never,
}

const _defaultStorageKey = 'zunia.connect.v2.session';
const _refreshTimeout = Duration(seconds: 30);
const _unackedLimit = 32;
const _signInTtl = Duration(minutes: 10);
final _sessionIdPattern = RegExp(r'^[A-Za-z0-9_-]{22}$');
final _tokenPattern = RegExp(r'^[A-Za-z0-9_-]{43}$');

enum _Phase { idle, pairing, active, ended }

class _RelaySession {
  _RelaySession({
    required this.apiBase,
    required this.wsUrl,
    required this.sessionId,
    required this.dappToken,
    required this.expiresAt,
    required this.verifiedOrigin,
    this.sameDevice = false,
  });

  final String apiBase;
  final String wsUrl;
  final String sessionId;
  final String dappToken;
  int expiresAt;
  String? verifiedOrigin;
  bool sameDevice;
}

class _Pending {
  _Pending(this.completer, this.timer);
  final Completer<Object?> completer;
  final Timer timer;
}

/// A sealed frame still waiting for its answer.
class _Unacked {
  _Unacked(this.id, this.data);
  final String id;
  final String data;

  /// Its sequence number is saved, so it may leave.
  bool ready = false;

  /// The write counter when it last went out.
  int? sent;
}

class _Attempt {
  _Attempt(this.requestId, this.chains, this.completer);
  final String requestId;
  final List<String> chains;
  final Completer<void> completer;
  Timer? timer;
}

/// A ping on the wire. The relay answers frames in order, so its pong
/// confirms everything written before it, and a relay error that arrives
/// before it is about the frame [id] written just before it.
class _Probe {
  _Probe(this.mark, this.id);
  final int mark;
  final String? id;
}

class _LifecycleObserver with WidgetsBindingObserver {
  _LifecycleObserver(this.onResume);
  final VoidCallback onResume;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) onResume();
  }
}

String _trimSlash(String value) => value.replaceFirst(RegExp(r'/+$'), '');

List<String> _normalizeChains(Iterable<String> chains) {
  final seen = <String>{};
  return [
    for (final id in chains.map((id) => id.trim()))
      if (id.isNotEmpty && seen.add(id)) id,
  ];
}

List<String> _stringList(Object? value) => value is List
    ? _normalizeChains(value.whereType<String>())
    : const <String>[];

List<ZuniaAccount> _wireAccounts(Object? value) {
  if (value is! List) {
    throw const ZuniaConnectException(
        ZuniaErrorCode.internal, 'The wallet sent malformed accounts');
  }
  return [for (final item in value) ZuniaAccount.fromWire(item)];
}

Map<Object?, Object?> _map(Object? value) =>
    value is Map ? value : const <Object?, Object?>{};

WebSocketChannel _defaultSocket(Uri url, List<String> protocols) =>
    WebSocketChannel.connect(url, protocols: protocols);

/// Pairs your app with Zunia mobile through the Zunia relay
/// (zunia.connect.v2) and asks it for signatures.
///
/// The relay only forwards sealed frames: the phone and your app agree on
/// keys the relay never sees, and the person compares a 6-digit code on both
/// screens. Pair by QR code ([pairing]) from a tablet, a desktop or the web,
/// or open Zunia on the same phone ([openZunia]).
///
/// ```dart
/// final zunia = ZuniaConnectClient(
///   metadata: const ZuniaDappMetadata(name: 'My app', url: 'https://myapp.example'),
///   storage: SecureSessionStorage(const FlutterSecureStorage()),
///   returnUrl: 'myapp://zunia',
/// );
/// if (!await zunia.restore()) {
///   await zunia.connect(chains: ['cosmoshub-4'], openZunia: true);
/// }
/// final account = zunia.accounts.first;
/// final signed = await zunia.signDirect('cosmoshub-4', account.address, signDoc);
/// ```
class ZuniaConnectClient with ChangeNotifier {
  /// Creates a client. Nothing touches the network until [connect] or
  /// [restore].
  ZuniaConnectClient({
    required this.metadata,
    String apiBase = ZuniaNativeConnect.defaultApiBase,
    String? wsBase,
    ZuniaSessionStorage? storage,
    this.storageKey = _defaultStorageKey,
    this.returnUrl,
    this.openWallet = ZuniaOpenWallet.auto,
    this.requestTimeout = const Duration(minutes: 5),
    this.heartbeat = const Duration(seconds: 20),
    this.deadAfter = const Duration(seconds: 45),
    this.reconnectMin = const Duration(seconds: 1),
    this.reconnectMax = const Duration(seconds: 30),
    this.restoreWait = const Duration(seconds: 5),
    this.observeAppLifecycle = true,
    http.Client? httpClient,
    ZuniaSocketFactory? socketFactory,
    ZuniaLinkLauncher? launcher,
  })  : apiBase = _trimSlash(apiBase),
        wsBase = wsBase == null ? null : _trimSlash(wsBase),
        storage = storage ?? MemorySessionStorage(),
        _http = httpClient ?? http.Client(),
        _ownsHttp = httpClient == null,
        _socketFactory = socketFactory ?? _defaultSocket,
        _launch = launcher ?? launchExternal {
    final ret = returnUrl;
    if (ret != null && !isAllowedReturnUrl(ret)) {
      throw ZuniaConnectException(ZuniaErrorCode.invalidParams,
          'returnUrl must be an https URL or your own app scheme, at most 512 characters');
    }
  }

  /// Who is asking, as Zunia shows it.
  final ZuniaDappMetadata metadata;

  /// Relay HTTP base. Defaults to the public Zunia relay.
  final String apiBase;

  /// Relay WebSocket base, when it differs from what the relay announces.
  final String? wsBase;

  /// Where the session survives a restart. In memory by default.
  final ZuniaSessionStorage storage;

  /// The key the session is saved under. Use one per client.
  final String storageKey;

  /// Where Zunia returns after the person answers, when your app opened it
  /// on the same phone: your app's own scheme (`myapp://zunia`) or an https
  /// link your app handles. On the web it defaults to the current page.
  final String? returnUrl;

  /// Whether signature requests open Zunia on the same phone.
  final ZuniaOpenWallet openWallet;

  /// How long each request waits for an answer.
  final Duration requestTimeout;

  /// Ping interval.
  final Duration heartbeat;

  /// Silence after which the link counts as dead and is reopened.
  final Duration deadAfter;

  /// First reconnect delay, doubling up to [reconnectMax].
  final Duration reconnectMin;

  /// Longest reconnect delay.
  final Duration reconnectMax;

  /// How long [restore] waits for the relay before answering.
  final Duration restoreWait;

  /// Reconnect at once when the app returns to the foreground.
  final bool observeAppLifecycle;

  final http.Client _http;
  final bool _ownsHttp;
  final ZuniaSocketFactory _socketFactory;
  final ZuniaLinkLauncher _launch;
  final Random _random = Random();

  final _statusController = StreamController<ZuniaSessionStatus>.broadcast();
  final _accountsController = StreamController<List<ZuniaAccount>>.broadcast();
  final _chainsController = StreamController<List<String>>.broadcast();
  final _pairingController = StreamController<ZuniaPairing>.broadcast();
  final _verificationController = StreamController<String>.broadcast();
  final _disconnectController = StreamController<String>.broadcast();
  final _errorController = StreamController<ZuniaConnectException>.broadcast();

  _Phase _phase = _Phase.idle;
  ZuniaSessionStatus _status = ZuniaSessionStatus.idle;
  _RelaySession? _session;
  ConnectKeyPair? _keyPair;
  String? _walletPublicKey;
  ConnectSessionKeys? _keys;
  ConnectCipher? _cipher;
  List<ZuniaAccount> _accounts = const [];
  List<String> _chains = const [];
  _Attempt? _attempt;
  Completer<bool>? _restoreWaiter;
  Timer? _restoreTimer;
  final Map<String, _Pending> _pending = {};
  List<_Unacked> _unacked = [];
  final List<_Probe> _probes = [];
  int _written = 0;
  int _confirmed = 0;
  WebSocketChannel? _socket;
  StreamSubscription<dynamic>? _socketSub;
  bool _socketOpen = false;
  bool _welcomed = false;
  bool _walletOnline = false;
  int _lastSeen = 0;
  int _retries = 0;
  Timer? _heartbeatTimer;
  Timer? _reconnectTimer;
  ZuniaPairing? _pairing;
  String? _code;
  Future<void> _frames = Future.value();
  Future<void> _saves = Future.value();
  _LifecycleObserver? _lifecycle;
  bool _disposed = false;

  /// Where the session stands. Listen to [statusChanges] or this notifier.
  ZuniaSessionStatus get status => _status;

  /// Accounts Zunia shared, on the approved chains.
  List<ZuniaAccount> get accounts => List.unmodifiable(_accounts);

  /// Chains Zunia approved.
  List<String> get chains => List.unmodifiable(_chains);

  /// What to show while a phone pairs: a QR code of [ZuniaPairing.uri].
  ZuniaPairing? get pairing => _pairing;

  /// The 6-digit code Zunia shows too, once it has scanned.
  String? get verificationCode => _code;

  /// The web origin the relay saw when the session was created. Null for
  /// native apps, which send none.
  String? get verifiedOrigin => _session?.verifiedOrigin;

  /// The relay session id, while there is a session.
  String? get sessionId => _session?.sessionId;

  /// Whether Zunia is connected to the relay right now.
  bool get walletOnline => _walletOnline;

  /// Whether a paired session is up (it may be reconnecting).
  bool get isConnected => _phase == _Phase.active;

  /// Status changes.
  Stream<ZuniaSessionStatus> get statusChanges => _statusController.stream;

  /// The shared accounts, whenever they change.
  Stream<List<ZuniaAccount>> get accountsChanges => _accountsController.stream;

  /// The approved chains, whenever they change.
  Stream<List<String>> get chainsChanges => _chainsController.stream;

  /// A new pairing link to show.
  Stream<ZuniaPairing> get pairings => _pairingController.stream;

  /// The verification code, once the phone has scanned.
  Stream<String> get verificationCodes => _verificationController.stream;

  /// A paired session ended, with the reason (`user`, `closed`, `expired`, `revoked`, …).
  Stream<String> get disconnects => _disconnectController.stream;

  /// Errors that did not fail a request, such as a frame the relay refused.
  Stream<ZuniaConnectException> get errors => _errorController.stream;

  bool get _onPhone =>
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;

  int _now() => DateTime.now().millisecondsSinceEpoch;

  /// Creates a session on the relay and waits until Zunia approves it.
  ///
  /// Show [pairing] as a QR code (or use `ZuniaPairingView`) for a phone to
  /// scan. With [openZunia], Zunia opens on this device straight away and
  /// returns to [returnUrl] when the person answers; when Zunia is not
  /// installed this throws `NOT_INSTALLED`.
  ///
  /// Throws `USER_REJECTED`, `TIMEOUT`, `UNKNOWN_CHAIN`, `PAIRING_FAILED` or
  /// `NETWORK`.
  Future<void> connect({
    required List<String> chains,
    Duration timeout = const Duration(minutes: 5),
    bool openZunia = false,
  }) async {
    _checkAlive();
    final wanted = _normalizeChains(chains);
    if (wanted.isEmpty) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.invalidParams, 'Pass at least one chain id');
    }
    if (_phase == _Phase.pairing || _phase == _Phase.active) {
      await _disconnect('replaced');
    }

    _phase = _Phase.idle;
    _setStatus(ZuniaSessionStatus.connecting);
    final Map<String, Object?> created;
    try {
      created = await _createSession();
    } catch (error) {
      _setStatus(ZuniaSessionStatus.disconnected);
      rethrow;
    }

    final announced = created['wsUrl']! as String;
    final relayBase = wsBase ??
        (announced.endsWith(ZuniaNativeConnect.wsPath)
            ? announced.substring(
                0, announced.length - ZuniaNativeConnect.wsPath.length)
            : _trimSlash(announced));
    final session = _RelaySession(
      apiBase: apiBase,
      wsUrl: '$relayBase${ZuniaNativeConnect.wsPath}',
      sessionId: created['sessionId']! as String,
      dappToken: created['dappToken']! as String,
      expiresAt: (created['expiresAt']! as num).toInt(),
      verifiedOrigin: created['verifiedOrigin'] as String?,
    );
    _session = session;
    final keyPair = await ConnectKeyPair.generate();
    _keyPair = keyPair;
    _phase = _Phase.pairing;
    _retries = 0;
    final pairing = ZuniaPairing(
      params: ZuniaPairingUri(
        sessionId: session.sessionId,
        joinToken: created['walletJoinToken']! as String,
        dappPublicKey: bytesToBase64Url(keyPair.publicKey),
        relay: relayBase,
      ),
      expiresAt: DateTime.fromMillisecondsSinceEpoch(session.expiresAt),
    );
    _pairing = pairing;

    final attempt = _Attempt(createNonce(), wanted, Completer<void>());
    // Errors reach the caller through the returned future, never as unhandled.
    attempt.completer.future.ignore();
    _attempt = attempt;
    final left = session.expiresAt - _now();
    final wait =
        Duration(milliseconds: max(0, min(timeout.inMilliseconds, left)));
    attempt.timer = Timer(wait, () {
      unawaited(_disconnect('timeout',
          error: const ZuniaConnectException(
              ZuniaErrorCode.timeout, 'Nobody approved the pairing in time')));
    });
    _watchLifecycle(true);
    _pairingController.add(pairing);
    _setStatus(ZuniaSessionStatus.awaitingWallet);
    _open();
    if (openZunia && !await this.openZunia()) {
      await _disconnect('not_installed',
          error: const ZuniaConnectException(ZuniaErrorCode.notInstalled,
              'Zunia is not installed on this device'));
    }
    return attempt.completer.future;
  }

  /// Opens Zunia on this device.
  ///
  /// While pairing, it opens the pairing link, carrying [returnUrl] so Zunia
  /// comes back to your app after the person answers; later signature
  /// requests then open Zunia by themselves (see [openWallet]). Once paired,
  /// it brings the session to the front of Zunia. Returns false when Zunia
  /// could not be opened, typically because it is not installed.
  Future<bool> openZunia() async {
    final session = _session;
    final pairing = _pairing;
    if (_phase == _Phase.pairing && pairing != null && session != null) {
      final opened =
          await _launch(pairing.deepLink(returnUrl: _returnTarget()));
      if (opened) session.sameDevice = true;
      return opened;
    }
    if (_phase == _Phase.active && session != null) {
      return _launch(buildWakeLink(session.sessionId));
    }
    return false;
  }

  String? _returnTarget() {
    final explicit = returnUrl;
    if (explicit != null) return explicit;
    if (!kIsWeb) return null;
    final page = Uri.base.toString();
    return isAllowedReturnUrl(page) ? page : null;
  }

  /// Reattaches to the saved session without asking the person anything.
  ///
  /// Answers false when there is none, it expired, or it covers none of
  /// [chains]. Otherwise answers true once the relay welcomed it, or after
  /// [restoreWait] if the relay is slow (the client keeps retrying).
  Future<bool> restore({List<String>? chains}) async {
    _checkAlive();
    if (_phase == _Phase.pairing || _phase == _Phase.active) {
      return _phase == _Phase.active;
    }
    final raw = await storage.read(storageKey);
    final stored = _parseStored(raw);
    if (stored == null) {
      if (raw != null) await storage.delete(storageKey);
      return false;
    }
    if ((stored['expiresAt']! as num).toInt() <= _now()) {
      await storage.delete(storageKey);
      return false;
    }
    if (_trimSlash(stored['apiBase']! as String) != apiBase) return false;
    final storedChains = _stringList(stored['chains']);
    if (chains != null &&
        !_normalizeChains(chains).any(storedChains.contains)) {
      return false;
    }

    final List<ZuniaAccount> accounts;
    try {
      _keys = ConnectSessionKeys(
        dappToWallet: base64UrlToBytes(stored['dappToWallet']! as String),
        walletToDapp: base64UrlToBytes(stored['walletToDapp']! as String),
        verificationCode: stored['verificationCode']! as String,
      );
      _cipher = ConnectCipher(
        role: ConnectRole.dapp,
        sessionId: stored['sessionId']! as String,
        dappToWallet: _keys!.dappToWallet,
        walletToDapp: _keys!.walletToDapp,
        sendSeq: (stored['sendSeq']! as num).toInt(),
        receiveSeq: (stored['receiveSeq']! as num).toInt(),
      );
      accounts = _wireAccounts(stored['accounts']);
    } catch (_) {
      _keys = null;
      _cipher = null;
      await storage.delete(storageKey);
      return false;
    }

    _session = _RelaySession(
      apiBase: apiBase,
      wsUrl: stored['wsUrl']! as String,
      sessionId: stored['sessionId']! as String,
      dappToken: stored['dappToken']! as String,
      expiresAt: (stored['expiresAt']! as num).toInt(),
      verifiedOrigin: stored['verifiedOrigin'] as String?,
      sameDevice: stored['sameDevice'] == true,
    );
    _accounts = accounts;
    _chains = storedChains;
    _code = stored['verificationCode']! as String;
    _phase = _Phase.active;
    _retries = 0;
    _watchLifecycle(true);
    _setStatus(ZuniaSessionStatus.reconnecting);
    _accountsController.add(accounts);
    _chainsController.add(storedChains);

    final waiter = Completer<bool>();
    _restoreWaiter = waiter;
    _restoreTimer = Timer(restoreWait, () {
      if (_restoreWaiter == waiter) _restoreWaiter = null;
      if (!waiter.isCompleted) waiter.complete(true);
    });
    _open();
    final ok = await waiter.future;
    if (ok && _phase == _Phase.active) unawaited(_refreshQuietly());
    return ok;
  }

  /// Ends the session for both sides and forgets it. Pending requests fail
  /// with `DISCONNECTED`.
  Future<void> disconnect([String reason = 'user']) => _disconnect(reason);

  Future<void> _disconnect(String reason,
      {ZuniaConnectException? error}) async {
    if (_phase != _Phase.pairing && _phase != _Phase.active) return;
    final session = _session;
    var told = false;
    if (_socket != null && _socketOpen) {
      try {
        final text = reason.length > 64 ? reason.substring(0, 64) : reason;
        _socket!.sink.add(jsonEncode({'t': 'close', 'reason': text}));
        told = true;
      } catch (_) {
        told = false;
      }
    }
    _terminate(
        reason,
        error ??
            const ZuniaConnectException(
                ZuniaErrorCode.disconnected, 'The session was closed'));
    if (!told && session != null) {
      try {
        await _http.delete(
          Uri.parse(
              '${session.apiBase}${ZuniaNativeConnect.httpPath}/${session.sessionId}'),
          headers: {'authorization': 'Bearer ${session.dappToken}'},
        );
      } catch (_) {
        // The relay forgets the session when it expires anyway.
      }
    }
  }

  /// Reconnects at once if the link to the relay is down or quiet. Called by
  /// itself when the app returns to the foreground.
  void resume() {
    if (_disposed || (_phase != _Phase.pairing && _phase != _Phase.active)) {
      return;
    }
    if (!_ready() || _now() - _lastSeen > heartbeat.inMilliseconds) {
      _retries = 0;
      _open();
    }
  }

  /// A Keplr-style key for [chainId], from the shared accounts.
  ZuniaKey getKey(String chainId) {
    final account = _accountFor(chainId);
    return ZuniaKey(
      name: account.name ?? ZuniaConstants.walletName,
      algo: account.algo,
      pubKey: account.pubKey,
      bech32Address: account.address,
    );
  }

  ZuniaAccount _accountFor(String chainId) {
    for (final account in _accounts) {
      if (account.chainId == chainId) return account;
    }
    throw ZuniaConnectException(
        ZuniaErrorCode.notConnected, 'No account is shared for $chainId');
  }

  /// Asks Zunia for the accounts again.
  Future<List<ZuniaAccount>> refreshAccounts() async {
    final raw = await _request('get_accounts', {'chainIds': chains},
        timeout: _refreshTimeout);
    if (_phase != _Phase.active) return accounts;
    _accounts = _wireAccounts(raw)
        .where((account) => _chains.contains(account.chainId))
        .toList();
    unawaited(_persist());
    _accountsController.add(accounts);
    _changed();
    return accounts;
  }

  Future<void> _refreshQuietly() async {
    try {
      await refreshAccounts();
    } catch (_) {
      // The phone may be asleep; accounts_changed will catch up.
    }
  }

  /// Signs a protobuf sign doc (SIGN_MODE_DIRECT).
  Future<ZuniaDirectSignResponse> signDirect(
      String chainId, String signer, ZuniaSignDoc signDoc) async {
    final raw = await _request('sign_direct',
        {'chainId': chainId, 'signer': signer, 'signDoc': signDoc.toWire()},
        wake: true);
    final value = _map(raw);
    final signed = _map(value['signed']);
    Uint8List bytesOr(Object? field, Uint8List fallback) =>
        field is String ? base64ToBytes(field) : fallback;
    final accountNumber = signed['accountNumber'];
    return ZuniaDirectSignResponse(
      signed: ZuniaSignDoc(
        bodyBytes: bytesOr(signed['bodyBytes'], signDoc.bodyBytes),
        authInfoBytes: bytesOr(signed['authInfoBytes'], signDoc.authInfoBytes),
        chainId: signed['chainId'] is String
            ? signed['chainId'] as String
            : signDoc.chainId,
        accountNumber: accountNumber is String || accountNumber is num
            ? BigInt.parse(accountNumber.toString())
            : signDoc.accountNumber,
      ),
      signature: ZuniaStdSignature.fromJson(value['signature']),
    );
  }

  /// Signs an Amino `StdSignDoc` (JSON, as CosmJS builds it).
  ///
  /// Zunia may change the fee: broadcast [ZuniaAminoSignResponse.signed].
  Future<ZuniaAminoSignResponse> signAmino(
      String chainId, String signer, Map<String, Object?> signDoc) async {
    final raw = await _request('sign_amino',
        {'chainId': chainId, 'signer': signer, 'signDoc': signDoc},
        wake: true);
    final value = _map(raw);
    final signed = value['signed'];
    return ZuniaAminoSignResponse(
      signed: signed is Map ? Map<String, Object?>.from(signed) : signDoc,
      signature: ZuniaStdSignature.fromJson(value['signature']),
    );
  }

  /// Signs [text] with ADR-036 (the `signArbitrary` of Keplr).
  Future<ZuniaStdSignature> signArbitrary(
      String chainId, String signer, String text) async {
    final raw = await _request(
        'sign_arbitrary',
        {
          'chainId': chainId,
          'signer': signer,
          'data': text,
          'encoding': 'utf8'
        },
        wake: true);
    return ZuniaStdSignature.fromJson(raw);
  }

  /// Signs [bytes] with ADR-036.
  Future<ZuniaStdSignature> signArbitraryBytes(
      String chainId, String signer, List<int> bytes) async {
    final raw = await _request(
        'sign_arbitrary',
        {
          'chainId': chainId,
          'signer': signer,
          'data': bytesToBase64(bytes),
          'encoding': 'base64',
        },
        wake: true);
    return ZuniaStdSignature.fromJson(raw);
  }

  /// Asks Zunia to sign a "Sign in with Zunia" message for your site. Send
  /// the result to your server and verify it there (`verifySignIn` in
  /// `@zunialab/sdk-core`).
  ///
  /// Zunia signs in only sites whose web origin the relay verified, so this
  /// works from Flutter web. A native app has no origin: this throws
  /// `ORIGIN_MISMATCH` before asking the phone. Sign your own challenge with
  /// [signArbitrary] there instead.
  Future<ZuniaSignInResult> signIn({
    required String nonce,
    String? chainId,
    String? statement,
    DateTime? expirationTime,
    DateTime? notBefore,
    String? requestId,
    List<String>? resources,
  }) async {
    final chain = chainId ?? (_chains.isEmpty ? null : _chains.first);
    if (chain == null || _phase != _Phase.active) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.notConnected, 'Connect a wallet before signing in');
    }
    final account = _accountFor(chain);
    final origin = verifiedOrigin;
    if (origin == null) {
      throw const ZuniaConnectException(ZuniaErrorCode.originMismatch,
          'Zunia signs in only sites whose web origin the relay verified, and this app sent none');
    }
    final issuedAt = DateTime.now();
    final message = buildSignInMessage(SignInMessage(
      domain: Uri.parse(origin).authority,
      address: account.address,
      statement: statement,
      uri: origin,
      chainId: chain,
      nonce: nonce,
      issuedAt: toIsoString(issuedAt),
      expirationTime: toIsoString(expirationTime ?? issuedAt.add(_signInTtl)),
      notBefore: notBefore == null ? null : toIsoString(notBefore),
      requestId: requestId,
      resources: resources,
    ));
    final signature = await signArbitrary(chain, account.address, message);
    return ZuniaSignInResult(
      message: message,
      signature: signature,
      address: account.address,
      chainId: chain,
      pubKey: account.pubKey,
    );
  }

  /// Stops this client without ending the session: [restore] picks it up
  /// later. Pending requests fail with `DISCONNECTED`.
  @override
  void dispose() {
    if (_disposed) return;
    _terminate(
        'disposed',
        const ZuniaConnectException(
            ZuniaErrorCode.disconnected, 'The client was disposed'),
        keepStorage: true);
    _disposed = true;
    _watchLifecycle(false);
    for (final controller in <StreamController<Object?>>[
      _statusController,
      _accountsController,
      _chainsController,
      _pairingController,
      _verificationController,
      _disconnectController,
      _errorController,
    ]) {
      unawaited(controller.close());
    }
    if (_ownsHttp) _http.close();
    super.dispose();
  }

  void _checkAlive() {
    if (_disposed) {
      throw StateError('This ZuniaConnectClient was disposed');
    }
  }

  Future<Map<String, Object?>> _createSession() async {
    final http.Response response;
    try {
      response = await _http.post(
        Uri.parse('$apiBase${ZuniaNativeConnect.httpPath}'),
        headers: {'accept': 'application/json'},
      );
    } catch (error) {
      throw ZuniaConnectException(
          ZuniaErrorCode.network, 'Could not reach the Zunia relay',
          cause: error);
    }
    if (response.statusCode == 429) {
      final after = int.tryParse(response.headers['retry-after'] ?? '');
      final wait = after != null && after > 0 ? '$after seconds' : 'a moment';
      throw ZuniaConnectException(ZuniaErrorCode.network,
          'Too many pairing attempts. Try again in $wait.');
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw ZuniaConnectException(ZuniaErrorCode.network,
          'The Zunia relay answered ${response.statusCode}');
    }
    Object? body;
    try {
      body = jsonDecode(response.body);
    } catch (_) {
      body = null;
    }
    if (body is! Map<String, Object?> || !_isCreateResponse(body)) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.network, 'The Zunia relay sent an unexpected answer');
    }
    return body;
  }

  static bool _isCreateResponse(Map<String, Object?> body) {
    final sessionId = body['sessionId'];
    final dappToken = body['dappToken'];
    final join = body['walletJoinToken'];
    final wsUrl = body['wsUrl'];
    final origin = body['verifiedOrigin'];
    return body['v'] == ZuniaNativeConnect.protocolVersion &&
        sessionId is String &&
        _sessionIdPattern.hasMatch(sessionId) &&
        dappToken is String &&
        _tokenPattern.hasMatch(dappToken) &&
        join is String &&
        _tokenPattern.hasMatch(join) &&
        body['expiresAt'] is num &&
        wsUrl is String &&
        RegExp(r'^wss?://').hasMatch(wsUrl) &&
        (origin == null || origin is String);
  }

  Map<String, Object?>? _parseStored(String? raw) {
    if (raw == null) return null;
    Object? value;
    try {
      value = jsonDecode(raw);
    } catch (_) {
      return null;
    }
    if (value is! Map<String, Object?> || value['v'] != 2) return null;
    final record = value;
    const strings = [
      'apiBase',
      'wsUrl',
      'sessionId',
      'dappToken',
      'dappToWallet',
      'walletToDapp',
      'verificationCode',
    ];
    if (strings.any((key) => record[key] is! String)) return null;
    if (value['expiresAt'] is! num ||
        value['sendSeq'] is! num ||
        value['receiveSeq'] is! num) {
      return null;
    }
    if (value['accounts'] is! List || value['chains'] is! List) return null;
    return value;
  }

  Future<Object?> _request(String type, Map<String, Object?> payload,
      {Duration? timeout, bool wake = false}) async {
    if (_phase != _Phase.active || _cipher == null) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.notConnected, 'Pair a wallet first');
    }
    final id = createNonce();
    final completer = Completer<Object?>();
    // Errors reach the caller through the returned future, never as unhandled.
    completer.future.ignore();
    final timer = Timer(timeout ?? requestTimeout, () {
      _pending.remove(id);
      _settle(id);
      if (!completer.isCompleted) {
        completer.completeError(const ZuniaConnectException(
            ZuniaErrorCode.timeout, 'The wallet did not answer in time'));
      }
    });
    _pending[id] = _Pending(completer, timer);
    try {
      await _sendSealed(type, id, payload);
    } catch (error) {
      timer.cancel();
      _pending.remove(id);
      throw toZuniaConnectException(error);
    }
    if (wake) _wake();
    return completer.future;
  }

  void _wake() {
    final session = _session;
    if (openWallet != ZuniaOpenWallet.auto ||
        session == null ||
        !session.sameDevice ||
        !_onPhone) {
      return;
    }
    unawaited(_launch(buildWakeLink(session.sessionId)));
  }

  Future<void> _sendSealed(String type, String id, Object? payload) async {
    final cipher = _cipher;
    if (cipher == null) {
      throw const ZuniaConnectException(
          ZuniaErrorCode.notConnected, 'Pair a wallet first');
    }
    if (_unacked.length >= _unackedLimit) {
      throw const ZuniaConnectException(ZuniaErrorCode.network,
          'Too many requests are waiting for the wallet');
    }
    final frame = cipher.seal(type: type, id: id, payload: payload);
    final data = jsonEncode({'t': 'msg', 'n': frame.n, 'c': frame.c});
    // Sealed frames are ASCII, so length is the byte count the relay checks.
    if (data.length > ZuniaNativeConnect.maxFrameBytes) {
      throw ZuniaConnectException(ZuniaErrorCode.invalidParams,
          'The request is ${data.length} bytes once sealed; the relay accepts ${ZuniaNativeConnect.maxFrameBytes}',
          reason: ZuniaErrorReason.tooLarge);
    }
    final entry = _Unacked(id, data);
    _unacked.add(entry);
    // Saved before the frame leaves, so a restart never reuses a sequence number.
    await _persist();
    if (!_unacked.contains(entry)) return;
    entry.ready = true;
    if (_ready() && entry.sent == null) {
      entry.sent = _write(data);
      _ping(id);
    }
  }

  bool _ready() => _socket != null && _socketOpen && _welcomed;

  int _write(String data) {
    _socket!.sink.add(data);
    _written += 1;
    return _written;
  }

  void _ping([String? id]) {
    if (!_ready()) return;
    _write(jsonEncode({'t': 'ping'}));
    _probes.add(_Probe(_written, id));
  }

  void _settle(String id) {
    _unacked = _unacked.where((entry) => entry.id != id).toList();
  }

  void _open() {
    final session = _session;
    if (_disposed ||
        session == null ||
        (_phase != _Phase.pairing && _phase != _Phase.active)) {
      return;
    }
    _clearReconnect();
    _dropSocket();
    final url = Uri.parse(
        '${session.wsUrl}?sid=${Uri.encodeQueryComponent(session.sessionId)}&role=dapp');
    final WebSocketChannel socket;
    try {
      socket = _socketFactory(url, [
        ZuniaNativeConnect.protocolVersion,
        '${ZuniaNativeConnect.tokenProtocolPrefix}${session.dappToken}',
      ]);
    } catch (_) {
      _scheduleReconnect(false);
      return;
    }
    _socket = socket;
    _socketOpen = false;
    _welcomed = false;
    socket.ready.then((_) {
      if (_socket != socket) return;
      _socketOpen = true;
      _lastSeen = _now();
      _startHeartbeat();
    }, onError: (Object _) {
      // The stream closes next, with the code.
    });
    _socketSub = socket.stream.listen(
      (Object? data) {
        if (_socket != socket) return;
        _socketOpen = true;
        _lastSeen = _now();
        if (data is String) _enqueueFrame(data);
      },
      onError: (Object _) {
        // onDone follows with the close code.
      },
      onDone: () {
        if (_socket != socket) return;
        _socket = null;
        _socketSub = null;
        _socketOpen = false;
        _onClose(socket.closeCode ?? 1006);
      },
    );
  }

  void _dropSocket() {
    final socket = _socket;
    final sub = _socketSub;
    _socket = null;
    _socketSub = null;
    _socketOpen = false;
    _welcomed = false;
    _probes.clear();
    _stopHeartbeat();
    if (sub != null) unawaited(sub.cancel());
    if (socket != null) {
      unawaited(socket.sink.close(1000).catchError((Object _) => null));
    }
  }

  void _enqueueFrame(String raw) {
    _frames = _frames.then((_) => _onFrame(raw)).catchError((Object error) {
      _emitError(toZuniaConnectException(error));
    });
  }

  Future<void> _onFrame(String raw) async {
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map<String, Object?>) return;
    final frame = decoded;
    switch (frame['t']) {
      case 'welcome':
        _onWelcome(frame);
      case 'hello':
        final pk = frame['pk'];
        if (pk is String) await _onHello(pk);
      case 'msg':
        await _onSealed(frame);
      case 'paired':
        final expiresAt = frame['expiresAt'];
        final session = _session;
        if (session != null && expiresAt is num) {
          session.expiresAt = expiresAt.toInt();
          unawaited(_persist());
        }
      case 'peer':
        _walletOnline = frame['online'] == true;
        _changed();
      case 'pong':
        if (_probes.isNotEmpty) _confirmed = _probes.removeAt(0).mark;
      case 'closed':
        final reason =
            frame['reason'] is String ? frame['reason'] as String : 'closed';
        _terminate(
          reason,
          reason == 'expired'
              ? const ZuniaConnectException(
                  ZuniaErrorCode.sessionExpired, 'The session expired')
              : const ZuniaConnectException(
                  ZuniaErrorCode.disconnected, 'Zunia ended the session'),
        );
      case 'error':
        if (frame['code'] == 'QUEUE_FULL') {
          await _onQueueFull();
        } else {
          final message = '${frame['message']}';
          _emitError(ZuniaConnectException(ZuniaErrorCode.network,
              'The relay refused a frame: ${message.length > 200 ? message.substring(0, 200) : message}'));
        }
      default:
        return;
    }
  }

  void _onWelcome(Map<String, Object?> frame) {
    final session = _session;
    if (session == null) return;
    _welcomed = true;
    _socketOpen = true;
    _retries = 0;
    final expiresAt = frame['expiresAt'];
    if (expiresAt is num) session.expiresAt = expiresAt.toInt();
    final origin = frame['verifiedOrigin'];
    session.verifiedOrigin = origin is String ? origin : null;
    _walletOnline = frame['peer'] == true;
    // Frames the relay never confirmed may have died with the old socket. The
    // wallet drops any it already has, since their sequence numbers are old.
    for (final entry in _unacked) {
      if (entry.ready && (entry.sent == null || entry.sent! > _confirmed)) {
        entry.sent = _write(entry.data);
        _ping(entry.id);
      }
    }
    if (_probes.isEmpty) _ping();
    if (_phase == _Phase.active) {
      unawaited(_persist());
      _setStatus(ZuniaSessionStatus.connected);
      final waiter = _restoreWaiter;
      _restoreWaiter = null;
      _restoreTimer?.cancel();
      if (waiter != null && !waiter.isCompleted) waiter.complete(true);
    }
    _changed();
  }

  Future<void> _onHello(String pk) async {
    final attempt = _attempt;
    final session = _session;
    final keyPair = _keyPair;
    if (_phase != _Phase.pairing ||
        attempt == null ||
        session == null ||
        keyPair == null) {
      return;
    }
    // The same wallet saying hello again after a reconnect: keep the keys and the request.
    if (_cipher != null && pk == _walletPublicKey) return;
    final ConnectSessionKeys keys;
    try {
      keys = await deriveConnectKeys(
        role: ConnectRole.dapp,
        sessionId: session.sessionId,
        own: keyPair,
        peerPublicKey: base64UrlToBytes(pk),
      );
    } catch (error) {
      await _disconnect('pairing_failed',
          error: toZuniaConnectException(error,
              fallback: ZuniaErrorCode.pairingFailed));
      return;
    }
    if (_attempt != attempt) return;
    _keys = keys;
    _cipher = ConnectCipher(
      role: ConnectRole.dapp,
      sessionId: session.sessionId,
      dappToWallet: keys.dappToWallet,
      walletToDapp: keys.walletToDapp,
    );
    _walletPublicKey = pk;
    _code = keys.verificationCode;
    _verificationController.add(keys.verificationCode);
    _changed();
    _settle(attempt.requestId);
    try {
      await _sendSealed('connect_request', attempt.requestId, {
        'metadata': metadata.toJson(),
        'chains': attempt.chains,
        'methods': ZuniaNativeConnect.defaultMethods,
        'events': ZuniaNativeConnect.defaultEvents,
      });
    } catch (error) {
      await _disconnect('pairing_failed',
          error: toZuniaConnectException(error,
              fallback: ZuniaErrorCode.pairingFailed));
    }
  }

  Future<void> _onSealed(Map<String, Object?> frame) async {
    final cipher = _cipher;
    final n = frame['n'];
    final c = frame['c'];
    if (cipher == null || n is! String || c is! String) return;
    final ConnectEnvelope? envelope;
    try {
      envelope = cipher.openFresh(SealedFrame(n: n, c: c));
    } catch (error) {
      // Dropped, not fatal: only the relay could send it, and it can drop frames anyway.
      _emitError(toZuniaConnectException(error,
          fallback: ZuniaErrorCode.pairingFailed));
      return;
    }
    // A frame the wallet resent after a reconnect, already handled.
    if (envelope == null) return;
    unawaited(_persist());
    try {
      await _onMessage(envelope);
    } catch (error) {
      _emitError(toZuniaConnectException(error));
    }
  }

  Future<void> _onMessage(ConnectEnvelope message) async {
    final payload = _map(message.payload);
    switch (message.type) {
      case 'connect_approve':
        final attempt = _attempt;
        if (_phase != _Phase.pairing ||
            attempt == null ||
            message.id != attempt.requestId) {
          return;
        }
        final approved = _stringList(payload['chains'])
            .where(attempt.chains.contains)
            .toList();
        if (approved.isEmpty) {
          await _disconnect('rejected',
              error: const ZuniaConnectException(ZuniaErrorCode.unknownChain,
                  'Zunia approved none of the requested chains'));
          return;
        }
        final List<ZuniaAccount> accounts;
        try {
          accounts = _wireAccounts(payload['accounts'])
              .where((account) => approved.contains(account.chainId))
              .toList();
        } catch (error) {
          await _disconnect('pairing_failed',
              error: toZuniaConnectException(error,
                  fallback: ZuniaErrorCode.pairingFailed));
          return;
        }
        _attempt = null;
        attempt.timer?.cancel();
        _settle(attempt.requestId);
        _accounts = accounts;
        _chains = approved;
        _phase = _Phase.active;
        _keyPair = null;
        _pairing = null;
        await _persist();
        _accountsController.add(this.accounts);
        _chainsController.add(chains);
        _setStatus(ZuniaSessionStatus.connected);
        if (!attempt.completer.isCompleted) attempt.completer.complete();
      case 'connect_reject':
        if (_phase != _Phase.pairing || message.id != _attempt?.requestId) {
          return;
        }
        await _disconnect('rejected',
            error: walletErrorFrom(payload, ZuniaErrorCode.userRejected,
                'Zunia declined the connection'));
      case 'result':
      case 'error':
        final id = message.id;
        final pending = id == null ? null : _pending.remove(id);
        if (id == null || pending == null) return;
        _settle(id);
        pending.timer.cancel();
        if (pending.completer.isCompleted) return;
        if (message.type == 'result') {
          pending.completer.complete(message.payload);
        } else {
          pending.completer.completeError(walletErrorFrom(
              payload, ZuniaErrorCode.internal, 'Zunia returned an error'));
        }
      case 'accounts_changed':
        if (_phase != _Phase.active) return;
        _accounts = _wireAccounts(payload['accounts'])
            .where((account) => _chains.contains(account.chainId))
            .toList();
        unawaited(_persist());
        _accountsController.add(accounts);
        _changed();
      case 'chains_changed':
        if (_phase != _Phase.active) return;
        final next = _stringList(payload['chains']);
        if (next.isEmpty) {
          await _disconnect('revoked');
          return;
        }
        _chains = next;
        _accounts = _accounts
            .where((account) => next.contains(account.chainId))
            .toList();
        unawaited(_persist());
        _chainsController.add(chains);
        _accountsController.add(accounts);
        _changed();
      default:
        return;
    }
  }

  /// The relay held the frame for an offline Zunia and its queue is full.
  /// Fail the request it carried now instead of letting it time out.
  Future<void> _onQueueFull() async {
    final id = _probes.isEmpty ? null : _probes.first.id;
    const error = ZuniaConnectException(ZuniaErrorCode.network,
        'Zunia is offline and the relay cannot hold more requests for it',
        reason: ZuniaErrorReason.queueFull);
    if (id == null) {
      _emitError(error);
      return;
    }
    _settle(id);
    final pending = _pending.remove(id);
    if (pending != null) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(error);
      }
      return;
    }
    if (_attempt?.requestId == id) {
      await _disconnect('queue_full', error: error);
    }
  }

  void _onClose(int code) {
    _welcomed = false;
    _stopHeartbeat();
    _probes.clear();
    if (_phase != _Phase.pairing && _phase != _Phase.active) return;
    if (code == ZuniaNativeConnect.closeUnauthorized) {
      return _terminate(
          'expired',
          const ZuniaConnectException(ZuniaErrorCode.sessionExpired,
              'The relay no longer knows this session'));
    }
    if (code == ZuniaNativeConnect.closeEnded) {
      return _terminate(
          'closed',
          const ZuniaConnectException(
              ZuniaErrorCode.disconnected, 'The session ended'));
    }
    if (code == ZuniaNativeConnect.closeReplaced) {
      // Another client resumed this session; it owns the saved copy now.
      return _terminate(
          'replaced',
          const ZuniaConnectException(ZuniaErrorCode.disconnected,
              'The session moved to another client'),
          keepStorage: true);
    }
    final session = _session;
    if (session != null && session.expiresAt <= _now()) {
      return _terminate(
          'expired',
          const ZuniaConnectException(
              ZuniaErrorCode.sessionExpired, 'The session expired'));
    }
    if (_phase == _Phase.active) _setStatus(ZuniaSessionStatus.reconnecting);
    _scheduleReconnect(code == ZuniaNativeConnect.closeRateLimited);
  }

  void _scheduleReconnect(bool slow) {
    _clearReconnect();
    final ceiling = min(reconnectMax.inMilliseconds,
        reconnectMin.inMilliseconds * pow(2, min(_retries, 16)).toInt());
    _retries += 1;
    final delay = ceiling / 2 + _random.nextDouble() * (ceiling / 2);
    _reconnectTimer = Timer(
        Duration(milliseconds: (slow ? max(delay, 10000) : delay).round()),
        _open);
  }

  void _clearReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(heartbeat, (_) {
      if (_socket == null || !_socketOpen) return;
      if (_now() - _lastSeen > deadAfter.inMilliseconds) {
        _dropSocket();
        _onClose(1006);
        return;
      }
      if (_probes.isEmpty) _ping();
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _watchLifecycle(bool on) {
    if (!observeAppLifecycle) return;
    final WidgetsBinding binding;
    try {
      binding = WidgetsBinding.instance;
    } catch (_) {
      return;
    }
    if (on && _lifecycle == null) {
      _lifecycle = _LifecycleObserver(resume);
      binding.addObserver(_lifecycle!);
    } else if (!on && _lifecycle != null) {
      binding.removeObserver(_lifecycle!);
      _lifecycle = null;
    }
  }

  Map<String, Object?>? _record() {
    final session = _session;
    final keys = _keys;
    final cipher = _cipher;
    if (_phase != _Phase.active ||
        session == null ||
        keys == null ||
        cipher == null) {
      return null;
    }
    return {
      'v': 2,
      'apiBase': session.apiBase,
      'wsUrl': session.wsUrl,
      'sessionId': session.sessionId,
      'dappToken': session.dappToken,
      'expiresAt': session.expiresAt,
      'verifiedOrigin': session.verifiedOrigin,
      'sameDevice': session.sameDevice,
      'dappToWallet': bytesToBase64Url(keys.dappToWallet),
      'walletToDapp': bytesToBase64Url(keys.walletToDapp),
      'verificationCode': keys.verificationCode,
      'sendSeq': cipher.sendSeq,
      'receiveSeq': cipher.receiveSeq,
      'accounts': [for (final account in _accounts) account.toWire()],
      'chains': _chains,
    };
  }

  /// Saves the session. Writes run one after another, in call order, so the
  /// last one saved is always the latest state.
  Future<void> _persist() {
    final record = _record();
    if (record == null) return _saves;
    final text = jsonEncode(record);
    return _saves = _saves
        .then((_) => storage.write(storageKey, text))
        .catchError((Object error) {
      _emitError(ZuniaConnectException(
          ZuniaErrorCode.internal, 'Could not save the session',
          cause: error));
    });
  }

  void _forget() {
    _saves = _saves
        .then((_) => storage.delete(storageKey))
        .catchError((Object _) {});
  }

  void _terminate(String reason, ZuniaConnectException error,
      {bool keepStorage = false}) {
    if (_phase != _Phase.pairing && _phase != _Phase.active) return;
    final wasActive = _phase == _Phase.active;
    _phase = _Phase.ended;
    _clearReconnect();
    _dropSocket();
    _watchLifecycle(false);
    for (final pending in _pending.values) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(error);
      }
    }
    _pending.clear();
    _unacked = [];
    if (!keepStorage) _forget();
    _cipher = null;
    _keys = null;
    _keyPair = null;
    _walletPublicKey = null;
    _accounts = const [];
    _chains = const [];
    _pairing = null;
    _code = null;
    _walletOnline = false;

    final attempt = _attempt;
    _attempt = null;
    if (attempt != null) {
      attempt.timer?.cancel();
      if (!attempt.completer.isCompleted) {
        attempt.completer.completeError(error);
      }
    }
    final waiter = _restoreWaiter;
    _restoreWaiter = null;
    _restoreTimer?.cancel();
    if (waiter != null && !waiter.isCompleted) waiter.complete(false);
    _setStatus(ZuniaSessionStatus.disconnected);
    if (wasActive && !_disposed) _disconnectController.add(reason);
    _changed();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _emitError(ZuniaConnectException error) {
    if (!_disposed) _errorController.add(error);
  }

  void _setStatus(ZuniaSessionStatus status) {
    if (_status == status) return;
    _status = status;
    if (!_disposed) _statusController.add(status);
    _changed();
  }
}
