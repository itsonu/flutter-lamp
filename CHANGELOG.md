# Changelog

All notable changes to Flutter Lamp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.2.0
[0.1.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.1.0
