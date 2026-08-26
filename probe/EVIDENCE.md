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
| `riverpod_probe`, flutter_riverpod 3.4.2, one 70s run | 98 `riverpod:new_event` on the `Extension` stream, all inside the tick/invalidate/throw phases, none in idle or navigate | **observed.** Riverpod announces provider activity, and the count tracks phases that touch providers | Single run. Phase attribution has not been repeated, so treat the exact figure as one example rather than an invariant |
| Payload inspection | `{offset: N}` and nothing else | **observed.** The event carries a buffer index, not state | The buffer lives in the app; the offset cannot be dereferenced from outside |
| `getIsolate.extensionRPCs` | 0 of 74 registered RPCs match `ext.riverpod.*` | **observed.** No service extension exists to resolve the offset | Provider names and values are therefore unavailable |

## Bloc

| Measurement | Observation | Interpretation | Limitation |
| --- | --- | --- | --- |
| `bloc_probe`, flutter_bloc 9.1.1 | Zero `bloc:`-prefixed extension events; zero `ext.bloc.*` RPCs | **observed.** Stock `bloc` posts nothing of its own to the VM Service | Its observability runs through `BlocObserver`, in-process, unreachable from outside |
| `probe/bloc_probe/pubspec.lock` | `provider` present as a transitive dependency of `flutter_bloc` | **documented.** flutter_bloc's lookup is provider-backed | A Bloc app that avoided provider-backed lookup would be silent here |
| `bloc_probe` run, Stdout + Extension on one socket | 20 `PROBE_TRANSITION` markers; ~1,220 `provider:provider_changed`; each burst follows a transition marker | **observed.** A flutter_bloc app is *not* silent on the VM Service | Ordering was read from one interleaved stream; a formal per-transition attribution has not been run |
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

## Not yet measured

- Whether every transition produces a provider burst, formally, with
  timestamps and per-transition attribution.
- Whether provider events also occur with no transition (e.g. from route
  changes or unrelated `ChangeNotifier`s).
- Whether the relationship is stable across repeated runs.

`probe/measure-bloc.mjs` exists to answer exactly these; see below. Until it has
been run, the ordering claim above rests on one observation.

## Reproducing

```bash
node probe/measure-bloc.mjs <vm-service-ws-uri> [runs]
```

Requires the probe app running on a connected device. It records transition
markers and provider events with timestamps on a single socket — ordering is
then a property of one stream rather than of two clocks — and prints per-run
counts plus the derived events-per-transition ratio.
