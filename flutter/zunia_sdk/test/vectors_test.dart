import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:zunia_sdk/src/encoding.dart';
import 'package:zunia_sdk/zunia_sdk.dart';

Map<String, Object?> _fixture(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, Object?>;

void main() {
  final connect = _fixture('connect-v2-vectors.json');
  final signIn = _fixture('sign-in-vectors.json');

  group('zunia.connect.v2 vectors', () {
    for (final raw in connect['keyAgreement']! as List<Object?>) {
      final v = raw! as Map<String, Object?>;
      test('key agreement: ${v['name']}', () async {
        final sessionId = v['sessionId']! as String;
        final dapp = await ConnectKeyPair.fromSecret(
            hexToBytes(v['dappSecretKey']! as String));
        final wallet = await ConnectKeyPair.fromSecret(
            hexToBytes(v['walletSecretKey']! as String));
        expect(bytesToBase64Url(dapp.publicKey), v['dappPublicKey']);
        expect(bytesToBase64Url(wallet.publicKey), v['walletPublicKey']);
        expect(bytesToHex(await dapp.sharedSecret(wallet.publicKey)),
            v['sharedSecret']);
        expect(
            bytesToHex(
                connectTranscript(sessionId, dapp.publicKey, wallet.publicKey)),
            v['transcript']);

        final fromDapp = await deriveConnectKeys(
            role: ConnectRole.dapp,
            sessionId: sessionId,
            own: dapp,
            peerPublicKey: wallet.publicKey);
        final fromWallet = await deriveConnectKeys(
            role: ConnectRole.wallet,
            sessionId: sessionId,
            own: wallet,
            peerPublicKey: dapp.publicKey);
        for (final keys in [fromDapp, fromWallet]) {
          expect(bytesToHex(keys.dappToWallet), v['dappToWallet']);
          expect(bytesToHex(keys.walletToDapp), v['walletToDapp']);
          expect(keys.verificationCode, v['verificationCode']);
        }
      });
    }

    for (final raw in connect['frames']! as List<Object?>) {
      final v = raw! as Map<String, Object?>;
      test('frame: ${v['name']}', () {
        final sender =
            v['sender'] == 'dapp' ? ConnectRole.dapp : ConnectRole.wallet;
        final sessionId = v['sessionId']! as String;
        final aad = frameAad(sessionId, sender);
        expect(utf8.decode(aad), v['aad']);
        final key = hexToBytes(v['key']! as String);
        final nonce = base64UrlToBytes(v['nonce']! as String);
        final plaintext = v['plaintext']! as String;
        final sealed = encryptFrame(key, nonce, aad, utf8.encode(plaintext));
        expect(bytesToBase64Url(sealed), v['ciphertext']);
        expect(
            utf8.decode(decryptFrame(
                key, nonce, aad, base64UrlToBytes(v['ciphertext']! as String))),
            plaintext);

        // The cipher writes the same JSON envelope the vectors pin.
        final envelope = jsonDecode(plaintext) as Map<String, Object?>;
        final cipher = ConnectCipher(
          role: sender,
          sessionId: sessionId,
          dappToWallet: key,
          walletToDapp: key,
          sendSeq: (envelope['seq']! as int) - 1,
          nonceSource: (_) => nonce,
        );
        final frame = cipher.seal(
            type: envelope['type']! as String,
            id: envelope['id'] as String?,
            payload: envelope['payload']);
        expect(frame.c, v['ciphertext']);
      });
    }

    test('verification codes', () {
      for (final raw in connect['verificationCodes']! as List<Object?>) {
        final v = raw! as Map<String, Object?>;
        expect(
            verificationCodeFrom(hexToBytes(v['bytes']! as String)), v['code']);
      }
    });

    test('pairing URIs', () {
      final uris = connect['pairingUris']! as Map<String, Object?>;
      for (final valid in uris['valid']! as List<Object?>) {
        final parsed = parsePairingUri(valid! as String);
        expect(parsed, isNotNull, reason: '$valid');
        expect(buildPairingUri(parsed!), valid);
      }
      for (final invalid in uris['invalid']! as List<Object?>) {
        expect(parsePairingUri(invalid! as String), isNull, reason: '$invalid');
      }
    });
  });

  group('cipher', () {
    test('drops replays and rejects tampering', () async {
      final keys = hexToBytes(
          'e6197d655ca51e87047d724c85704db02aeb7b066c924e4bff94b0aa9c8f144d');
      final dapp = ConnectCipher(
          role: ConnectRole.dapp,
          sessionId: 'Zf3kQ9xTn2LmP8vR4sWb1A',
          dappToWallet: keys,
          walletToDapp: keys);
      final wallet = ConnectCipher(
          role: ConnectRole.wallet,
          sessionId: 'Zf3kQ9xTn2LmP8vR4sWb1A',
          dappToWallet: keys,
          walletToDapp: keys);
      final first =
          dapp.seal(type: 'get_accounts', id: 'a', payload: {'chainIds': []});
      final second = dapp.seal(type: 'get_accounts', id: 'b');
      expect(wallet.open(second).id, 'b');
      expect(wallet.openFresh(first), isNull);
      expect(() => wallet.open(first), throwsA(isA<ZuniaConnectException>()));
      final tampered = SealedFrame(
          n: second.n,
          c: '${second.c.substring(0, 10)}A${second.c.substring(11)}');
      expect(
          () => wallet.openFresh(tampered),
          throwsA(isA<ZuniaConnectException>()
              .having((e) => e.code, 'code', ZuniaErrorCode.pairingFailed)));
    });
  });

  group('sign-in vectors', () {
    for (final raw in signIn['valid']! as List<Object?>) {
      final v = raw! as Map<String, Object?>;
      test('valid: ${v['name']}', () {
        final text = (v['lines']! as List<Object?>).join('\n');
        final fields = v['fields']! as Map<String, Object?>;
        final parsed = parseSignInMessage(text);
        expect(parsed.toJson(), fields);
        final rebuilt = buildSignInMessage(SignInMessage(
          domain: fields['domain']! as String,
          address: fields['address']! as String,
          statement: fields['statement'] as String?,
          uri: fields['uri']! as String,
          chainId: fields['chainId']! as String,
          nonce: fields['nonce']! as String,
          issuedAt: fields['issuedAt']! as String,
          expirationTime: fields['expirationTime'] as String?,
          notBefore: fields['notBefore'] as String?,
          requestId: fields['requestId'] as String?,
          resources: (fields['resources'] as List<Object?>?)?.cast<String>(),
        ));
        expect(rebuilt, text);
      });
    }

    for (final raw in signIn['invalid']! as List<Object?>) {
      final v = raw! as Map<String, Object?>;
      test('invalid: ${v['name']}', () {
        final text = (v['lines']! as List<Object?>).join('\n');
        expect(
            () => parseSignInMessage(text),
            throwsA(isA<ZuniaConnectException>()
                .having((e) => e.code, 'code', ZuniaErrorCode.invalidParams)));
      });
    }

    test('nonces are valid and unique', () {
      final a = createNonce();
      expect(a, matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(createNonce(), isNot(a));
    });

    test('ISO strings match JavaScript toISOString', () {
      expect(toIsoString(DateTime.utc(2026, 9, 24, 10, 0, 0, 7)),
          '2026-09-24T10:00:00.007Z');
    });
  });
}
