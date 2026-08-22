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
   · single capped ring buffer, the only source of runtime evidence
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
| `ConnectionManager` | `src/core/connection.ts` | Singleton lifecycle. Connect/disconnect, isolate resolution, collector startup, pull-collector refresh, shared `sampleMemory()`. |
| `Collector` | `src/collectors/collector.ts` | Interface: `start()` to subscribe, optional `refresh()` for sources with no push stream. |
| `RuntimeStore` | `src/core/runtimeStore.ts` | Capped ring buffer, filtered query, per-category counts, live event emission. |
| Diagnosis engine | `src/diagnosis/engine.ts` | Correlates stored events into a root cause anchored to a real event. Never invents a cause. |
| MCP tools | `src/tools.ts` | Stateless. All state lives in `ConnectionManager`; tools return JSON only. |
| Dashboard | `src/dashboard/server.ts` | Native HTTP + WebSocket. One store subscription fanned out to all browsers. |

## The event model

Every collector produces the same shape (`src/core/events.ts`):

```ts
interface RuntimeEvent {
  id: number;               // monotonic, assigned by the store
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

Widget tree, selected widget, memory and timeline are **not** collectors — they
are direct RPCs issued by the tool that needs them (`connection.isolateCall`).
Memory additionally snapshots into the store so diagnosis can reference it.

`Flutter.Error` deserves a note: `extensionData` is a serialized `DiagnosticsNode`
tree, not a flat object. The stack trace is a run of child nodes whose
`description` matches `#N  …`. `src/collectors/flutterError.ts` walks the tree
and reconstructs the stack, summary and offending widget. This is the only
reliable way to get a stack out of a realtime framework error.

## Adding a runtime source

Implement `Collector`, register it in the `ConnectionManager` collector list.
Nothing else changes — the store, the tools and the dashboard pick it up through
the shared event shape.

```ts
export class MyCollector implements Collector {
  readonly name = "mine";
  async start(vm: VmService, store: RuntimeStore, isolateId: string) {
    await vm.streamListen("SomeStream");
    vm.on("stream:SomeStream", (event) => store.add({ /* RuntimeEvent */ }));
  }
}
```

## Design rules

Official Flutter and Dart APIs only — never scrape DevTools, never parse
screenshots. Structured JSON over text. One centralized store. Stateless tools.
Diagnosis anchored to evidence, with an explicit `Unknown` when the evidence is
thin. See [`Rules.md`](Rules.md).
