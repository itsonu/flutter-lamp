# Changelog

All notable changes to Flutter Lamp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/itsonu/flutter-lamp/releases/tag/v0.1.0
