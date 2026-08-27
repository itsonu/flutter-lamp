// Bloc probe app for flutter-lamp.
//
// Purpose: emit a known, repeatable bloc/cubit workload so the MCP server can
// be measured against a real Bloc app. Nothing in `bloc` or `flutter_bloc` is
// known to post to the VM Service `Extension` stream — that is exactly the
// question this app exists to answer, so it deliberately does NOT install any
// helper that would post events itself. Whatever a probe script sees here is
// what a stock Bloc app gives us.
//
// Phases, one cycle (~20s), repeating:
//   1. idle        — baseline
//   2. events x20  — fast state transitions through a Bloc
//   3. cubit       — the same through a Cubit, to see if the two differ
//   4. error       — an event handler that throws (onError / addError)
//   5. crash       — a widget that throws during build (uncaught by the app)
//   6. navigate    — push /detail, pop back
//
// Or, with `--dart-define=scenario=incidental`, a second workload built to
// separate "an exception happened" from "the exception is the fault":
//   1. idle        — baseline
//   2. overflow    — a RenderFlex overflow: a real framework-reported error
//                    that breaks nothing
//   3. gap         — nothing at all, so the error cannot be correlated forward
//   4. slow        — expensive work inside build(), the actual fault
//   5. idle        — baseline again
//
// Or, with `--dart-define=scenario=network`, HTTP traffic against
// `probe/flaky-server.mjs` (start it first):
//   1. idle        — baseline
//   2. requests    — alternating 200s and 500s, no other fault in the session
//   3. idle        — baseline again
//
// Or, with `--dart-define=scenario=memory`, retention the heap cannot reclaim:
//   1. idle        — baseline
//   2. retain      — allocate and keep referencing, in small steady steps
//   3. idle        — baseline again, still holding everything
//
// Or, with `--dart-define=scenario=idle`, nothing at all: no timer, no
// workload. A running app with nothing wrong and nothing happening, which is a
// different reason for a diagnosis to answer "unknown" than a signal sitting
// under its threshold.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// Marker printed to stdout so the probe can correlate stream events to phases.
void phase(String name) => debugPrint('PROBE_PHASE $name');

/// Which workload this build runs: `crash` or `incidental`.
///
/// Selected at compile time rather than by a runtime toggle so that one probe
/// reproduces two recorded incidents without either contaminating the other —
/// an uncaught build failure in the same session as an incidental error would
/// make it impossible to argue which one the diagnosis should have picked.
const scenario = String.fromEnvironment('scenario', defaultValue: 'crash');

sealed class CounterEvent {
  const CounterEvent();
}

class Increment extends CounterEvent {
  const Increment();
}

class Boom extends CounterEvent {
  const Boom();
}

class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
    on<Boom>((event, emit) => throw StateError('bloc_probe: deliberate handler failure'));
  }
}

class CounterCubit extends Cubit<int> {
  CounterCubit() : super(0);

  void increment() => emit(state + 1);

  void boom() => addError(StateError('bloc_probe: deliberate cubit failure'), StackTrace.current);
}

/// Installed because a real app that cares about Bloc observability installs
/// one. It only logs — it posts nothing to the VM Service — so it does not
/// contaminate the measurement of what stock Bloc exposes.
class ProbeObserver extends BlocObserver {
  @override
  void onTransition(Bloc<dynamic, dynamic> bloc, Transition<dynamic, dynamic> transition) {
    super.onTransition(bloc, transition);
    // Only the default scenario prints these. `measure-bloc.mjs` counts the
    // markers, so they have to stay there — but it emits on a slow cycle, while
    // every other scenario ticks ten times a second and the markers become the
    // bulk of anything recorded, with nothing reading them.
    if (scenario != 'crash') return;
    debugPrint('PROBE_TRANSITION ${bloc.runtimeType} ${transition.event.runtimeType} '
        '${transition.currentState} -> ${transition.nextState}');
  }

  @override
  void onError(BlocBase<dynamic> bloc, Object error, StackTrace stackTrace) {
    debugPrint('PROBE_BLOC_ERROR ${bloc.runtimeType} $error');
    super.onError(bloc, error, stackTrace);
  }
}

void main() {
  Bloc.observer = ProbeObserver();
  runApp(const ProbeApp());
}

class ProbeApp extends StatelessWidget {
  const ProbeApp({super.key});

