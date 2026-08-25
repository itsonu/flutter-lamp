# Changelog

All notable changes to Flutter Lamp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.17.0] - 2026-08-26

State-management observability - the P2 item that had been blocked on
measurement since 0.11.0, now measured and built to what the runtime actually
exposes.

### Added

- **`StateCollector`** - captures state-change activity from Riverpod, Provider
  and Bloc, in a new `state` category. Measured against live Riverpod and
  Provider/Bloc apps on a physical device rather than assumed:

      riverpod:new_event        { offset: 42 }
      provider:provider_changed { id: "0" }

  Both announce on the `Extension` stream; neither carries the state, and
  neither registers a service extension to resolve the pointer. Bloc is
  included by observation: flutter_bloc builds on provider, so a Bloc app's
  changes arrive as `provider:provider_changed`.
- **`diagnose_performance` correlates state churn with rebuild storms** - the
  question that motivated the feature. Against the live Bloc probe: *"2000
  provider state change(s) accompanied 10416 rebuild(s) across 59 frame(s) -
  about 33.9 state changes per rebuilding frame."* Scored as co-occurrence
  (0.55-0.7), never as cause.
- `what_changed` gains a `stateChanges` dimension, so a state burst shows up in
  the baseline comparison like any other signal.
- Collector health names the frameworks actually observed.

### Notes

**What this deliberately does not do is name a provider.** Values and provider
names are not obtainable through the VM Service, and reading them would need
eval-based introspection into package internals that breaks on every version
bump. The finding says how much state churned and when, points at the busiest
widget in your own code, and sends you to the DevTools provider/Bloc inspector
for the name. `limitations` states this on every run, and distinguishes "no
state-management activity observed" from "observed, but values unreadable" -
an app with no such package looks identical to one that simply has not changed
state.

Two earlier observations were resolved along the way. `Stdout` **does** work on
Android - the 0.16.0 note about missing log events was app-specific (the app
under test contained no print calls; the `I/flutter` lines came from other apps
sharing the device log). And a debug Flutter app announces its VM Service URI,
auth token included, to logcat at startup - so `flutter run` is not the only
source of a connectable URI, contrary to the limitation recorded in 0.15.0.
Automatic discovery from logcat is a follow-up, not in this release.

### Compatibility

Additive: a new `state` category in `runtime_status.byCategory`, retention and
coverage reports; a new dimension in `what_changed`; a new finding in
`diagnose_performance`. No tool renamed or reshaped.

## [0.16.0] - 2026-08-26

Fixes a bug that silently discarded the entire history of an already-running
app - the normal case for a tool that attaches to a live process.

### Fixed

- **Collectors subscribed before they listened.** The VM Service, through DDS,
  delivers a backlog of buffered stream events the instant a subscription is
  accepted, and that burst arrives before the continuation after
  `await streamListen` runs. Every collector registered its handler after
  subscribing, so every one of them dropped the burst. Measured on a physical
  device: 622 events with the handler registered first, 0 with it registered
  after. Connecting to an app that had been running for a few minutes captured
  nothing at all - `runtime_status` reported zeroes across every category while
  the app was demonstrably producing frames.

  All five collectors now register their handlers before subscribing. Verified
  live on the same session that had been returning nothing: 111 frames and 5
  rebuild events captured on connect, where the identical call had returned 0.

### Notes

Found while verifying that a debugging session survives unplugging the USB
cable. It did not, and chasing why exposed this instead - the failure had been
invisible because an idle app produces no live events, so an empty result
looked like a quiet app rather than a dropped backlog.

The regression test reproduces DDS's behaviour with a VM stand-in whose
`streamListen` flushes a backlog before resolving. Reverting any collector to
the old ordering fails it, which was checked rather than assumed.

