# Audit and Improvement Plan

Audit of Flutter Lamp at v0.1.0 (1,684 lines of TypeScript, 9 tests), and the
prioritized backlog that comes out of it.

Findings are marked **Verified** where the code was read and the behaviour
follows directly from it, or **Needs check** where confirming it requires a live
Flutter app.

## Verdict

The architecture is sound and does not need rewriting. The collector interface,
the single centralized store, and the stateless-tools rule all hold up, and the
diagnosis engine genuinely anchors to captured events rather than inventing
causes. Adding a runtime source really does cost one file plus one line.

The problems are not architectural. They are a security gap in what gets exposed,
an evidence-retention bug that quietly destroys the data the product exists to
provide, and reconnection state that survives when it should not.

Nothing below proposes replacing working code to make it look cleaner.

---

## What already works

| Area | Assessment |
| --- | --- |
| `VmService` | Correct JSON-RPC correlation, sane URI normalization, tolerates duplicate `streamListen` (error 103), fails pending calls on close. |
| Collector interface | Genuinely minimal. `start()` plus optional `refresh()` covers push and pull sources without special-casing. |
| `RuntimeStore` | Right idea — one buffer, one shape, emitter-based fan-out with a single subscription regardless of browser count. |
| `flutterError.ts` | The hard part of the project, and it is done properly. Walking the `DiagnosticsNode` tree to reconstruct a stack is the only way this works, and it is unit-tested plus covered by a mock-VM integration test. |
| Diagnosis engine | Evidence-anchored by construction: the root cause is always a stored event. Reports `Unknown` rather than guessing. |
| Dashboard | Correctly independent of stdio, correctly reuses the store as its only source, correctly gates the memory sampler on "someone is watching". |
| Tools | Stateless, JSON-only, consistent error shape. |

## What should not change

The collector model. The single store. Stateless tools. Official-APIs-only.
The `Unknown` behaviour. The zero-dependency dashboard. Existing MCP tool names
and their current output fields.

---

## P0 — Reliability and security

### P0-1 Network headers are captured and exposed unredacted

**Current state.** `NetworkCollector.refresh()` enriches every failing or slow
request with full request and response headers via `getHttpProfileRequest`, and
copies them verbatim into the event payload (`src/collectors/networkCollector.ts:80`).

**Problem.** Those headers routinely contain `Authorization` bearer tokens,
`Cookie`, `Set-Cookie`, and API keys. They land in the store, and the store is
served to the AI agent through `get_network` and `diagnose_runtime` *and*
broadcast to every connected browser over the dashboard WebSocket. A developer
debugging an authenticated request ships their session token to whatever model
is on the other end of the MCP connection. **Verified.**

**Proposed change.** A redaction layer applied where evidence leaves the store.
Default deny-list covering `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`,
`Proxy-Authorization`, and any header matching
`/token|secret|password|api[-_]?key/i`. Value-level detection for JWT-shaped
strings in bodies and log lines. Configurable additional patterns; configurable
opt-out for a developer who knowingly wants raw values locally. Keep the raw
value in the internal event and redact on the way out, so the dashboard can
offer a local reveal that the AI-facing path never gets.

**Files.** New `src/core/redaction.ts`. `src/collectors/networkCollector.ts`,
`src/tools.ts`, `src/dashboard/server.ts`.

**API changes.** None to tool names or shapes. Header values become
`[REDACTED]`. Additive `redacted: true` marker on affected fields.

**Tests.** Deny-list coverage per header; case-insensitivity; custom patterns;
JWT value detection; opt-out path; a test asserting no redacted value reaches
the dashboard broadcast.

**Risk.** Low. Over-redaction is the failure mode, mitigated by the marker and
the local reveal.

### P0-2 The dashboard WebSocket accepts any origin

**Current state.** `new WebSocketServer({ server: httpServer, path: "/ws" })`
with no origin verification (`src/dashboard/server.ts:60`). Binding defaults to
`127.0.0.1`, which is correct and should stay.

