// A Flutter app whose only job is to be janky *because of garbage collection*.
//
// The point is to exercise flutter-lamp's GC/jank correlation against a real
// Dart VM, on the positive side: frames must be continuous (so frame coverage
// is near 100% and a collection has somewhere to land) and the late frames must
// be caused by allocation, not by artificial busy-work. Sleeping in build()
// would produce jank that GC merely coincides with — the exact false positive
// the correlation is supposed to refuse.
//
// So: allocate hard every frame, retain a rolling window of it to force
// promotion into old space, and let the collector do the rest.
import 'dart:math';

import 'package:flutter/material.dart';

void main() => runApp(const JankProbe());

class JankProbe extends StatelessWidget {
  const JankProbe({super.key});

  @override
  Widget build(BuildContext context) =>
      const MaterialApp(home: Scaffold(body: Churn()));
}

class Churn extends StatefulWidget {
  const Churn({super.key});

  @override
  State<Churn> createState() => _ChurnState();
}

/** A small object with a reference: marking cost scales with object count and
 * pointer chasing, not with bytes. A few million of these make every
 * old-generation mark expensive, which is what turns a collection into a pause
 * long enough to miss a frame. */
class _Node {
  _Node(this.next, this.n);
  final _Node? next;
  final int n;
}

class _ChurnState extends State<Churn> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  )..repeat();

  // Built once and never released. Per-frame allocation stays cheap, so build
  // time is not inflated by the allocation itself — when a frame goes late it
  // is because the collector had to walk this, not because build() did work.
  late final List<_Node> _ballast = _buildBallast();

  // Retained across frames, so the chunks survive a scavenge and get promoted.
  // Promotion is what forces old-generation collections; those are the long
  // ones that overlap a frame long enough to be visible as jank.
  final _retained = <List<double>>[];
  // Young objects deliberately kept alive across a few frames: scavenge fodder
  // that must be copied rather than dropped.
  final _survivors = <List<_Node>>[];
  int _frames = 0;

  static List<_Node> _buildBallast() {
    final roots = <_Node>[];
    for (var r = 0; r < 300; r++) {
      _Node? head;
      for (var i = 0; i < 20000; i++) {
        head = _Node(head, i);
      }
      roots.add(head!);
    }
    return roots; // ~6M live objects
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _allocate() {
    _frames++;
    if (_ballast.isEmpty) return; // touch the ballast so it cannot be elided
    // A scavenge costs what it has to *copy*, not what it can drop. Objects that
    // die in the nursery are free; objects still alive when the scavenge runs
    // get copied one by one. So hold a few frames' worth of small objects alive
    // — every young collection then has to move hundreds of thousands of them,
    // which is a pause, not a tick.
    final batch = <_Node>[];
    _Node? head;
    for (var i = 0; i < 2000; i++) {
      head = _Node(head, i);
      batch.add(head);
    }
    _survivors.add(batch);
    while (_survivors.length > 8) {
      _survivors.removeAt(0);
    }
    _retained.add(List<double>.filled(8 * 1024, 1.0));
    while (_retained.length > 400) {
      _retained.removeAt(0);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, _) {
      _allocate();
      return CustomPaint(
        painter: _Spin(_c.value, _retained.length),
        size: Size.infinite,
        child: Center(
          child: Text(
            'frames $_frames · live ${_retained.length}',
            style: const TextStyle(color: Colors.white, fontSize: 24),
          ),
        ),
      );
    },
  );
}

class _Spin extends CustomPainter {
  _Spin(this.t, this.live);

  final double t;
  final int live;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.black);
    final centre = size.center(Offset.zero);
    final paint = Paint()..strokeWidth = 3;
    for (var i = 0; i < 60; i++) {
      final a = t * 2 * pi + i * pi / 30;
      paint.color = HSVColor.fromAHSV(1, (i * 6 + t * 360) % 360, 1, 1).toColor();
      canvas.drawLine(
        centre,
        centre + Offset(cos(a), sin(a)) * (size.shortestSide / 2),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_Spin old) => old.t != t || old.live != live;
}
