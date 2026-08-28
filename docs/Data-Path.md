# The actual data path

Written before any dashboard change, because the UI has to be built around what
the process really knows rather than around a plausible-looking diagram. Every
claim below was traced in the source and then checked against a running system;
where something could not be checked, it says so.

## The topology, as measured

```
Flutter app (Dart VM Service, ws://…)
        │
        │  push: Extension / Stdout / Stderr / Logging / Debug streams
        │  pull: getHttpProfile, getMemoryUsage, getVMTimeline
        ▼
   Collectors  (src/collectors/*)
        │
        ▼
   RuntimeStore  ← ONE instance, `connection.store`
        │
        ├──────────────► MCP tools      (src/tools.ts, stdio)  ──► the agent
        │                 read the store directly
        │
        └──────────────► Dashboard      (src/dashboard/server.ts, HTTP+WS)
                          subscribes to store events, fans out to browsers
```

**One process. One store.** `src/index.ts` registers the MCP tools on stdio and
starts the dashboard HTTP/WS server in the same Node process.
`src/core/connection.ts:395` exports `connection` as a module singleton holding
`readonly store = new RuntimeStore()` (line 100), and
`src/dashboard/server.ts:6,57` imports that same singleton and reads
`connection.store`.

Of the five candidate architectures, this is the shared normalized store: the
dashboard and the MCP tools are two readers of one event store, not two
pipelines.

### Proof, not inference

Reading the imports shows they *should* share a store. This was then verified
against a live system (`scratchpad/topology.mjs`): attach a WebSocket client to
the dashboard the way a browser does, then invoke the MCP tool `get_memory`,
which writes a system event as a side effect.

```
PID of MCP server process: 22296
dashboard announced on stderr: http://127.0.0.1:7373
dashboard snapshot events: 4
MCP tool called: get_memory -> 108.82 MB
events pushed to the dashboard socket after that call: 2
of those, written BY the tool call: 2 (sys_00006 "Heap 108.82MB / cap 116.54MB…")
VERDICT: SHARED STORE CONFIRMED
```

An MCP tool call produced an event that arrived on the dashboard's socket with
the same event id. The two surfaces are looking at the same data.

## What this means for "is MCP receiving the runtime stream?"

The question does not quite apply, and the answer is better than "yes".

**MCP does not receive the stream. MCP owns it.** The collectors run inside the
MCP server process and write into the store that the MCP tools read. There is no
bridge that could be disconnected, no second consumer that could fall behind.
The dashboard is the *downstream* party here — it is a subscriber to the store
that the MCP process fills.

So a dashboard badge reading `MCP: connected` would be true but nearly
meaningless: the dashboard cannot be running unless the MCP process is running,
because the dashboard **is** the MCP process. What the dashboard genuinely
cannot show today is the *activity* on that side — which tools were called, by
whom, when, and whether they failed.

The Inspector tab's message is about something else and should not be read as a
statement about MCP:

> Live widget-tree & state streaming is not wired to the dashboard yet.

That is accurate and narrow. `get_widget_tree` and `get_selected_widget` are
pull-only RPCs against the Inspector; nothing pushes widget trees into the
store, so the dashboard has nothing to render. It says nothing about whether
runtime events reach MCP — they do, by construction.

## Observability inventory

The distinction that matters: **collected**, **surfaced**, **unobservable**.

| Fact | Collected? | Surfaced where | Dashboard? |
| --- | --- | --- | --- |
| Runtime connection, session, reconnect state | yes | `runtime_status`, WS `status` | yes |
| VM clock offset (`clockOffsetMs`) | yes | `runtime_status`, export | no |
| Per-collector health + why degraded | yes | `runtime_health`, `get_capabilities`, export | no |
| Events (all categories, with ids) | yes | every `get_*`, WS `event` | yes |
| Retention: capacity, evicted per category | yes | `runtime_status`, diagnosis `coverage` | partly |
| Categories empty **because unobservable** | yes | diagnosis `coverage.unobservable` | no |
| **Tool calls: name, count, bytes, errors, slowest** | **yes** | `runtime_status.cost` only | **no** |
| **Agent identity (client name + version)** | **available, unused** | nowhere | no |
| Diagnoses (runtime, performance, navigation, rebuilds) | yes | `diagnose_*`, `export_session` | no |
| Widget tree / selected widget | pull-only, not stored | `get_widget_tree` | no |
| A *second* MCP client | **unobservable** | — | — |

