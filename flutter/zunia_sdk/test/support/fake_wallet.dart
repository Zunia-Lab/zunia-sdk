import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:zunia_sdk/src/encoding.dart';
import 'package:zunia_sdk/zunia_sdk.dart';

/// What the fake wallet answers to one request: a `result` payload, or an
/// `error` payload when [error] is set.
class WalletAnswer {
  const WalletAnswer.result(this.payload) : error = null;
  const WalletAnswer.error(String code, String message)
      : payload = null,
        error = (code: code, message: message);

  final Object? payload;
  final ({String code, String message})? error;
}

/// Plays Zunia mobile against [FakeRelay] with the SDK's own crypto in the
/// wallet role, the way zunia-mobile's NativeConnectService does.
class FakeWallet {
  FakeWallet(this.pairing);

  final ZuniaPairingUri pairing;
  WebSocket? _socket;
  ConnectCipher? cipher;
  String? verificationCode;
  String? resumeToken;
  final requests = <ConnectEnvelope>[];
  final _requestController = StreamController<ConnectEnvelope>.broadcast();

  /// Answer to `connect_request`. Null approves with [accounts].
  WalletAnswer? connectAnswer;

  /// Accounts shared on approval.
  List<Map<String, Object?>> accounts = [
    {
      'chainId': 'cosmoshub-4',
      'address': 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu',
      'algo': 'secp256k1',
      'pubKey': base64.encode(List.filled(33, 2)),
      'name': 'Main',
    },
  ];

  /// Answers to sign requests. Defaults to a fixed signature.
  WalletAnswer Function(ConnectEnvelope request)? answer;

  Stream<ConnectEnvelope> get requestStream => _requestController.stream;

  static Map<String, Object?> signature() => {
        'pub_key': {
          'type': 'tendermint/PubKeySecp256k1',
          'value': base64.encode(List.filled(33, 2)),
        },
        'signature': base64.encode(List.filled(64, 7)),
      };

  Future<void> join({bool resume = false}) async {
    final token = resume ? resumeToken! : pairing.joinToken;
    final socket = await WebSocket.connect(
      '${pairing.relay}/v1/connect/ws?sid=${pairing.sessionId}&role=wallet',
      protocols: ['zunia.connect.v2', 'zunia.token.$token'],
    );
    _socket = socket;
    final keyPair = await ConnectKeyPair.generate();
    socket.listen((data) => _onFrame(data as String, keyPair));
    if (!resume) {
      final keys = await deriveConnectKeys(
        role: ConnectRole.wallet,
        sessionId: pairing.sessionId,
        own: keyPair,
        peerPublicKey: base64UrlToBytes(pairing.dappPublicKey),
      );
      verificationCode = keys.verificationCode;
      cipher = ConnectCipher(
        role: ConnectRole.wallet,
        sessionId: pairing.sessionId,
        dappToWallet: keys.dappToWallet,
        walletToDapp: keys.walletToDapp,
      );
      socket.add(jsonEncode(
          {'t': 'hello', 'pk': bytesToBase64Url(keyPair.publicKey)}));
    }
  }

  Future<void> leave() async {
    await _socket?.close();
    _socket = null;
  }

  void send(String type, {String? id, Object? payload}) {
    final frame = cipher!.seal(type: type, id: id, payload: payload);
    _socket!.add(jsonEncode({'t': 'msg', 'n': frame.n, 'c': frame.c}));
  }

  void _onFrame(String raw, ConnectKeyPair keyPair) {
    final frame = jsonDecode(raw) as Map<String, Object?>;
    switch (frame['t']) {
      case 'welcome':
        resumeToken = frame['resumeToken'] as String? ?? resumeToken;
      case 'msg':
        final envelope = cipher!.openFresh(
            SealedFrame(n: frame['n']! as String, c: frame['c']! as String));
        if (envelope == null) return;
        requests.add(envelope);
        _requestController.add(envelope);
        _answer(envelope);
    }
  }

  void _answer(ConnectEnvelope request) {
    if (request.type == 'connect_request') {
      final reply = connectAnswer;
      if (reply?.error != null) {
        send('connect_reject', id: request.id, payload: {
          'code': reply!.error!.code,
          'message': reply.error!.message,
        });
        return;
      }
      final payload = request.payload! as Map<String, Object?>;
      send('connect_approve', id: request.id, payload: {
        'accounts': accounts,
        'chains': payload['chains'],
        'wallet': {'name': 'Zunia', 'version': '0.1.0'},
      });
      _socket!.add(jsonEncode({'t': 'paired'}));
      return;
    }
    final reply = answer?.call(request) ?? _defaultAnswer(request);
    if (reply.error != null) {
      send('error', id: request.id, payload: {
        'code': reply.error!.code,
        'message': reply.error!.message,
      });
    } else {
      send('result', id: request.id, payload: reply.payload);
    }
  }

  WalletAnswer _defaultAnswer(ConnectEnvelope request) {
    final payload = request.payload! as Map<String, Object?>;
    switch (request.type) {
      case 'get_accounts':
        return WalletAnswer.result(accounts);
      case 'sign_direct':
        return WalletAnswer.result(
            {'signed': payload['signDoc'], 'signature': signature()});
      case 'sign_amino':
        return WalletAnswer.result(
            {'signed': payload['signDoc'], 'signature': signature()});
      default:
        return WalletAnswer.result(signature());
    }
  }
}