**Problem.** Localhost binding does not protect a WebSocket. Browsers do not
apply the same-origin policy to WebSocket connections and send no preflight, so
**any web page the developer has open can connect to `ws://127.0.0.1:7373/ws`**
and receive the full runtime stream — logs, network requests, and, until P0-1
lands, auth headers. This is cross-site WebSocket hijacking, and it needs no
cooperation from the developer beyond having a tab open. **Verified by
inspection**; the `verifyClient` or origin check that would prevent it is absent.

**Proposed change.** Reject connections whose `Origin` header is present and not
in an allow-list (`http://localhost:PORT`, `http://127.0.0.1:PORT`). Add a
per-process random token embedded in the served page's URL and required by the
WebSocket handshake, so a blind cross-origin connect fails even if origin
checking is bypassed. Optional read-only mode. An explicit warning logged when
`DASHBOARD_HOST` is set to anything other than a loopback address.

**Files.** `src/dashboard/server.ts`, `dashboard/index.html`.

**API changes.** None to MCP tools. The dashboard URL gains a token query
parameter; `get_dashboard_url` returns the full URL, so agents and users are
unaffected.

**Tests.** Connection rejected with a foreign `Origin`; accepted with a loopback
origin; accepted with no origin (native clients); rejected with a bad token;
warning emitted on non-loopback bind.

**Risk.** Low, contained to the dashboard.

### P0-3 Frame events evict all other evidence within about 90 seconds

**Current state.** One shared ring buffer, capacity 5,000
(`src/core/runtimeStore.ts:33`), oldest-first eviction.

**Problem.** `FrameCollector` stores an event per frame. At 60fps that is 60
events per second, so frames alone fill the entire buffer in roughly 83 seconds
and then evict everything older — including the exceptions, network requests and
logs the product exists to preserve. Connect, let the app idle for two minutes,
and the exception from minute one is gone. This directly contradicts the
"never lose runtime history" rule and silently degrades every diagnosis run on a
long-lived session. **Verified.**

**Proposed change.** Per-category retention rather than one global cap: generous
budgets for exceptions and network, a smaller rolling window for frames. Keep
frame *aggregates* (count, jank count, percentiles per window) beyond the raw
retention window so performance diagnosis still has history after individual
frames roll off. Make caps configurable and report them in `runtime_status` so
the agent knows the retention horizon it is reasoning inside.

**Files.** `src/core/runtimeStore.ts`, `src/collectors/frameCollector.ts`,
`src/tools.ts`.

**API changes.** Additive `retention` block in `runtime_status`.

**Tests.** Frame flood does not evict exceptions; per-category caps enforced;
aggregates survive raw eviction; `counts()` stays correct across eviction.

**Risk.** Medium — this is the storage layer everything reads. Mitigated by the
existing store tests plus new eviction tests.

### P0-4 Ring buffer trim is O(n) on every insert past capacity

**Current state.** `this.events.splice(0, this.events.length - this.capacity)`
runs on every `add()` once full (`src/core/runtimeStore.ts:42`).

**Problem.** Copies the whole 5,000-element array on every subsequent insert. At
60 frames per second that is 300,000 element moves per second, inside the tool
whose job is diagnosing performance problems. **Verified.**

**Proposed change.** A real circular buffer, or batched trimming with a
high-water mark. Fold into P0-3 since both touch the same code.

**Files.** `src/core/runtimeStore.ts`.

**API changes.** None. `query()` must keep returning most-recent-first.

**Tests.** Existing query and count tests must pass unchanged; add an ingestion
throughput benchmark as a regression guard.

**Risk.** Low if the public surface is held constant.

### P0-5 Collector state survives reconnection

**Current state.** `ConnectionManager` builds its collectors once as a field
initializer (`src/core/connection.ts:18`) and reuses the same instances for every
subsequent `connect()`.

**Problem.** Two collectors hold per-session state that is never reset.
`NetworkCollector.stored` is a `Set` of request ids already recorded
(`src/collectors/networkCollector.ts:18`); ids restart from low numbers in a new
app run, so after a hot restart or reconnect, **new requests are silently
discarded as duplicates**. `LogCollector.carry` holds the incomplete tail of the
last line (`src/collectors/logCollector.ts:21`) and will prepend a fragment from
the previous session onto the first line of the next. The store is also not
cleared on connect, so evidence from two different app runs interleaves in one
timeline with no marker. **Verified.**