Two entries deserve emphasis, because they change what the UI work actually is.

**Tool-call telemetry already exists.** `src/core/costMeter.ts` records every
tool call — name, call count, response bytes, error count, slowest duration —
reset per session, wrapped around registration so a new tool cannot be added
without being counted. It is surfaced only inside `runtime_status`. Nothing
broadcasts it to the dashboard. An MCP activity panel is largely a matter of
exposing data the process is already keeping.

**Agent identity is available and unused.** The MCP SDK's `Server` exposes
`getClientVersion(): Implementation | undefined`, populated from the `clientInfo`
the client sends in `initialize`. So "Claude Code 2.1.0" or "Codex" is knowable
at handshake. Nothing reads it today.

## What genuinely cannot be observed

State this rather than inventing a status for it.

- **Whether another MCP client exists.** The transport is stdio: the client
  spawns the server as a child process and owns its pipes. There is exactly one
  peer, and it is the parent. There is no registry to query, and a second agent
  would be a second server process with its own store.
- **Whether the agent acted on a result.** The server sees a tool call and a
  response. What the model did with it is outside this process.
- **CPU.** The VM Service does not sample it. Already reported honestly as
  `not sampled by VM Service` — the pattern the rest of the UI should copy.
- **Causality between events.** Temporal adjacency is observable; causation is
  not. The diagnosis engine already draws this line, and the timeline should
  say "temporally adjacent" rather than implying a cause.

## Consequences for the dashboard work — and what was built

1. `MCP` is not a connection to be probed — it is the host process. The useful
   panel is **activity**: tool calls, latency, errors, last invocation, drawn
   from `costMeter`. **Built** as the MCP tab; the payload carries no
   `mcp.connected`, because a badge that cannot be false is decoration.
2. `Agent` is knowable at handshake via `getClientVersion()`, and nothing more.
   Identity yes; behaviour no. **Built** — `src/core/mcpClient.ts`, shown with
   "self-reported, not authenticated" next to it.
3. The three states worth distinguishing are **configured / connected /
   observed activity**. **Built** as Diagnostics, with five states rather than
   two: `ACTIVE`, `CONNECTED`, `RECEIVING`, `PULL ONLY`, `NOT AVAILABLE`.
4. `0 MB` and `not sampled` must stop looking alike. **Built** — and extended
   to empty lists, which now say which of three things they mean, and to
   readings taken before a disconnect, which are labelled rather than left
   looking live.
5. Widget-tree streaming is genuinely not wired. **Built** — the Inspector now
   lists which links exist, with the call counts proving which have been used.

### What tracing first changed

Two things, both of which would have been wasted work otherwise:

- The MCP panel was scoped as "wire the tools to the dashboard". It turned out
  to be pure exposure of data `costMeter` already kept — no bridge, no new
  instrumentation.
- Exposing it surfaced a real defect. The meter recorded after `await
  handler()` returned, so a handler that **threw** — which the SDK converts
  into an error result the agent still pays for — was never counted. A session
  where every call failed reported `0 calls, 0 errors`. The dashboard would
  have rendered that zero confidently. Fixed in `src/tools.ts`, with a
  mutation-checked regression test.

### The contract

This document is the architectural contract for dashboard work. The UI must
show what the process actually knows: no status derived from configuration, no
zero standing in for an absent measurement, and no cause claimed where only
adjacency was observed. A new panel that cannot point at the field backing it
does not belong.
