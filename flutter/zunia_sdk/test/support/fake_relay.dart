import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:zunia_sdk/src/encoding.dart';

/// A zunia.connect.v2 relay on localhost, close enough to the real one
/// (zunia-backend/src/connect) for the client to run end to end: sessions
/// over HTTP, token subprotocols, welcome/hello/msg/paired/ping, queues for
/// an offline peer, QUEUE_FULL and the close codes.
class FakeRelay {
  FakeRelay._(this._server);

  final HttpServer _server;
  final Map<String, RelayRoom> rooms = {};

  /// Frames held per direction before QUEUE_FULL.
  int queueMaxFrames = 32;

  /// What the relay reports as the creating page's origin.
  String? verifiedOrigin;

  /// POSTs answered so far.
  int created = 0;

  /// DELETEs answered so far.
  int deleted = 0;

  static Future<FakeRelay> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final relay = FakeRelay._(server);
    server.listen(relay._handle);
    return relay;
  }

  String get apiBase => 'http://127.0.0.1:${_server.port}';
  String get wsBase => 'ws://127.0.0.1:${_server.port}';

  Future<void> close() async {
    for (final room in rooms.values) {
      await room.sockets['dapp']?.close();
      await room.sockets['wallet']?.close();
    }
    await _server.close(force: true);
  }

  RelayRoom get onlyRoom => rooms.values.single;

  String _id(int bytes) => bytesToBase64Url(randomBytes(bytes));

  Future<void> _handle(HttpRequest request) async {
    final path = request.uri.path;
    if (request.method == 'POST' && path == '/v1/connect/sessions') {
      created += 1;
      final room = RelayRoom(
        sessionId: _id(16).substring(0, 22),
        dappToken: _id(32),
        joinToken: _id(32),
        expiresAt: DateTime.now()
            .add(const Duration(minutes: 10))
            .millisecondsSinceEpoch,
      );
      rooms[room.sessionId] = room;
      request.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({
          'v': 'zunia.connect.v2',
          'sessionId': room.sessionId,
          'dappToken': room.dappToken,
          'walletJoinToken': room.joinToken,
          'verifiedOrigin': verifiedOrigin,
          'expiresAt': room.expiresAt,
          'wsUrl': '$wsBase/v1/connect/ws',
        }));
      await request.response.close();
      return;
    }
    if (request.method == 'DELETE' &&
        path.startsWith('/v1/connect/sessions/')) {
      deleted += 1;
      final id = path.split('/').last;
      final room = rooms[id];
      final auth = request.headers.value('authorization');
      if (room != null && auth == 'Bearer ${room.dappToken}') {
        room.end('deleted');
      }
      request.response.statusCode = 204;
      await request.response.close();
      return;
    }
    if (path == '/v1/connect/ws' &&
        WebSocketTransformer.isUpgradeRequest(request)) {
      final sid = request.uri.queryParameters['sid'] ?? '';
      final role = request.uri.queryParameters['role'] ?? '';
      final offered = (request.headers['sec-websocket-protocol'] ?? const [])
          .expand((value) => value.split(','))
          .map((value) => value.trim())
          .toList();
      final token = offered
          .firstWhere((p) => p.startsWith('zunia.token.'), orElse: () => '')
          .replaceFirst('zunia.token.', '');
      final WebSocket socket;
      try {
        socket = await WebSocketTransformer.upgrade(request,
            protocolSelector: (protocols) =>
                protocols.contains('zunia.connect.v2')
                    ? 'zunia.connect.v2'
                    : null);
      } catch (_) {
        // The client went away mid-handshake.
        return;
      }
      final room = rooms[sid];
      final ok = room != null &&
          !room.ended &&
          (role == 'dapp'
              ? token == room.dappToken
              : token == room.joinToken || token == room.resumeToken);
      if (!ok) {
        await socket.close(4401, 'unauthorized');
        return;
      }
      room.attach(role, socket, this);
      return;
    }
    request.response.statusCode = 404;
    await request.response.close();
  }
}

/// Writes to a socket that may have closed meanwhile, as a real server shrugs off.
void send(WebSocket? socket, String data) {
  if (socket == null || socket.closeCode != null) return;
  try {
    socket.add(data);
  } catch (_) {
    // Closed between the check and the write.
  }
}

