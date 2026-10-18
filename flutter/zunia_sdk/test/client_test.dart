import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zunia_sdk/zunia_sdk.dart';

import 'support/fake_relay.dart';
import 'support/fake_wallet.dart';

const _chain = 'cosmoshub-4';
const _address = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
const _metadata =
    ZuniaDappMetadata(name: 'Test app', url: 'https://app.example.com');

final _signDoc = ZuniaSignDoc(
  bodyBytes: Uint8List.fromList([1, 2, 3]),
  authInfoBytes: Uint8List.fromList([4, 5]),
  chainId: _chain,
  accountNumber: BigInt.from(42),
);

void main() {
  late FakeRelay relay;
  late MemorySessionStorage storage;
  final launched = <Uri>[];
  final clients = <ZuniaConnectClient>[];

  ZuniaConnectClient newClient({
    String? returnUrl,
    bool launchSucceeds = true,
    Duration requestTimeout = const Duration(seconds: 10),
  }) {
    final client = ZuniaConnectClient(
      metadata: _metadata,
      apiBase: relay.apiBase,
      storage: storage,
      returnUrl: returnUrl,
      requestTimeout: requestTimeout,
      reconnectMin: const Duration(milliseconds: 50),
      reconnectMax: const Duration(milliseconds: 200),
      restoreWait: const Duration(seconds: 3),
      observeAppLifecycle: false,
      launcher: (uri) async {
        launched.add(uri);
        return launchSucceeds;
      },
    );
    clients.add(client);
    return client;
  }

  /// Starts [client.connect] and lets a fake wallet scan the code.
  Future<(Future<void>, FakeWallet)> pairWith(ZuniaConnectClient client,
      {void Function(FakeWallet wallet)? setup, bool openZunia = false}) async {
    final pairing = client.pairings.first;
    final connected = client.connect(chains: [_chain], openZunia: openZunia);
    connected.ignore();
    final wallet = FakeWallet(parsePairingUri((await pairing).uri)!);
    setup?.call(wallet);
    await wallet.join();
    return (connected, wallet);
  }

  setUp(() async {
    relay = await FakeRelay.start();
    storage = MemorySessionStorage();
    launched.clear();
  });

  tearDown(() async {
    for (final client in clients) {
      client.dispose();
    }
    clients.clear();
    await relay.close();
  });

  test('pairs, shows the same code as the wallet, and saves the session',
      () async {
    final client = newClient();
    final statuses = <ZuniaSessionStatus>[];
    client.statusChanges.listen(statuses.add);
    final code = client.verificationCodes.first;
    final (connected, wallet) = await pairWith(client);
    await connected;

    expect(await code, wallet.verificationCode);
    expect(client.verificationCode, wallet.verificationCode);
    expect(client.status, ZuniaSessionStatus.connected);
    expect(client.chains, [_chain]);
    expect(client.accounts.single.address, _address);
    expect(client.accounts.single.name, 'Main');
    expect(client.getKey(_chain).bech32Address, _address);
    expect(client.pairing, isNull);
    expect(
        statuses,
        containsAllInOrder([
          ZuniaSessionStatus.connecting,
          ZuniaSessionStatus.awaitingWallet,
          ZuniaSessionStatus.connected,
        ]));

    final request = wallet.requests.first;
    expect(request.type, 'connect_request');
    final payload = request.payload! as Map<String, Object?>;
    expect(payload['metadata'],
        {'name': 'Test app', 'url': 'https://app.example.com'});
    expect(payload['methods'], ZuniaNativeConnect.defaultMethods);

    final saved = jsonDecode((await storage.read('zunia.connect.v2.session'))!)
        as Map<String, Object?>;
    expect(saved['v'], 2);
    expect(saved['sessionId'], client.sessionId);
    expect(saved['chains'], [_chain]);
  });

  test('sends the relay token as a subprotocol and nothing in the URL',
      () async {
    final client = newClient();
    final (connected, _) = await pairWith(client);
    await connected;
    final room = relay.onlyRoom;
    // A wrong token would have closed the socket with 4401.
    expect(room.sockets.containsKey('dapp'), isTrue);
    expect(room.received['dapp']!.where((f) => f['t'] == 'msg'), isNotEmpty);
  });

  test('signs Direct, Amino and arbitrary data', () async {
    final client = newClient();
    final (connected, wallet) = await pairWith(client);
    await connected;

    final direct = await client.signDirect(_chain, _address, _signDoc);
    expect(direct.signed.bodyBytes, [1, 2, 3]);
    expect(direct.signed.accountNumber, BigInt.from(42));
    expect(direct.signature.signatureBytes, List.filled(64, 7));
    final directRequest = wallet.requests.last.payload! as Map<String, Object?>;
    expect(directRequest['signDoc'], {
      'bodyBytes': 'AQID',
      'authInfoBytes': 'BAU=',
      'chainId': _chain,
      'accountNumber': '42',
    });

    final amino = await client.signAmino(_chain, _address, {
      'chain_id': _chain,
      'account_number': '42',
      'sequence': '0',
      'fee': {'amount': <Object?>[], 'gas': '200000'},
      'msgs': <Object?>[],
      'memo': 'hi',
    });
    expect(amino.signed['memo'], 'hi');

    final arbitrary = await client.signArbitrary(_chain, _address, 'hello');
    expect(arbitrary.pubKeyType, 'tendermint/PubKeySecp256k1');
    expect((wallet.requests.last.payload! as Map)['encoding'], 'utf8');

    await client.signArbitraryBytes(_chain, _address, [0, 255]);
    final bytesRequest = wallet.requests.last.payload! as Map<String, Object?>;
    expect(bytesRequest['encoding'], 'base64');
    expect(bytesRequest['data'], 'AP8=');
  });

  test('surfaces the wallet error code', () async {
    final client = newClient();
    final (connected, _) = await pairWith(client, setup: (wallet) {
      wallet.answer =
          (_) => const WalletAnswer.error('USER_REJECTED', 'Request rejected');
    });
    await connected;
    await expectLater(
        client.signDirect(_chain, _address, _signDoc),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.userRejected)));
  });

  test('a declined connection fails connect with USER_REJECTED', () async {
    final client = newClient();
    final (connected, _) = await pairWith(client, setup: (wallet) {
      wallet.connectAnswer =
          const WalletAnswer.error('USER_REJECTED', 'Declined');
    });
    await expectLater(
        connected,
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.userRejected)));
    expect(client.status, ZuniaSessionStatus.disconnected);
    expect(await storage.read('zunia.connect.v2.session'), isNull);
  });

  test('restores the session after a restart and keeps signing', () async {
    final first = newClient();
    final (connected, wallet) = await pairWith(first);
    await connected;
    await first.signArbitrary(_chain, _address, 'one');
    first.dispose();

    final second = newClient();
    expect(await second.restore(chains: [_chain]), isTrue);
    expect(second.status, ZuniaSessionStatus.connected);
    expect(second.accounts.single.address, _address);
    final signature = await second.signArbitrary(_chain, _address, 'two');
    expect(signature.signature, isNotEmpty);
    // The wallet accepted it, so the sequence number moved on from the saved one.
    expect(
        wallet.requests.where((r) => r.type == 'sign_arbitrary'), hasLength(2));
  });

  test('restore answers false without a session, or for other chains',
      () async {
    final client = newClient();
    expect(await client.restore(), isFalse);
    final (connected, _) = await pairWith(client);
    await connected;
    client.dispose();
    expect(await newClient().restore(chains: ['osmosis-1']), isFalse);
  });

  test('resends an unanswered request after the link drops', () async {
    final client = newClient();
    final (connected, wallet) = await pairWith(client);
    await connected;
    await wallet.leave();
    await Future<void>.delayed(const Duration(milliseconds: 100));

    // Zunia is away: the relay queues the request.
    final pending = client.signArbitrary(_chain, _address, 'queued');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    await relay.onlyRoom.drop('dapp');
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(client.status, ZuniaSessionStatus.connected);

    await wallet.join(resume: true);
    final signature = await pending;
    expect(signature.signature, isNotEmpty);
    expect(
        wallet.requests.where((r) => r.type == 'sign_arbitrary'), hasLength(1));
  });

  test('fails a request at once when the relay queue for Zunia is full',
      () async {
    final client = newClient();
    final (connected, wallet) = await pairWith(client);
    await connected;
    await wallet.leave();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(client.walletOnline, isFalse);
    relay.queueMaxFrames = 0;

    final watch = Stopwatch()..start();
    await expectLater(
        client.signArbitrary(_chain, _address, 'lost'),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.network)
            .having((e) => e.reason, 'reason', ZuniaErrorReason.queueFull)));
    expect(watch.elapsed, lessThan(const Duration(seconds: 5)));
    expect(client.isConnected, isTrue);
  });

  test('refuses a request larger than the relay frame limit', () async {
    final client = newClient();
    final (connected, wallet) = await pairWith(client);
    await connected;
    final before = wallet.requests.length;
    await expectLater(
        client.signArbitrary(_chain, _address, 'x' * (400 * 1024)),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.invalidParams)
            .having((e) => e.reason, 'reason', ZuniaErrorReason.tooLarge)));
    // The next request still goes through: the skipped sequence number is harmless.
    await client.signArbitrary(_chain, _address, 'small');
    expect(wallet.requests.length, before + 1);
  });

  test('follows accounts_changed and ends on an empty chains_changed',
      () async {
    final client = newClient();
    final (connected, wallet) = await pairWith(client);
    await connected;

    final accounts = client.accountsChanges.first;
    wallet.send('accounts_changed', payload: {
      'accounts': [
        {
          'chainId': _chain,
          'address': 'cosmos1zg69v7ys40x77y352eufp27daufrg4ncnjqz7q',
          'algo': 'secp256k1',
          'pubKey': base64.encode(List.filled(33, 3)),
        },
        // Not granted to this app: dropped.
        {
          'chainId': 'osmosis-1',
          'address': 'osmo1zg69v7ys40x77y352eufp27daufrg4ncnjqz7q',
          'algo': 'secp256k1',
          'pubKey': base64.encode(List.filled(33, 3)),
        },
      ],
    });
    expect((await accounts).single.address,
        'cosmos1zg69v7ys40x77y352eufp27daufrg4ncnjqz7q');

    final ended = client.disconnects.first;
    wallet.send('chains_changed', payload: {'chains': <String>[]});
    expect(await ended, 'revoked');
    expect(client.status, ZuniaSessionStatus.disconnected);
  });

  test('disconnect ends the session for both sides and forgets it', () async {
    final client = newClient();
    final (connected, _) = await pairWith(client);
    await connected;
    await client.disconnect();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(relay.onlyRoom.ended, isTrue);
    expect(await storage.read('zunia.connect.v2.session'), isNull);
    await expectLater(
        client.signArbitrary(_chain, _address, 'x'),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.notConnected)));
  });

  test('a session the relay forgot ends with SESSION_EXPIRED', () async {
    final client = newClient();
    final (connected, _) = await pairWith(client);
    await connected;
    client.dispose();
    relay.rooms.clear();

    final restored = newClient();
    expect(await restored.restore(), isFalse);
    expect(restored.status, ZuniaSessionStatus.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(await storage.read('zunia.connect.v2.session'), isNull);
  });

  test('openZunia opens the pairing link with ret, then wake links', () async {
    final client = newClient(returnUrl: 'myapp://zunia');
    final (connected, _) = await pairWith(client, openZunia: true);
    await connected;

    final link = launched.single;
    expect(link.scheme, 'zunia');
    expect(link.queryParameters['ret'], 'myapp://zunia');
    expect(parsePairingUri(link.toString())!.returnUrl, 'myapp://zunia');

    await client.signArbitrary(_chain, _address, 'wake me');
    expect(launched.last, buildWakeLink(client.sessionId!));
    // A background refresh never pulls Zunia to the front.
    final count = launched.length;
    await client.refreshAccounts();
    expect(launched.length, count);
  });

  test('a QR-paired session never opens Zunia by itself', () async {
    final client = newClient();
    final (connected, _) = await pairWith(client);
    await connected;
    await client.signArbitrary(_chain, _address, 'quiet');
    expect(launched, isEmpty);
  });

  test('openZunia without Zunia installed fails with NOT_INSTALLED', () async {
    final client = newClient(launchSucceeds: false);
    await expectLater(
        client.connect(chains: [_chain], openZunia: true),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.notInstalled)));
  });

  test('signIn needs a verified web origin', () async {
    final client = newClient();
    final (connected, _) = await pairWith(client);
    await connected;
    await expectLater(
        client.signIn(nonce: createNonce()),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.originMismatch)));
  });

  test('signIn writes the message for the verified origin', () async {
    relay.verifiedOrigin = 'https://app.example.com';
    final client = newClient();
    final (connected, wallet) = await pairWith(client);
    await connected;
    final nonce = createNonce();
    final result =
        await client.signIn(nonce: nonce, statement: 'Welcome back.');
    final message = parseSignInMessage(result.message);
    expect(message.domain, 'app.example.com');
    expect(message.uri, 'https://app.example.com');
    expect(message.nonce, nonce);
    expect(message.address, _address);
    expect(message.expirationTime, isNotNull);
    expect((wallet.requests.last.payload! as Map)['data'], result.message);
  });

  test('a request nobody answers times out', () async {
    final client = newClient(requestTimeout: const Duration(milliseconds: 300));
    final (connected, wallet) = await pairWith(client);
    await connected;
    await wallet.leave();
    await expectLater(
        client.signArbitrary(_chain, _address, 'x'),
        throwsA(isA<ZuniaConnectException>()
            .having((e) => e.code, 'code', ZuniaErrorCode.timeout)));
  });

  test('connect refuses an empty chain list and a bad return URL', () async {
    expect(() => newClient(returnUrl: 'javascript:alert(1)'),
        throwsA(isA<ZuniaConnectException>()));
    await expectLater(newClient().connect(chains: [' ']),
        throwsA(isA<ZuniaConnectException>()));
  });
}