Separately observed and left unexplained: on a physical Android device the VM
Service delivered no `Stdout`, `Stderr` or `Logging` events while the app was
emitting `I/flutter` lines to logcat, with handlers registered first. This is
consistent with Flutter routing `print` through the engine to logcat rather
than through the Dart VM's stdout, but the app's source was not available to
confirm which logging API it used, so no claim is made in `get_capabilities`
yet.

### Compatibility

No API change. Behaviour only: collectors now capture evidence that predates
the connection.

## [0.15.0] - 2026-08-25

Wireless transports. A debugging session should not end because a cable moved.

### Added

- **`ensure_tcp_device`** - reports Android device transports and recommends
  one, preferring wireless. Read-only by default; with `promote:true` it runs
  `adb tcpip` and `adb connect` to put a USB-attached device onto a TCP
  transport (declared mutating, since it restarts adbd on the device; needs the
  cable once and not afterwards; reversible with `adb usb`).
- **`connect_vm` explains failures in transport terms.** A bare
  `ECONNREFUSED` tells an agent nothing actionable, so a failed connect now
  also reports whether adb sees a device at all - distinguishing "the device
  dropped off adb" from "the transport is up, the app is not running" - and
  flags when every transport is USB.
- **Reconnection says why it gave up.** After exhausting its attempts the
  manager records the same transport diagnosis alongside the attempt count.
- `get_capabilities` reports `transports`, and lists adb device transports
  among what the server can observe.

### Notes

Wireless is preferred because it is measurably more durable: a `flutter run`
started on a TCP transport keeps its VM Service tunnel when the cable is
removed, and one started on USB does not. Verified on a physical device by
dropping every USB-owned forward mid-session and confirming the VM Service
stayed reachable.

A stable `ip:port` is recommended over an Android 11+ mDNS serial when both
exist for the same device: mDNS serials are regenerated and cannot be dialled
again by address.

Entirely optional and Android-only. With no adb installed the report is
`adbAvailable:false` with a note that iOS, desktop and web targets are
unaffected - an absent capability, never a broken setup. adb is invoked with
`execFile` and argument arrays rather than a shell, and every serial is
validated before use, because serials arrive from tool input as well as from
adb's own output.

### Compatibility

Additive: one new tool, plus `transport` on a failed `connect_vm` and
`transports` in `get_capabilities`. No existing tool renamed or reshaped.

## [0.14.0] - 2026-08-25

Timeline honesty. The planned timeline/GC collector was killed by its own
pre-build verification; what shipped is the guard that measurement demanded.

### Added

