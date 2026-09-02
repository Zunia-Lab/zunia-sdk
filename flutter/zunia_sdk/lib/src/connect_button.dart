import 'package:flutter/widgets.dart';

/// Official sizes for [ConnectWithZuniaButton].
enum ConnectWithZuniaButtonSize { small, medium, large }

/// Official Connect with Zunia button for Flutter dApps and companion apps.
///
/// Matches the web SDK: white mark on the chevron accent gradient.
class ConnectWithZuniaButton extends StatelessWidget {
  const ConnectWithZuniaButton({
    super.key,
    required this.onPressed,
    this.size = ConnectWithZuniaButtonSize.medium,
    this.busy = false,
    this.label = 'Connect with Zunia',
  });

  final VoidCallback? onPressed;
  final ConnectWithZuniaButtonSize size;
  final bool busy;
  final String label;

  double get _height => switch (size) {
        ConnectWithZuniaButtonSize.small => 30,
        ConnectWithZuniaButtonSize.medium => 44,
        ConnectWithZuniaButtonSize.large => 52,
      };

  double get _fontSize => switch (size) {
        ConnectWithZuniaButtonSize.small => 12,
        ConnectWithZuniaButtonSize.medium => 14,
        ConnectWithZuniaButtonSize.large => 16,
      };

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            begin: Alignment(-0.6, -0.8),
            end: Alignment(0.8, 0.9),
            colors: [
              Color(0xFFFF1B0C),
              Color(0xFFFF6A10),
              Color(0xFFFFC414),
            ],
            stops: [0, 0.5, 1],
          ),
          borderRadius: BorderRadius.circular(14),
          boxShadow: enabled
              ? const [
                  BoxShadow(
                    color: Color(0x47FF2D1F),
                    blurRadius: 28,
                    offset: Offset(0, 12),
                  ),
                ]
              : null,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints.tightFor(height: _height),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: enabled ? onPressed : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (busy)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: _SpinMark(),
                    )
                  else
                    const CustomPaint(
                      size: Size(16, 20),
                      painter: _ZuniaMarkPainter(),
                    ),
                  const SizedBox(width: 10),
                  Text(
                    label,
                    style: TextStyle(
                      color: const Color(0xFFFFFFFF),
                      fontSize: _fontSize,
                      fontWeight: FontWeight.w500,
                      letterSpacing: -0.2,
                      fontFamily: 'Space Grotesk',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ZuniaMarkPainter extends CustomPainter {
  const _ZuniaMarkPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = Paint()
      ..color = const Color(0xFFFFFFFF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * (24 / 96)
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    // Scale 96x120 grid into size.
    final sx = size.width / 96;
    final sy = size.height / 120;
    Offset p(double x, double y) => Offset(x * sx, y * sy);

    final upper = Path()
      ..moveTo(p(26, 20).dx, p(26, 20).dy)
      ..lineTo(p(70, 46).dx, p(70, 46).dy)
      ..lineTo(p(26, 72).dx, p(26, 72).dy);
    final lower = Path()
      ..moveTo(p(26, 48).dx, p(26, 48).dy)
      ..lineTo(p(70, 74).dx, p(70, 74).dy)
      ..lineTo(p(26, 100).dx, p(26, 100).dy);

    canvas.saveLayer(Offset.zero & size, Paint());
    canvas.drawPath(lower, stroke);
    // Cut gap through lower where upper sits.
    final cut = Paint()
      ..blendMode = BlendMode.clear
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * (30 / 96)
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(upper, cut);
    canvas.restore();
    canvas.drawPath(upper, stroke);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _SpinMark extends StatefulWidget {
  const _SpinMark();

  @override
  State<_SpinMark> createState() => _SpinMarkState();
}

class _SpinMarkState extends State<_SpinMark>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Transform.rotate(
          angle: _controller.value * 6.283185307179586,
          child: child,
        );
      },
      child: CustomPaint(
        size: const Size(12, 12),
        painter: _RingPainter(),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0x38FFFFFF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawCircle(
      Offset(size.width / 2, size.height / 2),
      size.width / 2 - 1,
      paint,
    );
    final tip = Paint()
      ..color = const Color(0xFFFFFFFF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(
        center: Offset(size.width / 2, size.height / 2),
        radius: size.width / 2 - 1,
      ),
      -1.5708,
      1.2,
      false,
      tip,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