  @override
  Widget build(BuildContext context) => MultiBlocProvider(
        providers: [
          BlocProvider(create: (_) => CounterBloc()),
          BlocProvider(create: (_) => CounterCubit()),
        ],
        child: MaterialApp(
          title: 'bloc_probe',
          routes: {
            '/': (_) => const HomeScreen(),
            '/detail': (_) => const DetailScreen(),
          },
        ),
      );
}

/// Many widgets watching the same bloc, so one emit rebuilds all of them in a
/// single frame — the rebuild-storm shape to correlate against.
const stormWatchers = 60;

/// The incidental scenario keeps none. Its jank has to be attributable to one
/// identified place (an expensive `build`), and every extra watcher both muddies
/// that and multiplies the provider events in the recording — `provider` posts
/// one per notified dependent, so 60 watchers is 60x the fixture for no extra
/// evidence. The scenario's own cells provide the rebuild the ticks need.
int get watcherCount => scenario == 'crash' ? stormWatchers : 0;

/// Held for the lifetime of the `memory` scenario, so nothing here is garbage.
///
/// Strings and lists on purpose, not `Uint8List`: large typed data can be
/// accounted as *external* memory rather than Dart heap, and the diagnosis
/// reads `heapUsage`. Growth that lands in the wrong counter would prove
/// nothing.
final List<String> retained = <String>[];

