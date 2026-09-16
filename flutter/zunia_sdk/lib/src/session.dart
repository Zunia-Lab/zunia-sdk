import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'constants.dart';

/// Session lifecycle for [ZuniaSession] / native WebSocket connect.
enum ZuniaSessionStatus {
  idle,
  connecting,
  awaitingWallet,
  connected,
  signing,
  disconnected,
  error,
}

/// dApp metadata sent during native connect pairing.
class ZuniaDappMetadata {
  const ZuniaDappMetadata({
    required this.name,
    required this.url,
    this.description,
    this.icons = const [],
  });

  final String name;
  final String url;
  final String? description;
  final List<String> icons;

  Map<String, dynamic> toJson() => {
        'name': name,
        'url': url,
        if (description != null) 'description': description,
        if (icons.isNotEmpty) 'icons': icons,
      };
}

/// Account returned by a connected session.
class ZuniaSessionAccount {
  const ZuniaSessionAccount({
    required this.chainId,
    required this.address,
    required this.algo,
    required this.pubkey,
    this.name,
    this.bech32Address,
  });

  final String chainId;
  final String address;
  final String algo;

  /// Base64-encoded compressed pubkey.
  final String pubkey;
  final String? name;
  final String? bech32Address;

  factory ZuniaSessionAccount.fromJson(Map<String, dynamic> json) {
    return ZuniaSessionAccount(
      chainId: json['chainId'] as String? ?? '',
      address: json['address'] as String? ?? '',
      algo: json['algo'] as String? ?? 'secp256k1',
      pubkey: json['pubkey'] as String? ?? '',
      name: json['name'] as String?,
      bech32Address: json['bech32Address'] as String?,
    );
  }
}

/// Pairing payload from `POST /v1/connect/sessions`.
class ZuniaConnectPairing {
  const ZuniaConnectPairing({
    required this.sessionId,
    required this.pairingSecret,
    required this.expiresAt,
    required this.wsUrl,
    required this.deepLink,
    required this.qrPayload,
    required this.httpUrl,
  });

  final String sessionId;
  final String pairingSecret;
  final int expiresAt;
  final String wsUrl;
  final String deepLink;
  final String qrPayload;
  final String httpUrl;

  factory ZuniaConnectPairing.fromJson(Map<String, dynamic> json) {
    return ZuniaConnectPairing(
      sessionId: json['sessionId'] as String? ?? '',
      pairingSecret: json['pairingSecret'] as String? ?? '',
      expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
      wsUrl: json['wsUrl'] as String? ?? '',
      deepLink: json['deepLink'] as String? ?? '',
      qrPayload: json['qrPayload'] as String? ?? '',
      httpUrl: json['httpUrl'] as String? ?? '',
    );
  }
}

/// Options for [ZuniaSession.connect] / [ZuniaNativeSessionClient.connect].
class ZuniaConnectOptions {
  const ZuniaConnectOptions({
    required this.chains,
    this.metadata,
    this.apiBase,
    this.wsBase,
    this.walletConnectProjectId,
    this.timeout = const Duration(seconds: 120),
  });

  final List<String> chains;
  final ZuniaDappMetadata? metadata;
  final String? apiBase;
  final String? wsBase;
  final String? walletConnectProjectId;
  final Duration timeout;
}

/// High-level session facade used by Flutter dApps.
///
/// Native WebSocket pairing uses [ZuniaNativeSessionClient] (dart:io).
/// WalletConnect URI helpers live on [ZuniaConnect] in `connect.dart`.
class ZuniaSession {
  ZuniaSession();

  ZuniaSessionStatus _status = ZuniaSessionStatus.idle;
  List<ZuniaSessionAccount> _accounts = const [];
  List<String> _chains = const [];
  ZuniaConnectPairing? _pairing;
  ZuniaNativeSessionClient? _native;

  final _statusController = StreamController<ZuniaSessionStatus>.broadcast();
  final _accountsController =
      StreamController<List<ZuniaSessionAccount>>.broadcast();

  ZuniaSessionStatus get status => _status;
  List<ZuniaSessionAccount> get accounts => List.unmodifiable(_accounts);
  List<String> get chains => List.unmodifiable(_chains);
  ZuniaConnectPairing? get pairing => _pairing;

