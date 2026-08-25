// Riverpod probe app for flutter-lamp.
//
// Purpose: emit a known, repeatable Riverpod workload so the MCP server's
// collectors can be measured against real runtime instead of an assumed API.
// The workload runs itself on a timer — no taps, no adb input coordination —
// and prints a marker line before each phase so a probe script can line up
// what it observed on the VM Service streams with what the app actually did.
//
// Phases, one cycle (~20s), repeating:
//   1. idle                — baseline, nothing should be posted
//   2. tick x20            — one provider changing fast, few watchers
//   3. invalidate          — one provider changing once, many watchers (storm)
//   4. throw               — a provider whose build() throws
//   5. navigate            — push /detail, pop back
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Marker printed to stdout so the probe can correlate stream events to phases.
void phase(String name) => debugPrint('PROBE_PHASE $name');

/// Changes fast; watched by a handful of widgets.
class TickNotifier extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state = state + 1;
}

final tickProvider = NotifierProvider<TickNotifier, int>(TickNotifier.new);

/// Changes rarely; watched by [stormWatchers] widgets, so one invalidation
/// produces a rebuild storm — the shape this project wants to correlate.
const stormWatchers = 60;
final stormProvider = Provider<int>((ref) => DateTime.now().millisecondsSinceEpoch);

/// Builds by throwing, on demand.
final failingProvider = Provider<int>((ref) {
  throw StateError('riverpod_probe: deliberate provider failure');
});

/// Async provider that fails after a delay, to separate sync build failures
/// from async ones on whatever stream carries them.
final failingFutureProvider = FutureProvider<int>((ref) async {
  await Future<void>.delayed(const Duration(milliseconds: 50));
  throw StateError('riverpod_probe: deliberate async provider failure');
});

void main() => runApp(const ProviderScope(child: ProbeApp()));

class ProbeApp extends StatelessWidget {
  const ProbeApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'riverpod_probe',
        routes: {
          '/': (_) => const HomeScreen(),
          '/detail': (_) => const DetailScreen(),
        },
      );
}

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  Timer? _cycle;
  String _current = 'starting';

  @override
  void initState() {
    super.initState();
    _cycle = Timer.periodic(const Duration(seconds: 20), (_) => _runCycle());
    Future<void>.delayed(const Duration(seconds: 3), _runCycle);
  }

  @override
  void dispose() {
    _cycle?.cancel();
    super.dispose();
  }

  Future<void> _runCycle() async {
    if (!mounted) return;

    await _phase('idle', const Duration(seconds: 3), () async {});

    await _phase('tick', const Duration(seconds: 3), () async {
      for (var i = 0; i < 20; i++) {
        ref.read(tickProvider.notifier).increment();
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    });

    await _phase('invalidate', const Duration(seconds: 3), () async {
      for (var i = 0; i < 3; i++) {
        ref.invalidate(stormProvider);
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
    });

    await _phase('throw', const Duration(seconds: 2), () async {
      try {
        ref.read(failingProvider);
      } catch (_) {
        // Read again through the framework so the error also surfaces the way
        // a widget would hit it.
      }
      ref.read(failingFutureProvider);
      await Future<void>.delayed(const Duration(milliseconds: 500));
      ref.invalidate(failingFutureProvider);
    });

    await _phase('navigate', const Duration(seconds: 2), () async {
      final navigator = Navigator.of(context);
      await navigator.pushNamed('/detail');
    });
  }

  Future<void> _phase(String name, Duration budget, Future<void> Function() body) async {
    if (!mounted) return;
    phase(name);
    setState(() => _current = name);
    final started = DateTime.now();
    await body();
    final left = budget - DateTime.now().difference(started);
    if (left > Duration.zero) await Future<void>.delayed(left);
  }

  @override
  Widget build(BuildContext context) {
    final tick = ref.watch(tickProvider);
    return Scaffold(
      appBar: AppBar(title: Text('riverpod_probe — $_current')),
      body: Column(
        children: [
          Padding(padding: const EdgeInsets.all(16), child: Text('tick: $tick')),
          ElevatedButton(onPressed: _runCycle, child: const Text('run cycle now')),
          Expanded(
            child: GridView.count(
              crossAxisCount: 6,
              children: List.generate(stormWatchers, (i) => _StormCell(index: i)),
            ),
          ),
        ],
      ),
    );
  }
}

/// One of [stormWatchers] widgets watching the same provider, so invalidating
/// it rebuilds all of them in a single frame.
class _StormCell extends ConsumerWidget {
  const _StormCell({required this.index});

  final int index;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(stormProvider);
    return Center(child: Text('$index:${value % 100}', style: const TextStyle(fontSize: 10)));
  }
}

class DetailScreen extends ConsumerWidget {
  const DetailScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Pop itself so the cycle needs no input.
    Future<void>.delayed(const Duration(seconds: 1), () {
      if (context.mounted) Navigator.of(context).maybePop();
    });
    return Scaffold(
      appBar: AppBar(title: const Text('detail')),
      body: Center(child: Text('tick was ${ref.watch(tickProvider)}')),
    );
  }
}
