# jank_probe

A desktop Flutter app that exists to be janky, for testing flutter-lamp's
GC/jank correlation against a real Dart VM rather than fixtures.

```
flutter run -d windows --vm-service-port=8181
```

The window must be visible. Flutter stops producing frames when it is
minimised, and a capture then returns zero frames while GC events keep
arriving — which is itself worth knowing, and is what the first run here hit.

## What it does, and why that shape

It renders continuously (an `AnimationController` on repeat) so frame spans
cover most of the wall clock and a collection has somewhere to land. It holds
~6M small objects as permanent ballast, so any old-generation mark is
expensive, and keeps a few frames' worth of young objects alive, so scavenges
have to *copy* rather than drop.

What it deliberately does **not** do is sleep or busy-wait in `build()`. Jank
manufactured that way is jank GC merely coincides with — the exact false
positive the correlation is built to refuse.

## Making the positive path fire

Allocation pressure alone did not do it. Across three probe designs the
association stayed under the 2x gate (1.78x, 1.55x, and one clean negative),
because allocation inflates build time and GC time together — the base rate
rises with the jank.

`tool/force_gc.mjs` drives full collections through the VM Service while the
app renders, so the cause of a late frame is known by construction:

```
node tool/force_gc.mjs http://127.0.0.1:8181/<token>/ 45 1200
```

With 200-300ms pauses landing in a lightly loaded app, the finding fires at
3.5x-44x over the base rate. Two contradictions in the reported payload were
found this way and are covered by tests in `src/diagnosis/gcCorrelation.test.ts`.
