import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:qr/qr.dart';

import 'client.dart';
import 'connect_button.dart';
import 'types.dart';

/// A QR code for [data], drawn crisp at any size with a quiet zone phone
/// cameras read reliably.
class ZuniaQrCode extends StatelessWidget {
  /// Creates a QR code.
  const ZuniaQrCode({
    super.key,
    required this.data,
    this.size = 240,
    this.dark = const Color(0xFF000000),
    this.light = const Color(0xFFFFFFFF),
    this.margin = 4,
    this.semanticLabel = 'QR code',
  });

  /// What the code encodes, such as [ZuniaPairing.uri].
  final String data;

  /// Width and height.
  final double size;

  /// Module colour. Keep it much darker than [light].
  final Color dark;

  /// Background colour.
  final Color light;

  /// Quiet zone, in modules.
  final int margin;

  /// What screen readers announce.
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final code =
        QrCode.fromData(data: data, errorCorrectLevel: QrErrorCorrectLevel.M);
    return Semantics(
      label: semanticLabel,
      image: true,
      child: CustomPaint(
        size: Size.square(size),
        painter: _QrPainter(QrImage(code), dark, light, margin),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.image, this.dark, this.light, this.margin);

  final QrImage image;
  final Color dark;
  final Color light;
  final int margin;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    final module = size.shortestSide / (count + margin * 2);
    canvas.drawRect(Offset.zero & size, Paint()..color = light);
    final paint = Paint()
      ..color = dark
      ..isAntiAlias = false;
    final path = Path();
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (!image.isDark(row, col)) continue;
        path.addRect(Rect.fromLTWH(
          (col + margin) * module,
          (row + margin) * module,
          // A hair wider, so adjacent modules never show a seam.
          module + 0.5,
          module + 0.5,
        ));
      }
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _QrPainter oldDelegate) =>
      oldDelegate.image != image ||
      oldDelegate.dark != dark ||
      oldDelegate.light != light ||
      oldDelegate.margin != margin;
}

/// Everything a person needs while pairing: the QR code to scan with Zunia
/// on another phone, an "Open Zunia" button for this device, and the 6-digit
/// code to compare once Zunia has scanned.
///
/// Rebuilds from [client]; put it in a dialog or a bottom sheet while
/// [ZuniaConnectClient.connect] runs.
class ZuniaPairingView extends StatefulWidget {
  /// Creates a pairing view.
  const ZuniaPairingView({
    super.key,
    required this.client,
    this.qrSize = 232,
    this.showOpenButton = true,
    this.onNotInstalled,
    this.textStyle,
  });

  /// The client that is pairing.
  final ZuniaConnectClient client;

  /// QR code size.
  final double qrSize;

  /// Show "Open Zunia" for pairing on this device.
  final bool showOpenButton;

  /// Called when "Open Zunia" found no Zunia on this device. Show an install
  /// prompt, or call `ZuniaLinks.openInstallPage`.
  final VoidCallback? onNotInstalled;

  /// Base text style. Defaults to the ambient one.
  final TextStyle? textStyle;

  @override
  State<ZuniaPairingView> createState() => _ZuniaPairingViewState();
}

class _ZuniaPairingViewState extends State<ZuniaPairingView> {
  Timer? _tick;
  bool _opening = false;

  @override
  void initState() {
    super.initState();
    // Redraw the countdown once a second.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _open() async {
    setState(() => _opening = true);
    final opened = await widget.client.openZunia();
    if (!mounted) return;
    setState(() => _opening = false);
    if (!opened) widget.onNotInstalled?.call();
  }

  @override
  Widget build(BuildContext context) {
    final base = widget.textStyle ?? DefaultTextStyle.of(context).style;
    return ListenableBuilder(
      listenable: widget.client,
      builder: (context, _) {
        final client = widget.client;
        final pairing = client.pairing;
        final code = client.verificationCode;
        final children = <Widget>[];
        if (code != null && client.status != ZuniaSessionStatus.connected) {
          children.addAll([
            Text('Check that Zunia shows the same code',
                style: base, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            Semantics(
              label: 'Verification code ${code.split('').join(' ')}',
              child: ExcludeSemantics(
                child: Text(
                  '${code.substring(0, 3)} ${code.substring(3)}',
                  style: base.copyWith(
                    fontSize: 34,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 4,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text('Then approve in Zunia.',
                style: base.copyWith(color: base.color?.withValues(alpha: 0.7)),
                textAlign: TextAlign.center),
          ]);
        } else if (pairing != null) {
          final left = pairing.expiresAt.difference(DateTime.now());
          children.addAll([
            Text('Scan with Zunia on your phone',
                style: base, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: ZuniaQrCode(
                data: pairing.uri,
                size: widget.qrSize,
                semanticLabel: 'QR code to pair Zunia',
              ),
            ),
            const SizedBox(height: 8),
            Text(
              left.isNegative
                  ? 'This code expired'
                  : 'Expires in ${left.inMinutes}:${(left.inSeconds % 60).toString().padLeft(2, '0')}',
              style: base.copyWith(
                fontSize: (base.fontSize ?? 14) * 0.85,
                color: base.color?.withValues(alpha: 0.7),
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            if (widget.showOpenButton) ...[
              const SizedBox(height: 16),
              ConnectWithZuniaButton(
                label: 'Open Zunia on this device',
                busy: _opening,
                onPressed: _open,
              ),
            ],
          ]);
        } else {
          children.add(const SizedBox(
              height: 44, width: 44, child: Center(child: _Dots())));
        }
        return Column(mainAxisSize: MainAxisSize.min, children: children);
      },
    );
  }
}

class _Dots extends StatefulWidget {
  const _Dots();

  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 900))
    ..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color =
        DefaultTextStyle.of(context).style.color ?? const Color(0xFF888888);
    return Semantics(
      label: 'Preparing the pairing code',
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 3),
                child: Opacity(
                  opacity: ((_controller.value * 3 - i) % 3) < 1 ? 1 : 0.3,
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration:
                        BoxDecoration(color: color, shape: BoxShape.circle),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
