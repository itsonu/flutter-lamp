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
//   5. navigate    — push /detail, pop back
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// Marker printed to stdout so the probe can correlate stream events to phases.
void phase(String name) => debugPrint('PROBE_PHASE $name');

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

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
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

    await _phase('navigate', const Duration(seconds: 2), () async {
      await Navigator.of(context).pushNamed('/detail');
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