/// Where the `network` scenario points. `probe/flaky-server.mjs` serves it.
const flakyServer = 'http://127.0.0.1:8477';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Timer? _cycle;
  String _current = 'starting';
  bool _overflowing = false;
  bool _slow = false;
  int _cycleCount = 0;

  @override
  void initState() {
    super.initState();
    // The idle scenario starts nothing on purpose. Flutter renders its first
    // frames and then stops, because nothing changes — which is exactly the
    // session worth recording: an app that is fine and quiet.
    if (scenario == 'idle') return;
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
    if (scenario == 'incidental') return _runIncidentalCycle();
    if (scenario == 'network') return _runNetworkCycle();
    if (scenario == 'memory') return _runMemoryCycle();
    final bloc = context.read<CounterBloc>();
    final cubit = context.read<CounterCubit>();

    await _phase('idle', const Duration(seconds: 3), () async {});

    await _phase('events', const Duration(seconds: 3), () async {
      for (var i = 0; i < 20; i++) {
        bloc.add(const Increment());
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    });

    await _phase('cubit', const Duration(seconds: 3), () async {
      for (var i = 0; i < 20; i++) {
        cubit.increment();
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    });

    await _phase('error', const Duration(seconds: 2), () async {
      bloc.add(const Boom());
      await Future<void>.delayed(const Duration(milliseconds: 500));
      cubit.boom();
    });

    await _phase('crash', const Duration(seconds: 2), () async {
      _CrashCell.armed = true;
      // Arming alone does nothing; the cell only rebuilds when the bloc emits.
      bloc.add(const Increment());
    });

    await _phase('navigate', const Duration(seconds: 2), () async {
      await Navigator.of(context).pushNamed('/detail');
    });
  }

  /// The workload that separates "an exception occurred" from "the exception is
  /// the fault".
  ///
  /// Every phase drives a cheap rebuild every 100ms. That is not decoration:
  /// Flutter renders nothing when nothing changes, so without it the only
  /// frames in the session are the expensive ones and the jank ratio is 100% by
  /// construction — a number that measures the workload's shape rather than the
  /// app's health. Ticking throughout means the session contains on-budget
  /// frames to compare against, including frames at the moment of the error.
  Future<void> _runIncidentalCycle() async {
    if (!mounted) return;
    final bloc = context.read<CounterBloc>();
    setState(() => _cycleCount++);

    // The whole cycle is deliberately short. Event delivery over an adb/WiFi
    // link is reliable for the first several seconds of a connection and then
    // starts stalling and flushing in bursts, which destroys the receipt-time
    // locality this scenario's evidence depends on. Everything worth recording
    // therefore has to fit in one short window.
    await _ticking('idle', 20, bloc);

    // A RenderFlex overflow is reported through `FlutterError.reportError` and
    // reaches the VM Service like any other framework error. It breaks nothing:
    // no ErrorWidget is substituted, the subtree keeps painting, and the app
    // keeps working. The cell is keyed by cycle because the overflow indicator
    // reports once per RenderObject lifetime — without a fresh key, only the
    // first cycle of a run ever produces the error.
    phase('overflow');
    setState(() {
      _current = 'overflow';
      _overflowing = true;
    });
    await _tick(8, bloc);
    if (mounted) setState(() => _overflowing = false);
    await _tick(7, bloc);

    // Three seconds of ordinary work between the error and the fault: wider
    // than the engine's 3s correlation window, so nothing can associate the two
    // by proximity alone.
    await _ticking('gap', 20, bloc);

    // The actual fault: real work on the UI thread inside build().
    setState(() => _slow = true);
    await _ticking('slow', 30, bloc);
    if (mounted) setState(() => _slow = false);

    await _ticking('idle', 10, bloc);
  }

  /// Steady, genuinely unreclaimable growth, and nothing else wrong.
  ///
  /// Allocated in small steps once per tick rather than in a few large bursts.
  /// A burst provokes a collection, and a collection shows up as a janky frame;
  /// the jank hypothesis outranks memory, so a session that stutters while
  /// growing would be answered `jank` and prove nothing about the heap.
  Future<void> _runMemoryCycle() async {
    if (!mounted) return;
    final bloc = context.read<CounterBloc>();

    await _ticking('idle', 20, bloc);

    phase('retain');
    if (mounted) setState(() => _current = 'retain');
    for (var step = 0; step < 300; step++) {
      // ~4k strings of ~60 bytes per tick: enough that the heap climbs
      // steadily, small enough that no single step is a visible pause.
      for (var i = 0; i < 4000; i++) {
        retained.add('retained-$step-$i-${'x' * 40}');
      }
      bloc.add(const Increment());
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }

    // Still holding every string. A heap that dropped back here would mean the
    // growth was collectable and the recording would be worthless.
    await _ticking('idle', 30, bloc);
  }

  /// HTTP traffic and nothing else wrong, so the only fault in the session is
  /// the one the server is returning.
  ///
  /// The ticks keep frames flowing at a cheap, on-budget rate: a session with no
  /// frames at all cannot show that the jank hypothesis declined to fire, only
  /// that it had nothing to look at.
  Future<void> _runNetworkCycle() async {
    if (!mounted) return;
    final bloc = context.read<CounterBloc>();

    await _ticking('idle', 20, bloc);

    phase('requests');
    if (mounted) setState(() => _current = 'requests');
    for (var i = 0; i < 8; i++) {
      // Alternating, so the recording contains healthy traffic as well. A
      // capture where every request failed cannot show that the collector
      // tells them apart.
      await _get(i.isEven ? '$flakyServer/api/health' : '$flakyServer/api/orders');
      await _tick(3, bloc);
    }

    await _ticking('idle', 20, bloc);
  }

  /// One request through `dart:io`, which is what the HTTP profile records.
  ///
  /// Errors are caught deliberately. An uncaught one would reach
  /// `FlutterError.reportError` and put an exception in a session whose whole
  /// point is that the network is the only thing wrong.
  Future<void> _get(String url) async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(Uri.parse(url));
      // Not a real credential. It is here so a recorded artifact proves the
      // header redaction actually runs at capture, rather than the claim
      // resting on a unit test alone.
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer probe-not-a-real-token');
      final response = await request.close();
      await response.drain<void>();
      debugPrint('PROBE_HTTP ${response.statusCode} $url');
    } catch (e) {
      debugPrint('PROBE_HTTP_FAILED $url $e');
    } finally {
      client.close();
    }
  }

  Future<void> _ticking(String name, int ticks, CounterBloc bloc) async {
    if (!mounted) return;
    phase(name);
    setState(() => _current = name);
    await _tick(ticks, bloc);
  }

  /// One cheap rebuild every 100ms. Each emit dirties the watching builders, so
  /// each tick costs a frame the frame timings can see.
  Future<void> _tick(int ticks, CounterBloc bloc) async {
    for (var i = 0; i < ticks && mounted; i++) {
      bloc.add(const Increment());
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
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
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('bloc_probe — $_current')),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: BlocBuilder<CounterCubit, int>(
                builder: (_, value) => Text('cubit: $value'),
              ),
            ),
            // Bounded on purpose: the framework substitutes an ErrorWidget for
            // the failed subtree, and an ErrorWidget in an unbounded Column
            // overflows and reports a *second*, unrelated framework error.
            if (scenario == 'crash') const SizedBox(height: 24, child: _CrashCell()),
            if (scenario == 'incidental') ...[
              SizedBox(
                height: 24,
                child: _OverflowCell(key: ValueKey(_cycleCount), overflowing: _overflowing),
              ),
              _SlowCell(spin: _slow),
            ],
            ElevatedButton(onPressed: _runCycle, child: const Text('run cycle now')),
            Expanded(
              child: GridView.count(
                crossAxisCount: 6,
                children: List.generate(watcherCount, (i) => _StormCell(index: i)),
              ),
            ),
          ],
        ),
      );
}