  Stream<ZuniaSessionStatus> get onStatus => _statusController.stream;
  Stream<List<ZuniaSessionAccount>> get onAccountsChanged =>
      _accountsController.stream;

  void _setStatus(ZuniaSessionStatus next) {
    _status = next;
    if (!_statusController.isClosed) _statusController.add(next);
  }

  /// Connect via Zunia-native HTTP + WebSocket broker.
  ///
  /// Requires [ZuniaConnectOptions.apiBase]. Uses `dart:io` WebSocket, so this
  /// path is for mobile / desktop Flutter (not Flutter web).
  Future<void> connect(ZuniaConnectOptions options) async {
    final apiBase = options.apiBase;
    if (apiBase == null || apiBase.isEmpty) {
      throw StateError('apiBase is required for native connect');
    }
    _native = ZuniaNativeSessionClient();
    _native!.onStatus.listen(_setStatus);
    _native!.onAccountsChanged.listen((accounts) {
      _accounts = accounts;
      if (!_accountsController.isClosed) _accountsController.add(accounts);
    });
    _native!.onPairing.listen((p) => _pairing = p);

    await _native!.connect(options);
    _accounts = await _native!.getAccounts();
    _chains = List<String>.from(options.chains);
    _pairing = _native!.pairing;
    _setStatus(ZuniaSessionStatus.connected);
  }

  Future<void> disconnect([String? reason]) async {
    await _native?.disconnect(reason);
    _native = null;
    _accounts = const [];
    _setStatus(ZuniaSessionStatus.disconnected);
  }

  Future<List<ZuniaSessionAccount>> getAccounts() async {
    return _native?.getAccounts() ?? _accounts;
  }

  Future<dynamic> signAmino(
    String chainId,
    String signer,
    Map<String, dynamic> signDoc,
  ) {
    final client = _native;
    if (client == null) throw StateError('No session');
    return client.signAmino(chainId, signer, signDoc);
  }

  Future<dynamic> signDirect(
    String chainId,
    String signer, {
    required Uint8List bodyBytes,
    required Uint8List authInfoBytes,
  }) {
    final client = _native;
    if (client == null) throw StateError('No session');
    return client.signDirect(
      chainId,
      signer,
      bodyBytes: bodyBytes,
      authInfoBytes: authInfoBytes,
    );
  }

  Future<dynamic> signArbitrary(
    String chainId,
    String signer,
    Object data,
  ) {
    final client = _native;
    if (client == null) throw StateError('No session');
    return client.signArbitrary(chainId, signer, data);
  }

  Future<void> dispose() async {
    await disconnect();
    await _statusController.close();
    await _accountsController.close();
  }
}

/// Native HTTP + WebSocket session client (`zunia.connect.v1`).
///
/// Relies on `dart:io` ([HttpClient], [WebSocket]). Not available on Flutter web
/// without adding `web_socket_channel` / `http` packages.
class ZuniaNativeSessionClient {
  WebSocket? _ws;
  ZuniaConnectPairing? _pairing;
  List<ZuniaSessionAccount> _accounts = const [];
  final _pending = <String, Completer<dynamic>>{};

  final _statusController = StreamController<ZuniaSessionStatus>.broadcast();
  final _accountsController =
      StreamController<List<ZuniaSessionAccount>>.broadcast();
  final _pairingController =
      StreamController<ZuniaConnectPairing>.broadcast();

  ZuniaConnectPairing? get pairing => _pairing;

  Stream<ZuniaSessionStatus> get onStatus => _statusController.stream;
  Stream<List<ZuniaSessionAccount>> get onAccountsChanged =>
      _accountsController.stream;
  Stream<ZuniaConnectPairing> get onPairing => _pairingController.stream;

  void _emitStatus(ZuniaSessionStatus s) {
    if (!_statusController.isClosed) _statusController.add(s);
  }

  Map<String, dynamic> _envelope(
    String type,
    Map<String, dynamic> payload, [
    String? id,
  ]) {
    return {
      'v': ZuniaNativeConnect.protocolVersion,
      'type': type,
      if (id != null) 'id': id,
      'ts': DateTime.now().millisecondsSinceEpoch,
      'payload': payload,
    };
  }

