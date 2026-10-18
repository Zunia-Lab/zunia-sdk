// Connect to Zunia by QR code or on the same phone, then sign a message.
//
// Run it on a tablet, a desktop or the web and scan the code with Zunia on a
// phone, or run it on the phone that has Zunia and tap "Open Zunia on this
// device". Register `zuniaexample://` in the Android manifest and the iOS
// Info.plist to come back here after approving (see the package README).
import 'package:flutter/material.dart';
import 'package:zunia_sdk/zunia_sdk.dart';

void main() => runApp(const ExampleApp());

const _chain = 'cosmoshub-4';

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Zunia example',
        theme: ThemeData(colorSchemeSeed: const Color(0xFFFF6A10)),
        darkTheme: ThemeData(
            colorSchemeSeed: const Color(0xFFFF6A10),
            brightness: Brightness.dark),
        home: const HomePage(),
      );
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  // In a real app pass a storage backed by flutter_secure_storage, so the
  // session survives a restart: the saved record holds its keys.
  final _zunia = ZuniaConnectClient(
    metadata: const ZuniaDappMetadata(
      name: 'Zunia example',
      url: 'https://docs.zunialab.com',
      description: 'Signs a message with your Cosmos Hub account.',
    ),
    returnUrl: 'zuniaexample://zunia',
  );
  String? _signature;

  @override
  void initState() {
    super.initState();
    _zunia.restore(chains: [_chain]);
  }

  @override
  void dispose() {
    _zunia.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final sheet = showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ZuniaPairingView(
            client: _zunia,
            onNotInstalled: ZuniaLinks.openInstallPage,
          ),
        ),
      ),
    );
    try {
      await _zunia.connect(chains: [_chain]);
    } on ZuniaConnectException catch (error) {
      _show(explainZuniaError(error).message);
    } finally {
      if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
    }
    await sheet;
  }

  Future<void> _sign() async {
    final account = _zunia.accounts.first;
    try {
      final signature = await _zunia.signArbitrary(
          _chain, account.address, 'Hello from the Zunia example');
      setState(() => _signature = signature.signature);
    } on ZuniaConnectException catch (error) {
      _show(explainZuniaError(error).message);
    }
  }

  void _show(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Zunia example')),
      body: ListenableBuilder(
        listenable: _zunia,
        builder: (context, _) {
          if (!_zunia.isConnected) {
            return Center(
              child: ConnectWithZuniaButton(
                busy: _zunia.status == ZuniaSessionStatus.connecting,
                onPressed: _connect,
              ),
            );
          }
          final account = _zunia.accounts.first;
          return ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(account.name ?? 'Account',
                  style: Theme.of(context).textTheme.titleMedium),
              SelectableText(account.address),
              const SizedBox(height: 8),
              Text(
                  _zunia.walletOnline ? 'Zunia is online' : 'Zunia is offline'),
              const SizedBox(height: 24),
              FilledButton(
                  onPressed: _sign, child: const Text('Sign a message')),
              if (_signature != null) ...[
                const SizedBox(height: 16),
                SelectableText('Signature: $_signature'),
              ],
              const SizedBox(height: 24),
              OutlinedButton(
                onPressed: () => _zunia.disconnect(),
                child: const Text('Disconnect'),
              ),
            ],
          );
        },
      ),
    );
  }
}
