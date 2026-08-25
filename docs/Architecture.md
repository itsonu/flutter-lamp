# Architecture

## Data flow

```
Running Flutter app (debug/profile)
        │  Dart VM Service Protocol — JSON-RPC 2.0 over WebSocket
        ▼
   VmService              src/vm/vmService.ts
   · request/response correlation by JSON-RPC id
   · re-emits streamNotify as `stream:<streamId>`
        │
        ▼
   ConnectionManager      src/core/connection.ts
   · process-wide singleton: owns the socket, the isolate id, the store
   · starts every collector on connect
   · exposes vmCall / isolateCall for query-style tools
        │
        ▼
   Collectors             src/collectors/*.ts
   · one per runtime domain; each normalizes into RuntimeEvent
        │
        ▼
   RuntimeStore           src/core/runtimeStore.ts
   · one capped ring buffer per category, the only source of evidence
   · EventEmitter: emits `event` per add, `clear` on reset
        │
        ├───────────────────────────┐
        ▼                           ▼
   MCP tools                   Dashboard
   src/tools.ts                src/dashboard/server.ts
   stdio → AI agent            HTTP + WebSocket → browser
```

Both consumers read the same store. Neither owns collection logic, and the
dashboard runs independently of the stdio transport, so an AI client and a
browser can watch one app at the same time.

## Components

| Component | File | Responsibility |
| --- | --- | --- |
| `VmService` | `src/vm/vmService.ts` | JSON-RPC transport. URI normalization (`http://…` → `ws://…/ws`), request correlation, stream fan-out, `streamListen` idempotency (tolerates error 103). |
| `ConnectionManager` | `src/core/connection.ts` | Singleton lifecycle. Connect/disconnect, isolate resolution, collector reset and startup, session boundaries, bounded reconnection, pull-collector refresh, shared `sampleMemory()`. |
| `Collector` | `src/collectors/collector.ts` | Interface: `start()` to subscribe, optional `refresh()` for sources with no push stream. |
| `RuntimeStore` | `src/core/runtimeStore.ts` | Per-category ring buffers, merged newest-first query, counts, retention reporting, live event emission. |
| Diagnosis engine | `src/diagnosis/engine.ts` | Correlates stored events into a root cause anchored to a real event. Never invents a cause. |
| MCP tools | `src/tools.ts` | Stateless. All state lives in `ConnectionManager`; tools return JSON only. |
| Dashboard | `src/dashboard/server.ts` | Native HTTP + WebSocket. One store subscription fanned out to all browsers. |

## Retention

Each category gets its own fixed-size ring buffer rather than sharing one
budget. This is not a micro-optimization — it is a correctness requirement.
Frames arrive 60 times a second while an exception might arrive once an hour, so
under a shared cap the frame stream evicts every exception, network request and
log within a couple of minutes. Per-category budgets mean a noisy stream can
only ever evict itself.

| Category | Default capacity |
| --- | --- |
| `log` | 3,000 |
| `navigation` | 500 |
| `rebuild` | 1,000 |
| `state` | 2,000 |
| `exception` | 1,000 |
| `network` | 1,000 |
| `frame` | 1,000 |
| `system` | 500 |

Buffers are circular, so insertion is O(1) regardless of how full they are.
`runtime_status` reports capacity, how much is retained, how much was evicted
and the oldest event still held — a capped buffer is fine, a silently capped one
is not, because an agent reasoning over truncated history needs to know it is
truncated.

## The event model

Every collector produces the same shape (`src/core/events.ts`):

```ts
interface RuntimeEvent {
  id: number;               // monotonic, assigned by the store
  eventId: string;          // stable, citable identity: "exc_00142"
  sessionId: string | null; // which debugging session produced it
  timestamp: number;        // epoch ms
  source: string;           // "Stdout" | "Flutter.Error" | "HttpProfile" | …
  severity: Severity;       // debug | info | warning | error | critical
  category: Category;       // log | exception | frame | network | system
  message: string;          // one-line summary, always present
  data: Record<string, unknown>;  // structured payload, shape by category
}
```

