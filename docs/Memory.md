# Memory

## Version

0.1.0

## Current Phase

Phases 1–6 + early AI diagnosis + Phase 12 (Realtime Dashboard). 12 MCP tools shipped.

## Completed

- **Phase 1 — Foundation**: TypeScript project, MCP server on stdio (`@modelcontextprotocol/sdk` 1.29), Dart VM Service JSON-RPC/WebSocket client (`connect_vm`), health check (`runtime_status`).
- **Phase 2 — Logs / Exceptions / Frames**: collectors for Stdout/Stderr/Logging (`get_logs`, with `source` filter), Flutter.Error + Debug.PauseException (`get_exceptions`), Flutter.Frame with jank classification (`get_frames`).
  - **Realtime exceptions WITH stack traces**: `Flutter.Error` extensionData is a serialized DiagnosticsNode tree — the stack is NOT a flat field. `collectors/flutterError.ts` walks the tree, reconstructing the stack from `#N …` frame lines and pulling the ErrorSummary + offending widget + library. Unit-tested + a mock-VM WebSocket integration test proves the connect→collector→store→query path end-to-end.
- **Phase 3 — Network**: dart:io HTTP profiling collector (`get_network`), pull-on-demand, covers Dio & package:http via the shared dart:io HttpClient. Failing/slow requests are enriched with request/response headers + error detail via `getHttpProfileRequest`.
- **Phase 4 — Widget Inspector**: `get_widget_tree` (getRootWidgetSummaryTree, simplified) + `get_selected_widget` (getSelectedSummaryWidget). Debug builds only.
- **Phase 5 — Timeline**: `get_timeline` — enable recording (setVMTimelineFlags) then read getVMTimeline events.
- **Phase 6 — Memory**: `get_memory` — getMemoryUsage → heap/capacity/external in MB, snapshotted into runtime history.
- **AI Diagnosis (Phase 8, early)**: evidence-first correlation engine (`diagnose_runtime`) — anchors root cause to a real event, confidence 0–1, says "Unknown" below 70%.
- **Phase 12 — Realtime Runtime Dashboard**: standalone native HTTP + WebSocket server (`dashboard/server.ts` + static `dashboard/index.html`, no React/build step), auto-starts with the MCP, independent of stdio (browser + AI client run simultaneously). Serves `http://127.0.0.1:7373` (env `DASHBOARD_PORT`/`DASHBOARD_HOST`, `DASHBOARD_DISABLE=1` to turn off). Reuses `RuntimeStore` as the ONLY event source: the store is now an `EventEmitter` (emits `event`/`clear`); the dashboard subscribes ONCE and fans out to all browsers (no per-client listener growth). Tabs: Overview / Logs / Network / Exceptions / Timeline / Performance (canvas charts) / Inspector placeholder. Features: live stream, pause/resume, clear view, export JSON, search/filter, auto-reconnect, responsive dark UI. `runtime_status.dashboard_url` + `get_dashboard_url` tool expose the URL. Gated memory sampler (2s, only while a browser is watching + connected) drives the live memory chart via the shared `connection.sampleMemory()`.
- **flutter-runtime-diagnosis skill**: end-to-end runtime diagnosis flow; never asks for pasted logs when a VM Service is reachable.

## Dashboard gotchas (learned building Phase 12)

- Render loop MUST be `setInterval`, not `requestAnimationFrame` — rAF is paused when the tab isn't painting (backgrounded/headless), which silently freezes the live view even though the WebSocket keeps receiving.
- The server reads `index.html` ONCE at startup (in-memory cache — right for prod); restart to pick up UI edits during dev.
- HTTP handler matches on `URL` pathname (`url.split("?")[0]`), so `?cache-bust` query strings don't 404. `Cache-Control: no-store` on the HTML.

## Query-style tools (direct VM RPC, not stored streams)

Widget tree, selected widget, memory, and timeline are fetched on demand via `connection.vmCall`/`isolateCall`. Memory also snapshots into the store so diagnosis can reference it later. These use core/extension RPCs directly — same "official APIs, no scraping" rule.

## Architecture (as built)

`VM Service (WebSocket JSON-RPC)` → `Collectors` (log/exception/frame/network, each implements the `Collector` interface) → `RuntimeStore` (single centralized capped ring buffer; every event carries timestamp/source/severity/category) → `ConnectionManager` singleton → stateless MCP tools.

New runtime sources (Inspector, Timeline, Memory…) are added by implementing `Collector` + registering it in `ConnectionManager` — no other layer changes.

## Working

- VM connection, health check
- Console logs, structured logging
- Exceptions (framework + unhandled)
- Frame timings + jank detection
- HTTP network capture (on-demand)
- Correlated diagnosis with confidence

## Pending

- Phase 5/6 depth — CPU sampling (`getCpuSamples`), leak detection, timeline richer correlation
- Phase 7 — Deeper correlation engine (fold memory/timeline into diagnose_runtime)
- Phase 9 — Knowledge Graph
- Phase 10 — Auto Fixes
- Riverpod/Bloc state, navigation, WebSocket events, OpenTelemetry (future)

## Known Issues

- Network is pull-on-demand (no push stream exists for dart:io HTTP); refreshed when `get_network`/`diagnose_runtime` is called. This respects the "no polling" rule (fetch only on request).
- Exception capture via `Debug.PauseException` only fires if the app is set to pause on exceptions; `Flutter.Error` (framework) is always captured.
- Real end-to-end against a live Flutter VM is validated by the user; automated tests cover the diagnosis engine + store, and an MCP stdio smoke test covers the transport and tool surface.

## Next

- Fold memory snapshots + jank + timeline into `diagnose_runtime` correlation (Phase 7).
- CPU sampling tool via `getCpuSamples`; leak heuristics.
