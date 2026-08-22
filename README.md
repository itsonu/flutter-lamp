<div align="center">

# 💡 Flutter Lamp

### Give your AI **live** eyes on a running Flutter app — no more pasting logs.

[![CI](https://github.com/itsonu/flutter-lamp/actions/workflows/ci.yml/badge.svg)](https://github.com/itsonu/flutter-lamp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/flutter-lamp.svg)](https://www.npmjs.com/package/flutter-lamp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-000.svg)](https://modelcontextprotocol.io)

An **MCP server** that connects Claude Code, Claude Desktop, Cursor, Codex & Gemini
directly to a running Flutter app through the **Dart VM Service Protocol** —
streaming exceptions, logs, network calls, frame timings and memory as structured
data, plus an evidence-first root-cause **diagnosis** engine and a live browser
**dashboard**.

</div>

---

## Why

Today you debug Flutter with your AI by copy-pasting stack traces, `flutter run`
output and DevTools screenshots. The AI is blind between messages.

Flutter Lamp makes the AI **runtime-aware**. It reads the app's live
state over official Flutter/Dart APIs (never scraping DevTools), so instead of
*"paste the error"* the AI can ask the app *"what just happened, and why?"*

```
❌  You: *pastes 40 lines of red stack trace*
✅  AI: connect_vm → get_exceptions → diagnose_runtime
       → "RenderFlex overflow in Column at home.dart:42, triggered right after
          GET /api/user returned 500. Confidence 85%. Fix: …"
```

## Features

- 🔌 **One-line connect** to any running Flutter app's VM Service
- 💥 **Realtime exceptions with reconstructed stack traces** (framework + unhandled)
- 📝 **Console & structured logs** (Stdout / Stderr / `dart:developer`)
- 🌐 **Network capture** via `dart:io` profiling — covers Dio & `package:http`, no interceptor needed
- 🎞️ **Frame timings** with jank detection against the 60fps budget
- 🧬 **Widget tree & selected-widget** snapshots from the Inspector
- 🧮 **Memory** (Dart heap / external) and **VM timeline** events
- 🩺 **`diagnose_runtime`** — correlates evidence into *summary · root cause · evidence · confidence · fixes*; says **"Unknown"** below 70% instead of hallucinating
- 📊 **Live browser dashboard** at `http://127.0.0.1:7373` — streams everything over WebSocket, independent of the AI connection
- 🧩 Ships a reusable **`flutter-runtime-diagnosis`** Claude Code skill

## Tools

| Tool | Purpose |
| --- | --- |
| `connect_vm` | Connect to a running app's Dart VM Service (`ws://` or `http://`). |
| `runtime_status` | Health check — connection + captured-event counts + dashboard URL. |
| `get_logs` | Console + `dart:developer` logs (filter by severity / source / text). |
| `get_exceptions` | Framework & unhandled exceptions **with stack traces**. |
| `get_frames` | Frame build/raster timings; `onlyJanky` filter. |
| `get_network` | HTTP requests (Dio & `package:http`); headers + timing on failures. |
| `get_widget_tree` | Widget-tree snapshot from the Flutter Inspector. |
| `get_selected_widget` | Widget currently selected in the Inspector. |
| `get_memory` | Dart heap + external memory (MB). |
| `get_timeline` | Recent VM timeline events (build/paint/layout/GC). |
| `diagnose_runtime` | Correlated root-cause diagnosis with confidence + fixes. |
| `get_dashboard_url` | URL of the live browser dashboard. |

## Install

**Requires Node ≥ 20.** Nothing to clone — `npx` fetches it on first run:

```bash
npx -y flutter-lamp
```

Or install it globally:

```bash
npm install -g flutter-lamp
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/itsonu/flutter-lamp.git
cd flutter-lamp
npm install
npm run build
node dist/index.js
```

</details>

## Connect your AI client

Add the server to your MCP client config, then restart the client.

**Claude Code** — `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "flutter-lamp": {
      "command": "npx",
      "args": ["-y", "flutter-lamp"]
    }
  }
}
```

Or from the CLI:

```bash
claude mcp add flutter-lamp -- npx -y flutter-lamp
```

**Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop**
(`claude_desktop_config.json`) use the same `mcpServers` shape.

Running from a clone instead? Point `command` at `node` and `args` at
`/absolute/path/to/flutter-lamp/dist/index.js`.

Optional environment variables:

| Var | Default | Meaning |
| --- | --- | --- |
| `DASHBOARD_PORT` | `7373` | Dashboard HTTP/WS port. |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address (localhost only by default). |
| `DASHBOARD_DISABLE` | — | Set to `1` to disable the dashboard. |

## Usage

1. Run your Flutter app in debug/profile mode:
   ```bash
   flutter run
   ```
   Copy the line it prints:
   ```
   A Dart VM Service on <device> is available at: http://127.0.0.1:PORT/TOKEN=/
   ```
   > Tip: `flutter run --vm-service-port=8181` gives a stable URI across restarts.

2. Ask your AI to connect and diagnose — e.g. *"connect to my Flutter app at
   `<uri>` and tell me why it's throwing."* With the bundled skill, Claude Code
   runs the whole flow (connect → gather → `diagnose_runtime`) automatically and
   **never asks you to paste logs** when the VM Service is reachable.

3. Open **http://127.0.0.1:7373** in a browser for the live dashboard — it runs
   alongside the AI, not instead of it.

## Live dashboard

A zero-dependency dark UI (native HTTP + WebSocket, no build step) that streams
runtime data as it happens:

**Overview** (connection · FPS · memory · event counts) · **Logs** (search /
filter / auto-scroll) · **Network** (expandable headers & timing) ·
**Exceptions** (expandable stack traces) · **Timeline** · **Performance** (live
canvas charts) · **Inspector**.

Controls: pause/resume · clear view · export JSON · per-tab search · auto-reconnect.

## How it works

```
Running Flutter app
        │  Dart VM Service Protocol (JSON-RPC over WebSocket)
        ▼
   VmService client ──▶ Collectors (log · exception · frame · network · …)
                              │
                              ▼
                   RuntimeStore  (one centralized, capped event stream;
                    every event: timestamp · source · severity · category)
                        │                         │
             ┌──────────┘                         └──────────┐
             ▼                                                ▼
     MCP tools (stdio)                          Dashboard (HTTP + WebSocket)
     → Claude Code / Cursor / …                 → your browser
```

Everything flows through **one** event store. Adding a new runtime source =
implement the `Collector` interface and register it — no other layer changes.
Design principles: official Flutter/Dart APIs only, structured JSON over text,
never scrape DevTools, and never claim a cause the evidence doesn't support.

## Limitations

- **Debug/profile builds only.** The VM Service, Inspector and `dart:io` HTTP
  profiling are not available in release builds.
- **Network is pull-on-demand.** Dart exposes no push stream for `dart:io` HTTP,
  so requests are fetched when `get_network` or `diagnose_runtime` runs — not
  streamed continuously.
- **`Debug.PauseException` needs pause-on-exception** enabled in the app to fire.
  Framework errors (`Flutter.Error`) are always captured regardless.
- **Dart-side HTTP only.** Calls made from platform (Kotlin/Swift) code or from a
  WebView don't appear in `get_network`.
- The dashboard binds to `127.0.0.1` by default. Change `DASHBOARD_HOST` only on a
  network you trust — runtime data is served unauthenticated.

## Roadmap

Shipped: VM connect, logs, exceptions (with stacks), network, frames, widget
tree, memory, timeline, diagnosis, live dashboard.

Next: deeper correlation (memory/timeline into `diagnose_runtime`), CPU
sampling & leak heuristics, Riverpod/Bloc state, navigation, knowledge graph,
auto-fixes. See [`docs/Phases.md`](docs/Phases.md).

## Development

```bash
npm run build     # compile TypeScript → dist/
npm run watch     # incremental compile
npm test          # node:test suite (engine + collectors + dashboard)
```

`npm test` runs the compiled output, so build first. It relies on glob support in
`node --test`, which needs **Node ≥ 21** — the server itself runs on Node ≥ 20.

Docs in [`docs/`](docs/) are the source of truth (PRD, Architecture, Rules,
Phases, Design, Memory).

## Contributing

Issues and PRs welcome. Keep it modular, prefer official APIs over hacks, and
add a `node:test` check for any non-trivial logic.

## License

[MIT](LICENSE) © Chandrabhushan Prakash