`message` is always renderable without inspecting `data`, so tools and the
dashboard can list events without knowing every payload shape.

## Collectors

| Collector | Mechanism | Push or pull |
| --- | --- | --- |
| `LogCollector` | `Stdout` / `Stderr` `WriteEvent` (base64, buffered to line boundaries) and the `Logging` stream | push |
| `ExceptionCollector` | `Extension` stream, `Flutter.Error`; `Debug` stream, `PauseException` | push |
| `FrameCollector` | `Extension` stream, `Flutter.Frame`; jank classified against a 16.67ms budget | push |
| `NetworkCollector` | `ext.dart.io.httpEnableTimelineLogging` at start, `getHttpProfile` on demand; failing requests enriched via `getHttpProfileRequest` | pull |
| `NavigationCollector` | `Extension` stream, `Flutter.Navigation` — posted by Flutter's own Navigator on push/pop/replace, so no observer is installed in the app | push |
| `StateCollector` | `Extension` stream, `riverpod:*` / `provider:*` / `bloc:*` — activity and timing only; neither framework exposes values | push |
| `RebuildCollector` | `Extension` stream, `Flutter.RebuiltWidgets` after enabling `trackRebuildDirtyWidgets`; seeds the id→source table from `widgetLocationIdMap` at startup | push |

Widget tree, selected widget, memory and timeline are **not** collectors — they
are direct RPCs issued by the tool that needs them (`connection.isolateCall`).
Memory additionally snapshots into the store so diagnosis can reference it.

`Flutter.Error` deserves a note: `extensionData` is a serialized `DiagnosticsNode`
tree, not a flat object. The stack trace is a run of child nodes whose
`description` matches `#N  …`. `src/collectors/flutterError.ts` walks the tree
and reconstructs the stack, summary and offending widget. This is the only
reliable way to get a stack out of a realtime framework error.

## Sessions and reconnection

Collector instances outlive connections, so every connect calls `reset()` on
each collector before starting it. Without that, `NetworkCollector`'s dedup set
makes the next app run's requests look like duplicates and silently drops them,
and `LogCollector`'s partial-line buffer prepends a fragment from the previous
run onto the next one's first line.

Each connect also opens a new store session. Every event is stamped with its
`sessionId`, and `query()` returns the current session by default — evidence
from a previous app run must never be correlated with this one, or the
diagnosis engine will happily construct a cause across the gap. Pass
`sessions: "all"` to read the whole retained history; the dashboard does, so a
human still sees the previous run's error after a hot restart.

When the socket drops unexpectedly the manager reconnects to the last known URI
with exponential backoff, bounded by `reconnectPolicy` (default: 1s doubling to
30s, 8 attempts). Every attempt, failure and recovery is recorded as a system
event, so the gap appears in the evidence timeline instead of looking like the
app went quiet. An explicit `disconnect()` never retries.

This recovers from transient drops — a sleeping device, a flaky cable, a
paused emulator. It does not recover from a full app relaunch, which allocates
a new VM Service URI; that needs a fresh `connect_vm`.

## Adding a runtime source

Implement `Collector`, register it in the `ConnectionManager` collector list.
Nothing else changes — the store, the tools and the dashboard pick it up through
the shared event shape.

**Register the handler before subscribing.** The VM Service delivers a backlog
of buffered events the moment a subscription is accepted, and that burst lands
before the code after `await streamListen` runs. Subscribing first discards
everything the app produced before the session connected — which, for a tool
that attaches to already-running apps, is most of the evidence.

```ts
export class MyCollector implements Collector {
  readonly name = "mine";
  async start(vm: VmService, store: RuntimeStore, isolateId: string) {
    vm.on("stream:SomeStream", (event) => store.add({ /* RuntimeEvent */ }));
    await vm.streamListen("SomeStream"); // last: the backlog arrives here
  }
}
```

## Design rules

Official Flutter and Dart APIs only — never scrape DevTools, never parse
screenshots. Structured JSON over text. One centralized store. Stateless tools.
Diagnosis anchored to evidence, with an explicit `Unknown` when the evidence is
thin. See [`Rules.md`](Rules.md).
