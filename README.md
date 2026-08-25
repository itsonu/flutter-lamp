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
- 🎞️ **Frame timings** with jank detection, percentiles, and a build-vs-raster verdict
- 🧭 **Route awareness** — current screen, transitions, and failures attributed to the screen they happened on
- 🧠 **State-management activity** — Riverpod, Provider and Bloc churn correlated with rebuild storms
- 🔁 **Widget rebuild attribution** — which widget rebuilt, how often, at which file and line, with your code ranked apart from package code
- 🧬 **Widget tree & selected-widget** snapshots from the Inspector
- 🧮 **Memory** (Dart heap / external) and **VM timeline** events
- 🩺 **`diagnose_runtime`** — correlates evidence into *summary · root cause · evidence · confidence · fixes*; says **"Unknown"** below 70% instead of hallucinating
- 📊 **Live browser dashboard** at `http://127.0.0.1:7373` — streams everything over WebSocket, independent of the AI connection
- 🧩 Ships a reusable **`flutter-runtime-diagnosis`** Claude Code skill

## Tools

| Tool | Purpose | Safety |
| --- | --- | --- |
| `connect_vm` | Connect to a running app's Dart VM Service (`ws://` or `http://`). | **mutates** |
| `ensure_tcp_device` | Android transports; recommend wireless, optionally promote USB. | **mutates** |
| `runtime_health` | One-call triage — verdict plus exception/network/frame/log/memory summary. | read-only |
| `what_changed` | Evidence from the window before a failure, with a timeline. | read-only |
| `get_navigation` | Current route and recent transitions, with per-route failures. | read-only |
| `get_rebuilds` | Widget rebuild hotspots resolved to widget, file and line. | read-only |
| `get_state_activity` | Riverpod provider activity over time, and how often it coincides with build-heavy frames. | read-only |
| `export_session` | The whole session as versioned JSON — `brief` (diagnoses + cited evidence) or `full`. | read-only |
| `explain_diagnosis` | Why a diagnosis was reached: resolved evidence, alternatives, gaps. | read-only |
| `get_capabilities` | Active collectors, tool safety classes, what cannot be observed. | read-only |
| `runtime_status` | Connection, session, reconnect state, event counts, retention window. | read-only |
| `get_logs` | Console + `dart:developer` logs (filter by severity / source / text). | read-only |
| `get_exceptions` | Framework & unhandled exceptions **with stack traces**. | read-only |
| `get_frames` | Frame build/raster timings; `onlyJanky` filter. | read-only |
| `get_network` | HTTP requests (Dio & `package:http`); headers + timing on failures. | read-only |
| `get_widget_tree` | Widget-tree snapshot from the Flutter Inspector. | read-only |
| `get_selected_widget` | Widget currently selected in the Inspector. | read-only |
| `get_memory` | Dart heap + external memory (MB). | read-only |
| `get_timeline` | Recent VM timeline events (build/paint/layout/GC). | **mutates** |
| `diagnose_runtime` | Root cause with evidence ids, timeline, alternatives, limitations. | read-only |
| `diagnose_performance` | Why the app is janky — percentiles, phase split, rebuild attribution. | read-only |
| `get_dashboard_url` | URL of the live browser dashboard. | read-only |

**mutates** means the tool changes app or VM state, not your project — nothing
here writes code or files. `connect_vm` enables `dart:io` HTTP timeline logging
on the app so network capture works; `get_timeline` with `recordFrom: true`
changes the VM's recording flags. Every tool carries an MCP `readOnlyHint`
annotation so a client can enforce this itself.

Agents should not call all sixteen. The recommended flow is
`runtime_health` → `what_changed` → a targeted `get_*` → `diagnose_runtime`;
see [AI Agent Integration](docs/AI-Agent-Integration.md).

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
| `DASHBOARD_PORT` | `7373` | Dashboard HTTP/WS port. | read-only |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address (localhost only by default). | read-only |
| `DASHBOARD_DISABLE` | — | Set to `1` to disable the dashboard. | read-only |
| `FLUTTER_LAMP_REDACT` | on | Set to `off` to keep raw credential values. | read-only |
| `FLUTTER_LAMP_REDACT_EXTRA` | — | Comma-separated extra header-name patterns to redact. | read-only |

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

