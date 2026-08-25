# Probe apps

Two throwaway Flutter apps whose only job is to make a claim about a
state-management package checkable. They exist because the alternative is
writing a collector against an API someone assumed, and an integration that is
confidently wrong is worse than one that is missing.

| App | Package | What it proves |
| --- | --- | --- |
| `riverpod_probe` | `flutter_riverpod` | Riverpod posts `riverpod:new_event` on the `Extension` stream, payload `{offset: N}`, no `ext.riverpod.*` RPC |
| `bloc_probe` | `flutter_bloc` | Stock Bloc posts **nothing** to the VM Service — 143 real transitions, zero events |

Neither app needs to be tapped. Each runs a five-phase workload on a 20-second
loop (idle → state churn → rebuild storm → error → navigate) and prints
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