**Proposed change.** Add an optional `reset()` to the `Collector` interface,
called on every connect. Introduce a session concept: a new `sessionId` per
connect, stamped on every event, with the store either cleared or explicitly
segmented so cross-session evidence is never silently mixed.

**Files.** `src/collectors/collector.ts`, `src/collectors/networkCollector.ts`,
`src/collectors/logCollector.ts`, `src/core/connection.ts`, `src/core/events.ts`.

**API changes.** Additive `sessionId` on every event.

**Tests.** Reconnect then assert new requests are captured; assert no log
fragment carries across; assert events from two sessions are distinguishable.

**Risk.** Low.

### P0-6 No reconnection handling

**Current state.** On socket close the manager records a system event and drops
its references (`src/core/connection.ts:32`).

**Problem.** Hot restart, a device sleeping, or a flaky cable ends the session
permanently. The agent has to notice `connected: false` and re-issue `connect_vm`
with a URI it may no longer have. **Verified.**

**Proposed change.** Bounded exponential-backoff reconnection to the last known
URI, with attempts recorded as system events so the gap is visible in the
evidence timeline rather than being invisible dead air.

**Files.** `src/core/connection.ts`, `src/vm/vmService.ts`.

**API changes.** Additive reconnection state in `runtime_status`.

**Tests.** Mock VM drops the socket; assert reconnect, backoff bounds, give-up
behaviour, and that collectors are restarted and reset on success.

**Risk.** Medium — retry loops are easy to get wrong. Strict attempt caps.

### P0-7 Inspector object groups are never disposed

**Current state.** Every `get_widget_tree` and `get_selected_widget` call passes
a constant `groupName` (`src/tools.ts:182`, `src/tools.ts:204`) and never calls
`ext.flutter.inspector.disposeGroup`.

**Problem.** Inspector groups pin widget and element references inside the target
app. Repeated calls grow the debugged app's memory — a small leak, but one caused
by the tool that is supposed to be diagnosing memory. **Verified by inspection**;
magnitude **needs check** against a real app.

**Proposed change.** Per-call group names, disposed after the response is
serialized.

**Files.** `src/tools.ts`.

**API changes.** None.

**Tests.** Mock VM asserts `disposeGroup` is called for each created group,
including on the error path.

**Risk.** Low.

### P0-8 Tests share process-wide state and a hardcoded port

**Current state.** `vmIntegration.test.ts` and `dashboard.test.ts` both drive the
global `connection` singleton, and the dashboard test hardcodes port 7390.

**Problem.** Order-dependent tests, and a bind failure if the port is taken. The
suite passes today because it happens to run in a favourable order. **Verified.**

**Proposed change.** Port 0 with the assigned port read back. A factory for
`ConnectionManager` so tests get an isolated instance while production keeps the
singleton export.

**Files.** `src/core/connection.ts`, `src/dashboard/server.ts`, both test files.

**API changes.** None to the exported singleton.

**Tests.** The suite passing in a randomized order.

**Risk.** Low.

### P0-9 Tools do not declare their safety class

**Current state.** All twelve tools are registered identically.

**Problem.** Two of them mutate state. `get_timeline` with `recordFrom: true`
calls `setVMTimelineFlags`, changing VM recording configuration
(`src/tools.ts:243`), and `NetworkCollector.start()` enables
`httpEnableTimelineLogging` on the app at connect
(`src/collectors/networkCollector.ts:22`). Both are benign and both are
undeclared, so an agent cannot distinguish an inspection from a mutation.
**Verified.**

**Proposed change.** Annotate every tool `read-only`, `diagnostic` or
`mutating`, expose the classification through `get_capabilities` (P1-6), and
document the connect-time mutation explicitly.

**Files.** `src/tools.ts`, docs.

**API changes.** Additive annotations.

**Tests.** Assert every registered tool carries a classification.

**Risk.** None.

---

## P1 — Evidence intelligence

### P1-1 Evidence has no stable identity

Event ids are per-store incrementing integers with no session scope
(`src/core/events.ts:20`). A diagnosis cannot cite `exc_00142` in a way that
survives a reconnect or an export. Introduce `sessionId`, a monotonic `sequence`,
and a typed stable id (`exc_`, `net_`, `frm_`, `log_`). Keep the numeric `id` as
an alias so nothing breaks.