class RelayRoom {
  RelayRoom({
    required this.sessionId,
    required this.dappToken,
    required this.joinToken,
    required this.expiresAt,
  });

  final String sessionId;
  final String dappToken;
  final String joinToken;
  String? resumeToken;
  int expiresAt;
  bool paired = false;
  bool ended = false;
  final Map<String, WebSocket> sockets = {};
  final Map<String, List<String>> queues = {'dapp': [], 'wallet': []};

  /// Every frame a client sent, by role, for assertions.
  final Map<String, List<Map<String, Object?>>> received = {
    'dapp': [],
    'wallet': []
  };

  void attach(String role, WebSocket socket, FakeRelay relay) {
    final previous = sockets[role];
    sockets[role] = socket;
    if (previous != null) unawaited(previous.close(4000, 'replaced'));
    final peer = role == 'dapp' ? 'wallet' : 'dapp';
    if (role == 'wallet') resumeToken ??= bytesToBase64Url(randomBytes(32));
    send(
        socket,
        jsonEncode({
          't': 'welcome',
          'v': 'zunia.connect.v2',
          'role': role,
          'sessionId': sessionId,
          'verifiedOrigin': relay.verifiedOrigin,
          'paired': paired,
          'peer': sockets[peer] != null,
          'expiresAt': expiresAt,
          if (role == 'wallet') 'resumeToken': resumeToken,
        }));
    send(sockets[peer], jsonEncode({'t': 'peer', 'online': true}));
    for (final frame in queues[role]!) {
      send(socket, frame);
    }
    queues[role]!.clear();
    socket.listen(
      (data) => _onFrame(role, socket, data as String, relay),
      onError: (Object _) {},
      onDone: () {
        if (sockets[role] == socket) {
          sockets.remove(role);
          send(sockets[peer], jsonEncode({'t': 'peer', 'online': false}));
        }
      },
    );
  }

  void _deliver(String to, Map<String, Object?> frame, WebSocket sender,
      FakeRelay relay) {
    final data = jsonEncode(frame);
    final target = sockets[to];
    if (target != null) {
      send(target, data);
      return;
    }
    if (queues[to]!.length >= relay.queueMaxFrames) {
      send(
          sender,
          jsonEncode({
            't': 'error',
            'code': 'QUEUE_FULL',
            'message': 'The other side is offline and its queue is full',
          }));
      return;
    }
    queues[to]!.add(data);
  }

  void _onFrame(String role, WebSocket socket, String raw, FakeRelay relay) {
    if (ended || sockets[role] != socket) return;
    final frame = jsonDecode(raw) as Map<String, Object?>;
    received[role]!.add(frame);
    final peer = role == 'dapp' ? 'wallet' : 'dapp';
    switch (frame['t']) {
      case 'ping':
        send(socket, jsonEncode({'t': 'pong'}));
      case 'hello':
        if (role == 'wallet') {
          _deliver('dapp', {'t': 'hello', 'pk': frame['pk']}, socket, relay);
        }
      case 'msg':
        _deliver(peer, {'t': 'msg', 'n': frame['n'], 'c': frame['c']}, socket,
            relay);
      case 'paired':
        if (role == 'wallet' && !paired) {
          paired = true;
          expiresAt = DateTime.now()
              .add(const Duration(hours: 24))
              .millisecondsSinceEpoch;
          for (final s in sockets.values) {
            send(s, jsonEncode({'t': 'paired', 'expiresAt': expiresAt}));
          }
        }
      case 'close':
        end('closed');
    }
  }

  void end(String reason) {
    if (ended) return;
    ended = true;
    for (final socket in sockets.values) {
      send(socket, jsonEncode({'t': 'closed', 'reason': reason}));
      unawaited(socket.close(4001, reason));
    }
    sockets.clear();
  }

  /// Drops the socket of [role] without a close code, as a network loss would.
  Future<void> drop(String role) async {
    final socket = sockets.remove(role);
    if (socket == null) return;
    final peer = role == 'dapp' ? 'wallet' : 'dapp';
    send(sockets[peer], jsonEncode({'t': 'peer', 'online': false}));
    await socket.close(1011, 'dropped');
  }
}