/// The one genuinely *uncaught* failure in this probe.
///
/// The bloc and cubit failures in the `error` phase are handed to
/// `BlocObserver.onError`, which is bloc catching its own error: nothing
/// reaches `FlutterError.onError`, so the VM Service never sees it. A throw
/// inside `build` is caught by the framework and reported through
/// `FlutterError.reportError`, which in debug posts a `Flutter.Error`
/// extension event — the shape of a real "this screen crashes" bug.
class _CrashCell extends StatelessWidget {
  const _CrashCell();

  /// Armed for exactly one build. The next transition rebuilds this subtree
  /// cleanly, so the app keeps producing its normal workload instead of
  /// sitting on a permanently broken screen.
  static bool armed = false;

  @override
  Widget build(BuildContext context) => BlocBuilder<CounterBloc, int>(
        builder: (_, value) {
          if (armed) {
            armed = false;
            throw StateError('bloc_probe: deliberate uncaught build failure');
          }
          return Text('crash cell ok ($value)', style: const TextStyle(fontSize: 10));
        },
      );
}

/// Overflows its 24px parent by ~400px while [overflowing], which makes the
/// rendering library report a `RenderFlex overflowed` error.
///
/// Deliberately the most boring framework error there is: it is a layout
/// complaint about a box that did not fit, it names no application code, and
/// the app carries on. Nothing here is expensive, so it cannot be the cause of
/// a frame budget miss.
class _OverflowCell extends StatelessWidget {
  const _OverflowCell({super.key, required this.overflowing});

  final bool overflowing;

  @override
  Widget build(BuildContext context) => Column(
        children: [
          const Text('layout', style: TextStyle(fontSize: 10)),
          if (overflowing) const SizedBox(height: 400, width: 10),
        ],
      );
}

/// Burns real UI-thread time inside `build` while [spin] is set.
///
/// A `Future.delayed` would not do: it yields, so the frame finishes on time
/// and the frame timings show nothing. This has to be synchronous work that
/// lands in the build phase, which is what `Flutter.Frame` measures.
class _SlowCell extends StatelessWidget {
  const _SlowCell({required this.spin});

  final bool spin;

  @override
  Widget build(BuildContext context) => BlocBuilder<CounterBloc, int>(
        builder: (_, value) {
          if (spin) {
            final until = DateTime.now().add(const Duration(milliseconds: 45));
            var acc = 0.0;
            var i = 0;
            while (DateTime.now().isBefore(until)) {
              acc += 1 / (++i);
            }
            // Consumed so the loop cannot be optimised away.
            return Text('slow $value (${acc.toStringAsFixed(2)})',
                style: const TextStyle(fontSize: 10));
          }
          return Text('fast $value', style: const TextStyle(fontSize: 10));
        },
      );
}

class _StormCell extends StatelessWidget {
  const _StormCell({required this.index});

  final int index;

  @override
  Widget build(BuildContext context) => BlocBuilder<CounterBloc, int>(
        builder: (_, value) =>
            Center(child: Text('$index:$value', style: const TextStyle(fontSize: 10))),
      );
}

class DetailScreen extends StatelessWidget {
  const DetailScreen({super.key});

  @override
  Widget build(BuildContext context) {
    Future<void>.delayed(const Duration(seconds: 1), () {
      if (context.mounted) Navigator.of(context).maybePop();
    });
    return Scaffold(
      appBar: AppBar(title: const Text('detail')),
      body: Center(
        child: BlocBuilder<CounterBloc, int>(builder: (_, v) => Text('count $v')),
      ),
    );
  }
}