### P1-2 Network timestamps need verification

`NetworkCollector` stamps events with `microsToMs(r.startTime)`
(`src/collectors/networkCollector.ts:90`) while every other collector uses
`Date.now()`. If the HTTP profile's `startTime` is monotonic microseconds since
VM start rather than microseconds since epoch, network events sit decades away
from everything else on the timeline and the 3-second correlation window in
`diagnose()` never matches them — meaning the flagship
"HTTP 500 caused this exception" correlation silently never fires in production
while the unit test passes, because that test constructs both timestamps from the
same base. **Needs check against a live app before anything else in P1.** If
confirmed, normalize at the collector boundary and add a mock-VM regression test
using realistic profile values.

### P1-3 Confidence is an undocumented heuristic

`diagnose()` starts at 0.7 and adds 0.1 for a stack trace, 0.1 for a correlated
network error, 0.05 for correlated logs (`src/diagnosis/engine.ts:52`), and
`unknown()` hardcodes 0.3. These are reasonable product policy and are not a
calibrated probability. Document them as policy, split the single number into
evidence strength, data completeness and alternative-hypothesis strength, and
state plainly that the 70% threshold is a conservative choice rather than a
measured one.

### P1-4 Correlation is private, fixed-window and partial

`correlate()` is a private ±3s filter (`src/diagnosis/engine.ts:124`). Extract a
reusable temporal correlation module answering before, after, within-N and
"what changed around time T", with typed relationships
(`caused_after`, `preceded`, `affected`, `correlated_with`) held in memory and
indexed by event id. No graph database — typed relationships plus indexes cover
the queries an agent asks, and there is no scale problem to justify a store.

### P1-5 Memory and timeline are collected but never diagnosed

`sampleMemory()` writes snapshots into the store and `get_timeline` reads trace
events, yet `diagnose()` examines only exceptions, network and frames
(`src/diagnosis/engine.ts:39`). Fold both in — this is the original Phase 7 and
the cheapest available accuracy gain.

### P1-6 Missing agent-facing tools

`runtime_health` (one compact call instead of six), `what_changed` (evidence in a
window before an incident), `explain_diagnosis` (claim, evidence ids, timeline,
alternatives, missing evidence), and `get_capabilities` (which collectors are
active, which tools exist and their safety class, what this target cannot
observe). All additive.

### P1-7 Diagnosis output lacks structure for citation

Add `status`, `timeline`, `alternativeCauses`, `limitations`, and evidence ids on
every claim. Keep every existing field so current consumers keep working.

---

## P2 — Developer intelligence

Navigation awareness (current route, transitions, route-scoped exceptions and
network). Optional Riverpod and Bloc adapters — optional collectors, never hard
dependencies, and rebuild conclusions only where evidence supports them.
`diagnose_performance` correlating jank with widget activity, GC, memory and
network.

## P3 — Session intelligence

A versioned, machine-readable session export covering metadata, events,
correlations and diagnoses, suitable for bug reports, offline analysis and
regression tests. Plus a compact AI-facing artifact carrying the smallest
sufficient context rather than the whole buffer.

## P4 — Agent capabilities

Proposed fixes, code-change correlation, and policy-controlled remediation —
always diagnose, propose, show evidence, request approval, then act. Not started
until P0 through P2 are reliable.

---

## Project hygiene

Missing `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and issue and PR
templates. CI runs build and test but no linter and no formatter check. Add
those alongside P0; they are cheap and they set the contribution bar.

## Known design limits

`ConnectionManager` is a process-wide singleton, so one server instance observes
one app at a time. Debugging two Flutter apps at once needs two server instances
on different dashboard ports. Worth revisiting only if the constraint bites.

---

## Sequencing

P0-1 and P0-2 first — they are security, and everything else is a feature. P0-3
with P0-4 next, since they share the storage layer and the eviction bug destroys
the evidence every other item depends on. Then P0-5 through P0-9. P1-2 must be
resolved before the rest of P1, because it determines whether correlation works
at all today.

Small, reviewable changes. Each one keeps the build green, the tests passing,
and every existing tool working.