- **`get_timeline` reports recorder staleness.** Measured live on a physical
  Android device: the VM's "Ring" timeline recorder stalls silently once its
  buffer fills (~24,500 events - under a minute of Dart+GC recording), while
  `getVMTimelineFlags` keeps reporting the streams as recorded.
  `clearVMTimeline` restores recording, but nothing detects the stall for
  you - until now `get_timeline` would happily return minutes-old events as
  if they were current. The result now carries `recorderLagMs` (the gap
  between the VM's timeline clock and the newest event) and, past 30s of lag,
  `stalled: true` with a warning written for the agent.

### Notes

The planned `TimelineCollector` (GC correlation for `diagnose_performance`,
stored monotonic timestamps) is deferred, with the measured facts recorded in
`docs/Observability-Roadmap.md`: clear-on-stall self-healing makes a collector
possible, but a source that lies about its own liveness needs a soak test on a
real device before diagnosis is allowed to depend on it. GC correlation remains
a stated limitation until then. One probe conclusion was corrected along the
way - an earlier read said nothing revives the recorder; a later live check
showed `clearVMTimeline` does.

### Compatibility

Additive: `recorderLagMs`, `stalled` and (when stalled) `warning` on
`get_timeline`. No tool renamed or reshaped.

## [0.13.0] - 2026-08-25

Baseline comparison. "What changed before the failure" answered as a
measurement, not a listing.

### Added

- **`what_changed` compares the incident window against the equal window
  before it.** A new `comparison` block reports per-dimension changes -
  exceptions, network volume, network failures, latency p50/p95, jank ratio,
  log errors and warnings, heap - each with baseline value, incident value, a
  direction (`new` / `spiked` / `increased` / `decreased` / `unknown`) and
  citable incident evidence, the latency dimensions citing the single slowest
  request so the agent can inspect the concrete offender rather than trust a
  percentile over a small sample.
- `spiked` means at least 3x baseline - a documented policy threshold, like the
  diagnosis engine's 70%, chosen so ordinary jitter reads as `increased`.
- **Uncovered baselines are never compared against silence.** When observation
  began after the baseline window opened - session started later, or retention
  dropped it - `baselineCovered` is false, directions become `unknown`, and a
  note says why. Without this, every count in a young session would read as
  "new".
- Unchanged and doubly-empty dimensions are omitted: it is a list of changes.
- `src/diagnosis/stats.ts` - the percentile/mean/round helpers, extracted from
  the performance module so window comparison and performance diagnosis cannot
  drift onto disagreeing percentile definitions.

### Compatibility

Purely additive: `comparison` on `what_changed`. No tool renamed or reshaped.

## [0.12.0] - 2026-08-25

Observability foundation (Phase A of docs/Observability-Roadmap.md). One rule
drives all three changes: an agent must be able to distinguish "no events" from
"events are invisible on this target".

### Added

- **Collector health.** Collectors fail politely by design - a missing service
  extension must not kill the session - but until now they failed silently,
  so `get_network` returning `[]` on a target without dart:io profiling read
  exactly like a quiet app. Each collector now reports
  `active | degraded | unavailable` with a reason written for the agent.
  Surfaced in `runtime_health` (a `collectors` array, plus a note per
  non-active collector) and `get_capabilities` (additive `collectorHealth`;
  `collectors` stays a name list). Health resets per session, so a reconnect
  onto a more capable target clears stale blindness.
- **Structured evidence coverage on every diagnosis.** `diagnose_runtime`
  gains `coverage`: categories present and empty, per-category evicted counts,
  and the observed window (oldest and newest retained event). `limitations`
  stays for humans; agents read structure.
- **`correlationId` on events.** Nullable, set only when the runtime provides a
  real identity - the dart:io HTTP profile request id today. Never invented;
  every other source leaves it absent.
- **`docs/Observability-Roadmap.md`** - the architecture audit: what already
  exists mapped to where it lives, Phase A-E sequencing, and explicit
  rejections with reasons (store indexes rejected at current scale with the
  0.3.0 benchmark as evidence; monotonic timestamps deferred until a stored
  source exists rather than shipping an always-null field; an
  observed/inferred enum rejected because everything in the store is observed
  by construction).

### Compatibility

Purely additive: `collectors` on `runtime_health`, `collectorHealth` on
`get_capabilities`, `coverage` on `diagnose_runtime`, `newestEventMs` in
retention reports, optional `correlationId` on events.

## [0.11.0] - 2026-08-25

Widget rebuild attribution. First release validated against a real app on a
physical device rather than only against mocks.

### Added

- **`RebuildCollector`** - per-frame widget rebuild counts from
  `Flutter.RebuiltWidgets`, enabled through
  `ext.flutter.inspector.trackRebuildDirtyWidgets`, resolved to widget name,
  file and line. The id-to-source table is seeded from `widgetLocationIdMap` at
  startup, because location tables are sent incrementally and anything described
  before connecting is never re-sent.
- **`get_rebuilds`** - rebuild hotspots ranked by volume, with the developer's
  own code distinguished from package and framework code.
- **`diagnose_performance` names the widget behind a build-heavy profile**, with
  its source line, and aims the fix at the nearest code the developer can
  actually edit. On a profile that is not build-bound the finding is scored down
  and explicitly labelled as context rather than cause.
- A new `rebuild` event category with its own 1,000-event retention budget.

### Fixed

- **A documented limitation that was simply false.** `diagnose_performance`
  claimed "No widget rebuild counts. A build-heavy frame cannot be traced to the
  widget that rebuilt." Rebuild counts are available, with file and line. The
  limitation is replaced with the real bounds: totals cover the busiest
  locations per frame, app-versus-package attribution is a path heuristic
  because `getPubRootDirectories` is empty until a DevTools client sets it, and
  CPU attribution to a *function* still requires the DevTools profiler.
- **`connect_vm` explains an empty VM instead of just stating it.** "No isolates
  found on the VM" now says the app is no longer running and that relaunching
  changes the URI - measured against a device where the app had been swiped away
  while `flutter run` held the port open.
- **A race in the mock-VM integration test.** It pushed a stream event on a
  fixed 80ms timer, which under full-suite load could beat the collectors
  attaching their listeners, and a missed stream event is missed permanently.
  The test now pushes once `connect()` has resolved, and polls for the result.

### Notes

Validated live against a Flutter app using Riverpod and go_router on a physical
Android device. Three things only real data exposed:

- go_router navigation *is* captured - `_PageBasedMaterialPageRoute` reaches
  `Flutter.Navigation`, and per-route attribution held up: a dialog route
  accounted for 22 of 24 janky frames while the screen behind it took 2.
- Ranking hotspots with app code first made "busiest" a false claim. It buried a
  package location with 200 rebuilds beneath app entries with one each. Ranking
  is now by volume, with app code surfaced alongside rather than instead.
- Without the location-table seed, 714 of 1,346 rebuilds resolved to `unknown`.

Empty `get_logs` on a real app turned out to be correct behaviour, not a bug:
the app under test contains no `print`, `debugPrint` or `developer.log` calls,
so the VM Service had no `Stdout` or `Logging` events to deliver.

### Compatibility

Purely additive. The new category appears in `runtime_status.byCategory` and the
retention report; no existing tool changed shape.

## [0.10.0] — 2026-08-22

Performance diagnosis. Why the app is janky, not just how much.

### Added

- **`diagnose_performance`** — frame percentiles (p50/p90/p99, worst), the
  build-versus-raster split across janky frames, and findings that correlate
  jank against what can actually be observed:
  - **Phase** — whether janky frames are dominated by build or by raster, with
    the matching advice. An even split is reported as `mixed` rather than forced
    into one bucket.
  - **In-flight requests** — jank landing inside an HTTP request's span, which
    on mobile usually means a response being decoded on the main isolate.
  - **Route transitions** — jank clustered within a second of a route change,
    which is the new screen's first build rather than steady-state rendering.
  - **Heap growth** — deliberately the weakest finding, scored below the others
    and stating outright that GC events are not observable from here, so the
    link cannot be confirmed.
- Each finding carries its own evidence ids, strength and fix, and findings are
  ranked by strength.

### Notes

The tool reports `healthy` when jank is within normal range and `unknown` below
20 frames, rather than reading noise as a pattern. `limitations` are stated on
every run: no CPU sampling, no GC event stream, no widget rebuild counts, and
frames rolling out of the retention window. A slow build cannot be traced to a
function or a widget from here — that needs the DevTools CPU profiler, and the
output says so instead of guessing.

### Compatibility

Purely additive.

## [0.9.0] — 2026-08-22

Route awareness. Failures can now be attributed to the screen they happened on.

### Added

- **`NavigationCollector`** — route changes from the `Extension` stream,
  `Flutter.Navigation`. Flutter's own `Navigator` posts this on every push, pop,
  replace and remove, so nothing has to be installed in the app and no observer
  is required. Route arguments are redacted: a route name plus its arguments is
  often the most identifying thing in a session.
- **`get_navigation`** — the current route and recent transitions, each with how
  long it was on screen and the exceptions, failed requests and janky frames
  attributed to it. A network request spanning a route change is counted for
  both screens; assigning it to one would hide it from the screen the user
  actually saw fail.
- **`diagnose_runtime` names the screen.** The summary reads "most recent on
  route /checkout: …", and the route change is included in the cited evidence.
  Bugs get reported as "the checkout screen crashes", not as "an exception at
  14:32:01".
- `runtime_health` reports `currentRoute` with the exception count attributed to
  it; `what_changed` includes route changes in its window.
- A new `navigation` event category, with its own retention budget of 500.

### Compatibility

Purely additive. The new category appears in `runtime_status.byCategory` and in
the retention report; nothing existing changed shape.

## [0.8.0] — 2026-08-22

Agent-facing tools. Four new capabilities aimed at spending less context to get
a better answer.

### Added

- **`runtime_health`** — one call replacing six. Returns a verdict
  (`healthy` / `degraded` / `failing` / `no-data`) plus exception, network,
  frame, log and memory summaries with citable event ids, the retention window,
  and notes stating when the numbers are qualified (disconnected, mid-reconnect,
  evidence dropped, network not refreshed). Works before `connect_vm`, returning
  a verdict rather than an error an agent has to interpret.
- **`what_changed`** — evidence from the window before a failure: exceptions,
  network, warning and error logs, connection events, frame and memory deltas,
  and a timeline. Anchors on an `eventId`, the most recent exception, or now.
  Network matching is interval-based, so a request that started before the
  window and failed inside it still appears. When a requested anchor is not
  retained it says so instead of silently answering about a different event.
- **`explain_diagnosis`** — the reasoning behind a diagnosis: every cited id
  resolved back to its full record, the timeline, competing explanations,
  `missingEvidence` naming what would sharpen the result, and the confidence
  breakdown.
- **`get_capabilities`** — active collectors, every tool with its safety class,
  what can and *cannot* be observed on this target, and the current redaction,
  dashboard and retention configuration. An agent should read `cannotObserve`
  before concluding something is absent: no network evidence in a WebView app
  means the traffic was never visible, not that no requests happened.
- **`docs/AI-Agent-Integration.md`** — the recommended investigation protocol,
  what each field is for, how to report uncertainty, and a worked example that
  deliberately shows which tools *not* to call.

### Changed

- Tool annotations and `get_capabilities` are derived from one safety map, so
  the two cannot disagree. A test asserts they match.
- The server version lives in `src/version.ts` instead of being duplicated
  between `index.ts` and the package manifest.

### Compatibility

Purely additive. No existing tool renamed, removed, or reshaped.

## [0.7.0] — 2026-08-22

Correlation engine. Diagnoses now show their working.

### Fixed

- **Correlation matched on when a request started, not when it failed.** A
  network request that began 30 seconds before an exception and returned 500
  immediately before it fell outside the 3-second window and was never offered
  as evidence — and a slow or hanging request is exactly the kind that causes
  the failure being diagnosed. Events are now treated as intervals rather than
  instants, so a request is adjacent to a failure if any part of its span is.

### Added

- **`src/diagnosis/correlation.ts`** — a reusable temporal module: interval
  extraction, signed gaps, before/overlap/after relations, nearest-first
  correlation, and a chronological timeline around an anchor. Deterministic
  analysis narrows the search space before the model reasons, rather than asking
  it to reconstruct chronology from a flat event list.
- **`diagnose_runtime` returns structured evidence.** New fields: `status`
  (`diagnosed` | `unknown`), `timeline` (chronological entries with `deltaMs`
  and relation to the root cause), `alternativeCauses` (competing explanations
  with their own strength and cited event ids), `limitations` (what the
  diagnosis could not see), and `confidenceBreakdown`.
- **Confidence is decomposed and documented.** `confidenceBreakdown` separates
  evidence strength, data completeness and the strength of the best competing
  explanation, and states plainly that the number is a conservative heuristic
  rather than a calibrated probability. A strong hypothesis over thin data and a
  weak one over complete data used to produce the same figure.
- **Memory is part of diagnosis.** Sustained heap growth across a session's
  samples is offered as a hypothesis — deliberately lowest priority and never
  outranking an exception, with the caveat that growth is not a leak attached to
  its own recommendation.
- Diagnoses now state their blind spots explicitly: evidence dropped by
  retention, missing network or memory evidence, VM timeline events taking no
  part in correlation, and platform-code and WebView causes being invisible.

### Notes

VM timeline events are still excluded from correlation. They are fetched on
demand and never stored, so folding them in means either storing them behind a
new collector or having every diagnosis issue a slow VM call. Neither belongs in
this release; the limitation is now reported in the output instead of being
silently absent.

### Compatibility

No tool renamed or removed. `diagnose_runtime` keeps every existing field —
`summary`, `rootCause`, `evidence`, `confidence`, `recommendedFixes` — with the
same meaning; everything above is additive. Evidence items gained `eventId` in
0.6.0.

## [0.6.0] — 2026-08-22

Evidence identity. Diagnoses can now cite the exact event a claim rests on.

### Added

- **Stable event ids.** Every event carries an `eventId` like `exc_00142` or
  `net_00143`, typed by category and unique across categories and sessions for
  the lifetime of the store. Diagnosis evidence includes it, so a claim points
  at a specific captured event instead of paraphrasing it.
- `RuntimeStore.byEventId()` resolves a cited id back to its event, ignoring
  session scoping — a citation nothing can dereference is decoration. Returns
  nothing for an id whose event has been evicted, rather than the wrong event.
- A regression test pinning the timestamp basis of network evidence. Every other
  collector stamps with `Date.now()` while `NetworkCollector` uses the HTTP
  profile's `startTime`; the test asserts those land on one timeline using
  realistic epoch values, so a future change to the profile format fails a test
  instead of silently blinding correlation.

### Notes

An earlier audit item suspected `startTime` might be monotonic-since-VM-start
rather than epoch, which would have meant the "an HTTP 500 preceded this
exception" correlation never fired in practice. Checked against the Dart SDK
source — 3.12.1, `sdk/lib/_http/http_impl.dart:62` uses
`DateTime.now().microsecondsSinceEpoch` — so the concern was unfounded and no
change was needed. Verifying it did surface a real defect in the same area,
tracked as P1-8: correlation matches on when a request *started*, so a slow
request that fails immediately before an exception falls outside the window.
That is fixed with the correlation work.

### Compatibility

No tool renamed, removed, or reshaped. `eventId` on events and on diagnosis
evidence is additive.

## [0.5.0] — 2026-08-22

Closes out the P0 reliability and safety work.

### Fixed

- **Inspector object groups are disposed.** `get_widget_tree` and
  `get_selected_widget` passed one constant `groupName` and never called
  `disposeGroup`. Inspector groups pin widget and element references inside the
  *debugged app*, so every call grew the heap of the app whose memory these
  tools are meant to diagnose. Each call now uses its own group and releases it
  afterwards, including when the read fails.
- **The dashboard test no longer binds a fixed port.** It hardcoded 7390 and
  would fail if anything already held it. `DASHBOARD_PORT=0` now asks the OS for
  a free port, and `startDashboard()` binds before computing anything
  port-dependent.

### Added

- **Every tool declares its safety class.** All twelve carry MCP annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and
  the two that change state say so in their description as well, since
  annotations are hints a client may ignore while the model always reads the
  description. `connect_vm` enables `dart:io` HTTP timeline logging on the app;
  `get_timeline` with `recordFrom: true` rewrites VM recording flags. Nothing
  writes to your project.
- An MCP surface test: tools are registered on a real server and read back
  through a client over an in-memory transport, asserting the tool list and
  every safety classification.

### Compatibility

No tool renamed, removed, or reshaped. Annotations are additive metadata.

## [0.4.0] — 2026-08-22

Session lifecycle release. Fixes evidence corruption across app runs and adds
recovery from dropped connections.

### Fixed

- **Collector state no longer survives a reconnect.** Collector instances
  outlive connections, and two of them held per-session state that was never
  reset. `NetworkCollector`'s dedup set meant that after a hot restart — where
  request ids start again from low numbers — the new run's requests looked like
  duplicates and were silently discarded, so `get_network` returned nothing.
  `LogCollector`'s partial-line buffer prepended a fragment from the previous
  run onto the next one's first log line. The `Collector` interface gains an
  optional `reset()`, called before every connect.
- **Evidence from two app runs is no longer mixed.** Every event now carries a
  `sessionId`, and a new session opens on each connect. Queries return the
  current session by default, so the diagnosis engine cannot correlate an
  exception from this run with a network call from the last one.

### Added

- **Bounded reconnection.** An unexpected socket close now retries the last
  known URI with exponential backoff (default 1s doubling to 30s, 8 attempts,
  configurable through `connection.reconnectPolicy`). Every attempt, failure and
  recovery is recorded as a system event, so the outage appears in the evidence
  timeline instead of reading as the app going quiet. An explicit disconnect
  never retries. This covers transient drops — a sleeping device, a flaky cable
  — but not a full app relaunch, which allocates a new VM Service URI.
- `runtime_status` reports `sessionId`, `reconnecting` and `reconnectAttempt`.
- `RuntimeStore.query()` accepts `sessions: "all"` to read across sessions. The
  dashboard uses it, so a human still sees the previous run's error after a hot
  restart.

### Compatibility

No tool renamed, removed, or reshaped. `sessionId` on events and the three new
`runtime_status` fields are additive. Tools now return only the current
session's evidence; previously they returned every retained event regardless of
which app run produced it.

## [0.3.0] — 2026-08-22

Storage release. Fixes a bug that silently destroyed the evidence the project
exists to preserve.

### Fixed

- **Frame events no longer evict every other kind of evidence.** The store was
  one shared 5,000-event buffer. `FrameCollector` writes an event per frame, so
  at 60fps frames filled the entire buffer in about 83 seconds and then evicted
  everything older — the exceptions, network requests and logs you were actually
  chasing. Two minutes into a session, the exception from minute one was gone.
  Each category now has its own ring buffer, so a noisy stream can only evict
  itself. Defaults: 3,000 logs, 1,000 exceptions, 1,000 network, 1,000 frames,
  500 system, overridable through the `RuntimeStore` constructor.
- **Insertion is O(1).** The buffer was trimmed with `splice(0, n)` on every
  insert past capacity, copying the whole array 60 times a second inside the
  tool meant to diagnose performance problems. Replaced with a circular buffer:
  200,000 events went from 9,943ms to 81ms, a 122x improvement.

### Added

- `runtime_status` now reports `retention`: per-category capacity, how many
  events are retained, how many were evicted, and the timestamp of the oldest
  event still held. A capped buffer is fine; a silently capped one leaves an
  agent reasoning over truncated history without knowing it.
- `CATEGORIES` is exported from `core/events.ts` as a runtime value, with the
  `Category` type derived from it so the two cannot drift.

### Compatibility

No tool renamed, removed, or reshaped. `RuntimeStore.query()` returns the same
most-recent-first ordering, now merged across the per-category buffers.
`runtime_status.retention` is additive.

## [0.2.0] — 2026-08-22

Security release. Both items below were live defects in 0.1.0; upgrading is
recommended for anyone who ran the dashboard or inspected authenticated
requests.

### Security

- **Credentials are redacted before they enter the event store.** `get_network`
  and `diagnose_runtime` previously returned full request and response headers
  for failing requests, sending `Authorization` bearer tokens and `Cookie` /
  `Set-Cookie` values to the AI model and to every browser watching the
  dashboard. Redaction now happens at capture, covering credential headers,
  sensitive query-string parameters, and JWT- or `Bearer`-shaped strings in log
  and error text. Header names that were hit are reported in
  `data.redactedHeaders`. Configure with `FLUTTER_LAMP_REDACT_EXTRA`; opt out
  with `FLUTTER_LAMP_REDACT=off`.
- **The dashboard WebSocket no longer accepts cross-origin connections.**
  Binding to `127.0.0.1` does not protect a WebSocket — browsers exempt
  WebSocket from the same-origin policy, so any page the developer had open
  could connect to `ws://127.0.0.1:7373/ws` and read the entire runtime stream.
  The handshake now requires a per-process token inlined into the served page
  (unreadable by cross-origin script), and a present `Origin` header must be
  loopback. The page is served `X-Frame-Options: DENY`.
- `/health` no longer returns the VM Service URI, which embeds the VM's own
  auth token. It reports liveness only.
- Binding `DASHBOARD_HOST` to a non-loopback address now logs a warning.

### Added

- `SECURITY.md` — reporting process, threat model, and what is and is not
  protected.
- `docs/Improvement-Plan.md` — audit of the v0.1.0 implementation with a
  prioritized P0–P4 backlog.

### Changed

- Planning docs rewritten as readable documents; `docs/Memory.md` became
  `docs/Implementation-Notes.md`.

### Compatibility

No tool was renamed, removed, or changed shape. Credential header *values* now
read `[REDACTED]`, and `data.redactedHeaders` is added when anything was
withheld. The dashboard URL is unchanged.

## [0.1.0] — 2026-08-22

First public release.

### Added

- **MCP server on stdio** (`@modelcontextprotocol/sdk`) with 12 tools.
- **Dart VM Service client** — JSON-RPC over WebSocket, `ws://` and `http://` URIs
  (`connect_vm`, `runtime_status`).
- **Log collection** — Stdout, Stderr and `dart:developer` logging, filterable by
  severity, source and text (`get_logs`).
- **Exception capture with reconstructed stack traces** — walks the serialized
  `Flutter.Error` DiagnosticsNode tree to rebuild the stack, error summary and
  offending widget; also captures `Debug.PauseException` (`get_exceptions`).
- **Network capture** via `dart:io` HTTP profiling — covers Dio and
  `package:http` with no interceptor; failing and slow requests are enriched with
  headers and error detail (`get_network`).
- **Frame timings** with jank classification against the 60fps budget
  (`get_frames`).
- **Widget Inspector** snapshots — `get_widget_tree`, `get_selected_widget`.
- **Memory** (Dart heap, capacity, external) and **VM timeline** events
  (`get_memory`, `get_timeline`).
- **`diagnose_runtime`** — evidence-first correlation engine that anchors a root
  cause to a real captured event and reports "Unknown" below 70% confidence
  rather than guessing.
- **Live browser dashboard** on `http://127.0.0.1:7373` — native HTTP + WebSocket,
  no build step; Overview, Logs, Network, Exceptions, Timeline, Performance and
  Inspector tabs, with pause/resume, clear, export JSON, search and
  auto-reconnect. Configurable via `DASHBOARD_PORT`, `DASHBOARD_HOST` and
  `DASHBOARD_DISABLE` (`get_dashboard_url`).
- **`flutter-runtime-diagnosis` Claude Code skill** — runs the whole
  connect → gather → diagnose flow without asking the user to paste logs.

[0.17.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.17.0
[0.16.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.16.0
[0.15.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.15.0
[0.14.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.14.0
[0.13.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.13.0
[0.12.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.12.0
[0.11.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.11.0
[0.10.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.10.0
[0.9.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.9.0
[0.8.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.8.0
[0.7.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.7.0
[0.6.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.6.0
[0.5.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.5.0
[0.4.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.4.0
[0.3.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.3.0
[0.2.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.2.0
[0.1.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.1.0
