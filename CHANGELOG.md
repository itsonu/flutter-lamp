# Changelog

All notable changes to Flutter Lamp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.5.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.5.0
[0.4.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.4.0
[0.3.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.3.0
[0.2.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.2.0
[0.1.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.1.0
