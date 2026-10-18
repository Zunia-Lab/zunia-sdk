import 'package:flutter_test/flutter_test.dart';
import 'package:zunia_sdk/zunia_sdk.dart';

const _params = ZuniaPairingUri(
  sessionId: 'Zf3kQ9xTn2LmP8vR4sWb1A',
  joinToken: '78vWrA8rgZkX-X3b2kFXbZ4xGVuugyrwkOCgVtoTI8M',
  dappPublicKey: '6DGzxA3X-LUeWXgypFq8GG5l4txV91YLSJSpCTDLHjg',
  relay: 'wss://api.zunialab.com',
);

ZuniaPairingUri _withReturn(String? ret) => ZuniaPairingUri(
      sessionId: _params.sessionId,
      joinToken: _params.joinToken,
      dappPublicKey: _params.dappPublicKey,
      relay: _params.relay,
      returnUrl: ret,
    );

void main() {
  group('return URL (ret)', () {
    test('accepts https links and app schemes', () {
      for (final ok in [
        'https://app.example.com/after?x=1#y',
        'myapp://zunia-return',
        'com.example.app:/callback',
        'my-app+beta.v2://done?state=a%20b',
      ]) {
        expect(isAllowedReturnUrl(ok), isTrue, reason: ok);
      }
    });

    test('refuses wallet, script, local and plain-http targets', () {
      for (final bad in [
        'zunia://connect',
        'ZUNIAMOBILE://x',
        'wc:abc@2',
        'javascript:alert(1)',
        'data:text/html,hi',
        'file:///etc/passwd',
        'blob:https://a.example/1',
        'about:blank',
        'content://x',
        'intent://x#Intent;end',
        'http://app.example.com',
        'https://',
        'no-scheme',
        '://x',
        '1app://x',
        'myapp://has space',
        'myapp://bad%zz',
        'myapp://ünicode',
        'myapp://${'a' * 600}',
        '',
      ]) {
        expect(isAllowedReturnUrl(bad), isFalse, reason: bad);
      }
    });

    test('512 characters is the limit', () {
      final base = 'myapp://';
      expect(isAllowedReturnUrl(base + 'a' * (512 - base.length)), isTrue);
      expect(isAllowedReturnUrl(base + 'a' * (513 - base.length)), isFalse);
    });

    test('rides in the deep link and survives parsing', () {
      final uri = buildPairingUri(_withReturn('myapp://zunia?state=1&x=2'));
      expect(uri, contains('&ret=myapp%3A%2F%2Fzunia%3Fstate%3D1%26x%3D2'));
      expect(parsePairingUri(uri)!.returnUrl, 'myapp://zunia?state=1&x=2');
    });

    test('building refuses a target Zunia would ignore', () {
      expect(
          () => buildPairingUri(_withReturn('javascript:alert(1)')),
          throwsA(isA<ZuniaConnectException>()
              .having((e) => e.code, 'code', ZuniaErrorCode.invalidParams)));
    });

    test('parsing drops an unusable ret but keeps the pairing', () {
      final uri =
          '${buildPairingUri(_params)}&ret=${Uri.encodeQueryComponent('data:x')}';
      final parsed = parsePairingUri(uri)!;
      expect(parsed.sessionId, _params.sessionId);
      expect(parsed.returnUrl, isNull);
    });

    test('the QR payload never carries ret', () {
      final pairing = ZuniaPairing(
          params: _withReturn('myapp://zunia'), expiresAt: DateTime.now());
      expect(pairing.uri, isNot(contains('ret=')));
      expect(pairing.deepLink(returnUrl: 'myapp://zunia').toString(),
          contains('ret='));
    });

    test('https pairing links parse too', () {
      final link = buildPairingUniversalLink(_params);
      expect(link, startsWith('https://zunialab.com/connect?v=2&'));
      expect(parsePairingUri(link)!.joinToken, _params.joinToken);
    });
  });

  group('wake link', () {
    test('carries only the session id', () {
      final link = buildWakeLink(_params.sessionId);
      expect(link.toString(), 'zunia://connect/wake?sid=${_params.sessionId}');
      expect(buildWakeLink(_params.sessionId, universal: true).toString(),
          'https://zunialab.com/connect/wake?sid=${_params.sessionId}');
      expect(parseWakeLink(link.toString()), _params.sessionId);
      expect(
          parseWakeLink(
              'https://link.zunialab.com/connect/wake?sid=${_params.sessionId}'),
          _params.sessionId);
    });

    test('is not a pairing link, and a pairing link is not a wake link', () {
      final wake = buildWakeLink(_params.sessionId).toString();
      expect(parsePairingUri(wake), isNull);
      expect(parseWakeLink(buildPairingUri(_params)), isNull);
      expect(parseWakeLink('zunia://connect/wake?sid=short'), isNull);
      expect(
          parseWakeLink(
              'https://evil.example/connect/wake?sid=${_params.sessionId}'),
          isNull);
    });

    test('refuses a malformed session id', () {
      expect(
          () => buildWakeLink('nope'), throwsA(isA<ZuniaConnectException>()));
    });
  });

  group('errors', () {
    test('explanations cover every code and the queue-full reason', () {
      for (final code in [
        ...zuniaProviderErrorCodes,
        ZuniaErrorCode.notInstalled,
        ZuniaErrorCode.timeout,
        ZuniaErrorCode.disconnected,
        ZuniaErrorCode.pairingFailed,
        ZuniaErrorCode.sessionExpired,
        ZuniaErrorCode.network,
      ]) {
        final explanation = explainZuniaError(ZuniaConnectException(code, 'x'));
        expect(explanation.code, code);
        expect(explanation.title, isNotEmpty);
      }
      final full = explainZuniaError(const ZuniaConnectException(
          ZuniaErrorCode.network, 'x',
          reason: ZuniaErrorReason.queueFull));
      expect(full.title, 'Phone offline');
      expect(full.retryable, isTrue);
    });

    test('wallet errors keep known codes only', () {
      expect(
          walletErrorFrom(
                  {'code': 'USER_REJECTED', 'message': 'no'}, 'INTERNAL', 'f')
              .code,
          'USER_REJECTED');
      expect(
          walletErrorFrom({'code': 'EVIL', 'message': 'no'}, 'INTERNAL', 'f')
              .code,
          'INTERNAL');
      final expired = walletErrorFrom({
        'code': 'USER_REJECTED',
        'message': 'Request expired before it was answered'
      }, 'INTERNAL', 'f');
      expect(expired.code, ZuniaErrorCode.timeout);
      expect(expired.reason, ZuniaErrorReason.promptExpired);
    });
  });
}
