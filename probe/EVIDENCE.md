# State-management evidence

What has actually been measured about state-management observability, how, and
what each measurement does and does not establish.

Every row is one of four kinds:

| Kind | Meaning |
| --- | --- |
| **observed** | Seen directly on a running app, with counts |
| **inferred** | Follows from observation plus arithmetic, not seen directly |
| **documented** | Framework/package behaviour read from source or lockfile |
| **assumption** | Believed, not established — none should appear below |

## Riverpod

| Measurement | Observation | Interpretation | Limitation |
| --- | --- | --- | --- |
| `riverpod_probe`, flutter_riverpod 3.4.2, two independent 70s runs | 98 then 100 `riverpod:new_event` on the `Extension` stream. Both runs: all events inside the tick/invalidate/throw phases, **none** in idle or navigate | **observed, reproduced.** Riverpod announces provider activity, and the count tracks the phases that touch providers | The count is workload-dependent, so 98/100 is the probe's rate, not Riverpod's. The *phase attribution* is what reproduced |
| Payload inspection | `{offset: N}` and nothing else | **observed.** The event carries a buffer index, not state | The buffer lives in the app; the offset cannot be dereferenced from outside |
| `getIsolate.extensionRPCs` | 0 of 74 registered RPCs match `ext.riverpod.*` | **observed.** No service extension exists to resolve the offset | Provider names and values are therefore unavailable |

## Bloc

| Measurement | Observation | Interpretation | Limitation |
| --- | --- | --- | --- |
| `bloc_probe`, flutter_bloc 9.1.1 | Zero `bloc:`-prefixed extension events; zero `ext.bloc.*` RPCs | **observed.** Stock `bloc` posts nothing of its own to the VM Service | Its observability runs through `BlocObserver`, in-process, unreachable from outside |
| `probe/bloc_probe/pubspec.lock` | `provider` present as a transitive dependency of `flutter_bloc` | **documented.** flutter_bloc's lookup is provider-backed | A Bloc app that avoided provider-backed lookup would be silent here |
| `bloc_probe`, 3 runs of 25s, Stdout + Extension on one socket (`measure-bloc.mjs`) | 35/25/20 transitions against 2,120/1,540/1,220 provider events | **observed, reproduced.** A flutter_bloc app is *not* silent on the VM Service | Read from one interleaved stream, so ordering is a property of one clock |
| Per-transition attribution, same 3 runs | **80 of 80 transitions** had a provider burst within 1s: 35/35, 25/25, 20/20 | **observed.** Every Bloc transition does produce provider notifications | A 1s window cannot show the transition came *first*; it shows they co-occur |
| Events per transition, same 3 runs | 60.6, 61.6, 61.0 | **observed, reproduced.** Stable across runs, and it matches `stormWatchers = 60` | Confirms the count is a function of watcher count, not of state changes |
| Provider events with no Bloc transition, same 3 runs | 20 per run, in all three | **observed.** The probe's `BlocObserver` overrides `onTransition` (Bloc) and `onError`, **not** `onChange` — so `CounterCubit` changes notify provider dependents while printing no `PROBE_TRANSITION` | Provider events are not Bloc-transition events even inside a flutter_bloc app: a Cubit produces them too |
| `probe/bloc_probe/lib/main.dart` | `stormWatchers = 60`, each a `BlocBuilder<CounterBloc, int>` | **documented.** 60 widgets depend on the bloc | — |
| 20 transitions × 60 watchers ≈ 1,200 vs ~1,220 observed | Ratio ≈ 61 events per transition | **inferred.** `provider:provider_changed` fires once per *dependent notified*, not once per transition | **Bloc transition counts cannot be derived from provider event counts.** The event volume is a function of how many widgets watch |

### What the Bloc rows jointly establish

- There is no `ext.bloc.*` VM Service RPC. *(observed)*
- `flutter_bloc` 9.1.1 depends transitively on `provider`. *(documented)*
- `provider` emits `provider:provider_changed`. *(observed)*
- Therefore a Bloc application on that dependency path exposes state-*related*
  activity indirectly, through provider. *(inferred)*

### What they do not establish

- That Bloc internals — transitions, events, states, errors — are directly
  observable. They are not.
- That Bloc is natively instrumented for the VM Service. It is not.
- That provider event counts measure Bloc activity. They measure notified
  dependents, and the two differ by the number of watching widgets.

## Measured since (2026-08-26, device A015, Android 16, Flutter 3.44.1)

The three open questions have been answered by running `measure-bloc.mjs`, and
the Riverpod phase attribution has a second independent run. All four rows above
are marked *reproduced* accordingly.

- **Does every transition produce a burst?** Yes. 80 of 80 across three runs.
- **Do provider events occur with no transition?** Yes, ~20 per run — and the
  cause is identifiable rather than mysterious: `Cubit` fires `onChange`, not
  `onTransition`, so the probe never prints a marker for it while provider still
  notifies. This *strengthens* the limitation: even within a flutter_bloc app,
  provider events are not a Bloc-transition signal.
- **Is the relationship stable?** Yes. 60.6 / 61.6 / 61.0 events per transition.
- **Native bloc events?** Still zero, and `ext.bloc.*` RPCs still absent — a
  third independent confirmation, now on Flutter 3.44.1.

## Still not measured

- Whether the ratio holds at a different `stormWatchers` count. It should, by
  the mechanism, but the prediction has not been tested by varying it.
- Any framework other than Riverpod, Provider and Bloc.
- Behaviour in profile or release mode. Everything here is debug.

## Reproducing

```bash
node probe/measure-bloc.mjs <vm-service-ws-uri> [runs]
```

Requires the probe app running on a connected device. It records transition
markers and provider events with timestamps on a single socket — ordering is
then a property of one stream rather than of two clocks — and prints per-run
counts plus the derived events-per-transition ratio.