  Future<void> connect(ZuniaConnectOptions options) async {
    _emitStatus(ZuniaSessionStatus.connecting);
    final apiBase = (options.apiBase ?? '').replaceAll(RegExp(r'/$'), '');
    if (apiBase.isEmpty) {
      throw StateError('apiBase is required for native-ws');
    }

    final metadata = options.metadata ??
        const ZuniaDappMetadata(name: 'Flutter dApp', url: 'https://localhost');
    final body = {
      'metadata': metadata.toJson(),
      'chains': options.chains,
      'methods': ZuniaNativeConnect.defaultMethods,
      'events': ZuniaNativeConnect.defaultEvents,
    };

    final client = HttpClient();
    try {
      final req = await client.postUrl(
        Uri.parse('$apiBase${ZuniaNativeConnect.httpPath}'),
      );
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(jsonEncode(body)));
      final res = await req.close();
      final text = await res.transform(utf8.decoder).join();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw HttpException(
          'Failed to create connect session (${res.statusCode}): $text',
        );
      }
      _pairing = ZuniaConnectPairing.fromJson(
        jsonDecode(text) as Map<String, dynamic>,
      );
      if (!_pairingController.isClosed) _pairingController.add(_pairing!);
      _emitStatus(ZuniaSessionStatus.awaitingWallet);
    } finally {
      client.close(force: true);
    }

    var wsUri = Uri.parse(_pairing!.wsUrl);
    final params = Map<String, String>.from(wsUri.queryParameters)
      ..['role'] = 'dapp';
    if (options.wsBase != null && options.wsBase!.isNotEmpty) {
      final base = Uri.parse(options.wsBase!);
      wsUri = wsUri.replace(
        scheme: base.scheme,
        host: base.host,
        port: base.hasPort ? base.port : null,
        queryParameters: params,
      );
    } else {
      wsUri = wsUri.replace(queryParameters: params);
    }

    final completer = Completer<void>();
    Timer? timeout;
    timeout = Timer(options.timeout, () {
      if (!completer.isCompleted) {
        completer.completeError(
          TimeoutException('Wallet did not approve in time'),
        );
      }
    });

    _ws = await WebSocket.connect(wsUri.toString());
    _ws!.add(
      jsonEncode(
        _envelope('hello', {
          'role': 'dapp',
          'metadata': metadata.toJson(),
        }),
      ),
    );
    _ws!.add(
      jsonEncode(
        _envelope('connect_request', {
          'origin': metadata.url,
          'metadata': metadata.toJson(),
          'chains': options.chains,
          'methods': ZuniaNativeConnect.defaultMethods,
          'events': ZuniaNativeConnect.defaultEvents,
        }),
      ),
    );

    _ws!.listen(
      (dynamic raw) {
        Map<String, dynamic> msg;
        try {
          msg = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>))
              as Map<String, dynamic>;
        } catch (_) {
          return;
        }
        final type = msg['type'] as String?;
        final payload = msg['payload'];
        if (type == 'connect_approve') {
          final map = payload as Map<String, dynamic>? ?? {};
          final list = (map['accounts'] as List<dynamic>? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(ZuniaSessionAccount.fromJson)
              .toList();
          _accounts = list;
          if (!_accountsController.isClosed) {
            _accountsController.add(_accounts);
          }
          timeout?.cancel();
          _emitStatus(ZuniaSessionStatus.connected);
          if (!completer.isCompleted) completer.complete();
          return;
        }
        if (type == 'connect_reject') {
          timeout?.cancel();
          final reason = (payload as Map<String, dynamic>?)?['reason'] ??
              'Rejected';
          if (!completer.isCompleted) {
            completer.completeError(StateError(reason.toString()));
          }
          return;
        }
        if (type == 'event_accounts_changed') {
          final list = (payload as List<dynamic>? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(ZuniaSessionAccount.fromJson)
              .toList();
          _accounts = list;
          if (!_accountsController.isClosed) {
            _accountsController.add(_accounts);
          }
        }
        if (type == 'sign_result' || type == 'sign_reject') {
          final id = msg['id'] as String?;
          final waiter = id == null ? null : _pending.remove(id);
          if (waiter == null) return;
          if (type == 'sign_reject') {
            final reason =
                (payload as Map<String, dynamic>?)?['reason'] ?? 'Rejected';
            waiter.completeError(StateError(reason.toString()));
          } else {
            waiter.complete(payload);
          }
        }
        if (type == 'disconnect') {
          _emitStatus(ZuniaSessionStatus.disconnected);
        }
      },
      onError: (Object e) {
        timeout?.cancel();
        if (!completer.isCompleted) completer.completeError(e);
      },
      onDone: () {
        _emitStatus(ZuniaSessionStatus.disconnected);
      },
      cancelOnError: false,
    );

    await completer.future;
  }

  Future<void> disconnect([String? reason]) async {
    try {
      _ws?.add(
        jsonEncode(_envelope('disconnect', {'reason': reason ?? 'user'})),
      );
      await _ws?.close();
    } catch (_) {
      // Ignore close errors.
    }
    _ws = null;
    final httpUrl = _pairing?.httpUrl;
    if (httpUrl != null && httpUrl.isNotEmpty) {
      final client = HttpClient();
      try {
        final req = await client.deleteUrl(Uri.parse(httpUrl));
        await req.close();
      } catch (_) {
        // Ignore.
      } finally {
        client.close(force: true);
      }
    }
    _emitStatus(ZuniaSessionStatus.disconnected);
  }

  Future<List<ZuniaSessionAccount>> getAccounts() async => _accounts;

  Future<dynamic> _request(
    String type,
    Map<String, dynamic> payload,
  ) async {
    final ws = _ws;
    if (ws == null || ws.readyState != WebSocket.open) {
      throw StateError('Native WS not connected');
    }
    final id = DateTime.now().microsecondsSinceEpoch.toString();
    final completer = Completer<dynamic>();
    _pending[id] = completer;
    _emitStatus(ZuniaSessionStatus.signing);
    ws.add(jsonEncode(_envelope(type, payload, id)));
    try {
      return await completer.future;
    } finally {
      _emitStatus(ZuniaSessionStatus.connected);
    }
  }

  Future<dynamic> signAmino(
    String chainId,
    String signer,
    Map<String, dynamic> signDoc,
  ) {
    return _request('sign_amino', {
      'chainId': chainId,
      'signer': signer,
      'signDoc': signDoc,
    });
  }

  Future<dynamic> signDirect(
    String chainId,
    String signer, {
    required Uint8List bodyBytes,
    required Uint8List authInfoBytes,
  }) {
    return _request('sign_direct', {
      'chainId': chainId,
      'signer': signer,
      'bodyBytes': base64Encode(bodyBytes),
      'authInfoBytes': base64Encode(authInfoBytes),
    });
  }

  Future<dynamic> signArbitrary(
    String chainId,
    String signer,
    Object data,
  ) {
    final encoding = data is String ? 'utf8' : 'base64';
    final encoded = data is String
        ? data
        : base64Encode(data is Uint8List ? data : Uint8List.fromList(data as List<int>));
    return _request('sign_arbitrary', {
      'chainId': chainId,
      'signer': signer,
      'data': encoded,
      'encoding': encoding,
    });
  }

  Future<void> dispose() async {
    await disconnect();
    await _statusController.close();
    await _accountsController.close();
    await _pairingController.close();
  }
}

/// Basic WalletConnect URI helpers (no SignClient dependency).
class ZuniaWcUri {
  ZuniaWcUri._();

  /// `wc:` pairing URI → Zunia deep link that opens the mobile wallet.
  static Uri deepLinkFromWcUri(String wcUri) {
    return Uri(
      scheme: ZuniaConstants.customScheme,
      host: 'wc',
      queryParameters: {'uri': wcUri},
    );
  }

  /// Universal link wrapper for a WC pairing URI.
  static Uri universalFromWcUri(String wcUri) {
    return Uri.https('zunialab.com', '/wc', {'uri': wcUri});
  }

  /// Extract the nested `uri` query param from a Zunia / WC inbound link.
  static String? extractWcUri(Uri uri) {
    if (uri.scheme == ZuniaConstants.walletConnectScheme) {
      return uri.toString();
    }
    final nested = uri.queryParameters['uri'];
    if (nested != null && nested.isNotEmpty) return nested;
    return null;
  }
}
