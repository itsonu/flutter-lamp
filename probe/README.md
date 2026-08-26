# Probe apps

Two throwaway Flutter apps whose only job is to make a claim about a
state-management package checkable. They exist because the alternative is
writing a collector against an API someone assumed, and an integration that is
confidently wrong is worse than one that is missing.

| App | Package | What it proves |
| --- | --- | --- |
| `riverpod_probe` | `flutter_riverpod` | Riverpod posts `riverpod:new_event` on the `Extension` stream, payload `{offset: N}`, no `ext.riverpod.*` RPC |
| `bloc_probe` | `flutter_bloc` | Stock `bloc` posts nothing itself — no events, no `ext.bloc.*` RPC. A flutter_bloc app is still visible through `provider`, which it depends on transitively, but those events count notified dependents rather than transitions. See [EVIDENCE.md](EVIDENCE.md). |

Neither app needs to be tapped. Each runs a phased workload on a 20-second loop
(idle → state churn → rebuild storm → error → navigate; `bloc_probe` adds a
`crash` phase that throws inside `build`). `bloc_probe` also carries a second
workload, `flutter run --dart-define=scenario=incidental`, which produces a
harmless `RenderFlex overflowed` error and, three seconds later and from
different code, real build-bound jank — the two separated so a diagnosis can be
held to telling them apart. Each prints
`PROBE_PHASE <name>` before each phase, so an observed event can be attributed
to the thing that caused it. `bloc_probe` also prints `PROBE_TRANSITION` from a
`BlocObserver`, which is how "the transitions really happened and the VM Service
still saw nothing" is established rather than assumed.

`bloc_probe` deliberately installs no helper that posts to the VM Service. What
it exposes is what a stock Bloc app exposes.

## Re-running a measurement

Do this after upgrading `flutter_riverpod` or `flutter_bloc` — the findings in
`docs/Improvement-Plan.md` are pinned to the versions above.

```bash
cd probe/riverpod_probe && flutter run -d <device-id>
```

Then, from the repo root (it uses this project's own `ws` dependency), with the
VM Service URI `flutter run` printed:

```bash
node probe/measure.mjs "ws://127.0.0.1:PORT/TOKEN=/ws" 70
```

It reports every registered `ext.*` RPC, then every event seen on the
`Extension`, `Logging` and `Debug` streams grouped by kind, with one sample
payload and the phases it occurred in.

If the output no longer matches what `docs/Improvement-Plan.md` records, the
collector in `src/collectors/stateCollector.ts` is the thing to change — not the
docs.

## Notes

- Gradle builds are slow; `flutter run --use-application-binary=build/app/outputs/flutter-apk/app-debug.apk` reuses an existing debug APK.
- The apps are excluded from the published npm package (`package.json` `files`
  is an allowlist) and their build output is gitignored.

## A correction worth reading

An earlier measurement here concluded Bloc was unobservable. It searched for
`bloc:`-prefixed extension kinds and `ext.bloc.*` RPCs, found neither, and
stopped. Both of those are genuinely absent, so the conclusion looked sound.

It was incomplete. `flutter_bloc` pulls in `provider` transitively, and
`provider` posts `provider:provider_changed`, so a flutter_bloc app is not
silent on the VM Service.

The correction then needed its own correction. "Bloc is observable" overstates
it: the probe emits ~61 provider events per transition, because
`stormWatchers = 60` widgets each watch the bloc. Provider events count
*dependent notifications*, not state changes, so Bloc transition counts cannot
be recovered from them, and Bloc itself remains uninstrumented.

Two lessons for anyone extending this harness. Measure the stream, not the
prefix you expected on it — absence of a name is not absence of a signal. And
when a signal does appear, check what its *volume* is a function of before
reporting the number as if it meant the thing you were looking for.

See [EVIDENCE.md](EVIDENCE.md) for the table, and `measure-bloc.mjs` to re-run it.