### Debugging without a cable (Android)

A `flutter run` started over USB loses its VM Service tunnel the moment the
cable moves; one started over a TCP transport does not. Ask the server which
transports exist:

```
ensure_tcp_device                  # read-only: lists transports, recommends one
ensure_tcp_device { promote: true } # puts a USB-only device on TCP (needs the cable once)
```

Then launch against the wireless serial it recommends:

```bash
flutter run -d 192.168.88.3:5555
```

The cable is only needed for the one-time promotion. Reverse it any time with
`adb usb`.

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
- **Retention is bounded.** Each category keeps its own fixed window (3,000
  logs, 1,000 exceptions, 1,000 network, 1,000 frames, 500 system). Frames roll
  over fastest, at roughly 17 seconds of 60fps. `runtime_status` reports what is
  retained, what was evicted, and the oldest event still held.
- The dashboard binds to `127.0.0.1` by default. Change `DASHBOARD_HOST` only on a
  network you trust — runtime data is served unauthenticated.

## Security

Runtime data is sensitive. HTTP headers carry bearer tokens and cookies, URIs
carry API keys, and developers print credentials into logs — and everything
captured is handed to an AI model *and* streamed to any browser watching the
dashboard.

**Secrets are redacted at capture**, so they never enter the event store and no
consumer can leak what was never stored. Redacted by default: `Authorization`,
`Proxy-Authorization`, `Cookie`, `Set-Cookie`, `WWW-Authenticate`, any header
whose name contains `token`, `secret`, `password`, `credential`, `api-key` or
`session`, sensitive query-string parameters, and JWT- or `Bearer`-shaped
strings in log lines and error text. Header names that were hit are listed in
`data.redactedHeaders` so you can see that something was withheld rather than
getting a silently partial picture. Add patterns with
`FLUTTER_LAMP_REDACT_EXTRA`, or disable entirely with `FLUTTER_LAMP_REDACT=off`
for a local-only session.

**The dashboard is not exposed to other pages.** Binding to loopback does not
protect a WebSocket — browsers exempt WebSocket from the same-origin policy, so
without a check any page you have open could connect to
`ws://127.0.0.1:7373/ws` and read your whole runtime stream. The handshake
requires a per-process token that is inlined into the served page, which
cross-origin script cannot read, and a present `Origin` header must be loopback.
The page is served `X-Frame-Options: DENY`, and `/health` returns liveness only
— never the VM Service URI, which embeds the VM's own auth token.

Setting `DASHBOARD_HOST` to a non-loopback address logs a warning and puts
runtime evidence on your network. Only do that on a network you trust.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

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

Docs live in [`docs/`](docs/):

| Doc | Contents |
| --- | --- |
| [PRD](docs/PRD.md) | Problem, users, principles, non-goals, constraints |
| [Architecture](docs/Architecture.md) | Data flow, components, event model, how to add a collector |
| [Rules](docs/Rules.md) | Non-negotiable constraints every change is checked against |
| [Phases](docs/Phases.md) | Roadmap and status |
| [AI Agent Integration](docs/AI-Agent-Integration.md) | The investigation protocol agents should follow |
| [Improvement Plan](docs/Improvement-Plan.md) | Current audit and prioritized backlog |
| [Observability Roadmap](docs/Observability-Roadmap.md) | Architecture target, phases, and explicit rejections |
| [Releasing](docs/Releasing.md) | How versions are staged, tagged and published |
| [Design](docs/Design.md) | Dashboard visual and interaction spec |
| [Implementation Notes](docs/Implementation-Notes.md) | Non-obvious things learned building it |

## Contributing

Issues and PRs welcome. Keep it modular, prefer official APIs over hacks, and
add a `node:test` check for any non-trivial logic.

## License

[MIT](LICENSE) © Chandrabhushan Prakash
