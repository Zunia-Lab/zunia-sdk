import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zunia_sdk/zunia_sdk.dart';

import 'support/fake_relay.dart';

Widget _host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: DefaultTextStyle(
        style: const TextStyle(fontSize: 14, color: Color(0xFFFFFFFF)),
        child: Center(child: child),
      ),
    );

/// flutter_test answers every HTTP request with 400; the fake relay is real.
class _RealHttp extends HttpOverrides {}

void main() {
  testWidgets('the QR code paints at the size asked, with a label',
      (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(_host(const ZuniaQrCode(
        data: 'zunia://connect?v=2',
        size: 200,
        semanticLabel: 'Pairing code')));
    expect(tester.getSize(find.byType(ZuniaQrCode)), const Size(200, 200));
    expect(find.bySemanticsLabel('Pairing code'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('the button is a labelled button that taps through',
      (tester) async {
    final semantics = tester.ensureSemantics();
    var taps = 0;
    await tester
        .pumpWidget(_host(ConnectWithZuniaButton(onPressed: () => taps++)));
    expect(
        tester.getSemantics(find.byType(ConnectWithZuniaButton)),
        matchesSemantics(
            label: 'Connect with Zunia',
            isButton: true,
            isEnabled: true,
            hasEnabledState: true,
            hasTapAction: true));
    await tester.tap(find.byType(ConnectWithZuniaButton));
    expect(taps, 1);
    semantics.dispose();
  });

  testWidgets('the pairing view shows the code and opens Zunia',
      (tester) async {
    final launched = <Uri>[];
    late FakeRelay relay;
    late ZuniaConnectClient client;
    await tester.runAsync(() => HttpOverrides.runWithHttpOverrides(() async {
          relay = await FakeRelay.start();
          client = ZuniaConnectClient(
            metadata:
                const ZuniaDappMetadata(name: 'Test', url: 'https://a.example'),
            apiBase: relay.apiBase,
            returnUrl: 'myapp://back',
            observeAppLifecycle: false,
            launcher: (uri) async {
              launched.add(uri);
              return true;
            },
          );
          final pairing = client.pairings.first;
          client.connect(chains: ['cosmoshub-4']).ignore();
          await pairing.timeout(const Duration(seconds: 10));
        }, _RealHttp()));
    await tester.pumpWidget(_host(ZuniaPairingView(client: client)));
    expect(find.text('Scan with Zunia on your phone'), findsOneWidget);
    expect(find.byType(ZuniaQrCode), findsOneWidget);
    expect(find.textContaining('Expires in'), findsOneWidget);

    await tester.tap(find.text('Open Zunia on this device'));
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(launched.single.queryParameters['ret'], 'myapp://back');

    await tester.runAsync(() async {
      client.dispose();
      await relay.close();
    });
    await tester.pumpWidget(const SizedBox());
  });
}
