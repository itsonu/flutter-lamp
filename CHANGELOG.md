# Changelog

All notable changes to Flutter Lamp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.8.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.8.0
[0.7.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.7.0
[0.6.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.6.0
[0.5.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.5.0
[0.4.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.4.0
[0.3.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.3.0
[0.2.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.2.0
[0.1.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.1.0
