# Audit and Improvement Plan

Audit of Flutter Lamp at v0.1.0 (1,684 lines of TypeScript, 9 tests), and the
prioritized backlog that comes out of it.

**Progress:** P0 is complete — P0-1/P0-2 in 0.2.0, P0-3/P0-4 in 0.3.0,
P0-5/P0-6 in 0.4.0, P0-7/P0-8/P0-9 in 0.5.0. P1-1 and P1-2 in 0.6.0.
P1-3, P1-4, P1-7 and P1-8 in 0.7.0, with P1-5 partly done there.
P1-6 and P2-P4 remain open.

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

### P0-1 Network headers are captured and exposed unredacted — DONE (0.2.0)

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

**As shipped.** Redaction happens at *capture* rather than on the way out, so
secrets never enter the store at all. That drops the raw-value-plus-filter
design above along with its dashboard reveal, and is both simpler and strictly
safer: a future consumer — session export, a new tool — cannot leak what was
never written. The env opt-out covers the case the reveal was for. Implemented
in `src/core/redaction.ts`, wired into the network, log and exception
collectors, with unit tests plus an integration test asserting no credential
from a realistic HTTP profile reaches the store.

### P0-2 The dashboard WebSocket accepts any origin — DONE (0.2.0)

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

**As shipped.** Token delivery is by inlining it into the served HTML rather
than putting it in the URL: cross-origin script cannot read a response body, so
the token stays out of reach while `http://127.0.0.1:7373` remains
bookmarkable. `X-Frame-Options: DENY` stops the token-bearing page being framed,
and `/health` no longer returns `wsUri` (it embeds the VM's auth token).
Verified live against a running server: a foreign origin is refused 403 with a
valid token, a tokenless connect is refused, the real page connects.

### P0-3 Frame events evict all other evidence within about 90 seconds — DONE (0.3.0)

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

**As shipped.** One ring buffer per category (3,000 log / 1,000 exception /
1,000 network / 1,000 frame / 500 system), overridable through the
`RuntimeStore` constructor, with an unfiltered `query()` performing a k-way
merge so callers still see one chronological stream and can still stop early.
`runtime_status.retention` reports capacity, retained, evicted and the oldest
event held.

Frame *aggregates* were deferred rather than built. Their stated purpose is
performance diagnosis after raw frames roll off, and `diagnose_performance` is
P2 — building the aggregate store now would add a second source of runtime truth
alongside `RuntimeStore` with no consumer for it. Revisit with P2; per-category
retention already fixes the eviction bug on its own.

Environment-variable configuration of the caps was also skipped. The constructor
override covers embedders and tests; add env config when someone needs it.

### P0-4 Ring buffer trim is O(n) on every insert past capacity — DONE (0.3.0)

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

**As shipped.** A fixed-size circular buffer with an eviction counter.
Benchmarked against the 0.2.0 implementation: 200,000 events in 81ms versus
9,943ms, a 122x improvement. A loose throughput assertion guards against a
regression to O(n) without being flaky on a slow runner.

### P0-5 Collector state survives reconnection — DONE (0.4.0)

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

**As shipped.** Optional `reset()` on the `Collector` interface, called before
`start()` on every connect. The store is segmented rather than cleared: events
carry `sessionId` and `query()` defaults to the current session, so history
survives a hot restart for the human watching the dashboard
(`sessions: "all"`) while agents never see two runs as one.

### P0-6 No reconnection handling — DONE (0.4.0)

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

**As shipped.** `reconnectPolicy` (1s doubling to 30s, 8 attempts) with every
attempt, failure and recovery recorded as a system event. Staleness is handled
by identity rather than a flag: the close handler ignores the event when
`this.vm` is no longer that socket, so a superseded connection cannot tear down
its replacement. Timers are `unref`'d. Tested against a mock VM for successful
recovery, exhausting the attempt cap, and an explicit disconnect staying
closed.

Scope limit worth stating: this recovers transient drops, not a full app
relaunch, which allocates a new VM Service URI that Flutter Lamp has no way to
discover.

### P0-7 Inspector object groups are never disposed — DONE (0.5.0)

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

**As shipped.** Extracted to `src/vm/inspectorGroup.ts` with the isolate caller
injected, so the disposal contract is testable without a live VM. Covers the
success path, the throwing path, a failing dispose not corrupting a successful
read, and per-call group uniqueness.

### P0-8 Tests share process-wide state and a hardcoded port — DONE (0.5.0, partly retracted)

**Current state.** `vmIntegration.test.ts` and `dashboard.test.ts` both drive the
global `connection` singleton, and the dashboard test hardcodes port 7390.

**Problem.** Order-dependent tests, and a bind failure if the port is taken. The
suite passes today because it happens to run in a favourable order. **Verified.**

**Correction.** The "shared process-wide state" half of this finding was wrong.
`node --test` runs each test *file* in its own child process — confirmed by
printing `process.pid` from two files and getting 8052 and 9196 — so the global
`connection` singleton is not shared across files. Sharing only happens between
tests *within* one file. The hardcoded port was a real defect; the isolation
concern was overstated.

**Proposed change.** Port 0 with the assigned port read back. A factory for
`ConnectionManager` so tests get an isolated instance while production keeps the
singleton export.

**Files.** `src/core/connection.ts`, `src/dashboard/server.ts`, both test files.

**API changes.** None to the exported singleton.

**Tests.** The suite passing in a randomized order.

**Risk.** Low.

**As shipped.** `DASHBOARD_PORT=0`, with `startDashboard()` binding before it
computes the URL or the allowed-origin set, so the assigned port is real
everywhere it is used. The `ConnectionManager` factory was **not** built: per
the correction above it would solve a problem that does not exist across files,
and within `session.test.ts` clearing the store between tests is a two-word fix
against a whole extra construction path. Revisit only if tests ever need to run
concurrently inside one file.

### P0-9 Tools do not declare their safety class — DONE (0.5.0)

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

**As shipped.** Standard MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) on all twelve tools, plus an explicit note in
the description of the two mutating ones — annotations are hints a client may
ignore, while the model always reads the description. Tested through a real MCP
client over an in-memory transport, which also gives the project its first test
of the actual tool surface. `get_capabilities` still belongs to P1-6; the
classification is already exposed through `tools/list`.

---

## P1 — Evidence intelligence

### P1-1 Evidence has no stable identity — DONE (0.6.0)

Event ids are per-store incrementing integers with no session scope
(`src/core/events.ts:20`). A diagnosis cannot cite `exc_00142` in a way that
survives a reconnect or an export. Introduce `sessionId`, a monotonic `sequence`,
and a typed stable id (`exc_`, `net_`, `frm_`, `log_`). Keep the numeric `id` as
an alias so nothing breaks.

**As shipped.** `eventId` on every event — `exc_00142`, `net_00143` — built from
the store's monotonic counter, so ids are unique across categories *and*
sessions and never reused. `sessionId` already arrived in 0.4.0; a separate
`sequence` field was skipped because the numeric `id` already is one. Diagnosis
evidence carries `eventId`, and `RuntimeStore.byEventId()` resolves a cited id
back to the event — a citation nothing can dereference is decoration.

### P1-2 Network timestamps need verification — RESOLVED, NOT A BUG (0.6.0)

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

**Outcome: the concern was unfounded.** Checked against the Dart SDK source
rather than guessed. Dart 3.12.1, `sdk/lib/_http/http_impl.dart:62`:

```dart
requestStartTimestamp = DateTime.now().microsecondsSinceEpoch;
```

`startTime` is epoch microseconds, so `microsToMs()` already puts network events
on the same timeline as every other collector and correlation does fire. No code
change was needed. A regression test now pins the assumption to realistic epoch
values, so a future change to the profile format fails a test instead of quietly
blinding the diagnosis engine.

Verifying it did surface a real defect in the same area — see P1-8.

### P1-8 Correlation matches on when a request *started*, not when it failed — DONE (0.7.0)

Network events are stamped with `startTime` (`src/collectors/networkCollector.ts:90`),
and `diagnose()` correlates on `Math.abs(event.timestamp - anchor.timestamp) <= 3s`
(`src/diagnosis/engine.ts:124`). For a fast request those are the same moment, so
the common case works. For a slow one they are not: a request that begins 30
seconds before an exception and returns 500 immediately before it falls outside
the window and is never offered as evidence — and a slow or hanging request is
exactly the kind that causes the exception.

The window should test the request's *interval* against the anchor, or at
minimum use `endTime`. Found while verifying P1-2. **Verified by inspection**;
fix belongs with the correlation work in P1-4.

**As shipped.** Fixed by the interval model in `correlation.ts`: a request is
adjacent to a failure when any part of its span is within the window, and the
reported `deltaMs` is measured from the nearer edge. A request still in flight
when the exception fires now reports `overlapped` with a delta of 0. Covered by
tests for the slow-failure case, the long-finished case, the in-flight case,
and end to end through `diagnose_runtime`.

### P1-3 Confidence is an undocumented heuristic — DONE (0.7.0)

`diagnose()` starts at 0.7 and adds 0.1 for a stack trace, 0.1 for a correlated
network error, 0.05 for correlated logs (`src/diagnosis/engine.ts:52`), and
`unknown()` hardcodes 0.3. These are reasonable product policy and are not a
calibrated probability. Document them as policy, split the single number into
evidence strength, data completeness and alternative-hypothesis strength, and
state plainly that the 70% threshold is a conservative choice rather than a
measured one.

**As shipped.** The arithmetic is unchanged — altering the scoring and the
reporting in one step would leave neither reviewable. What changed is honesty:
`confidenceBreakdown` reports evidence strength, data completeness and the
strength of the best competing explanation as separate numbers, with a `basis`
string stating the figure is a conservative heuristic and not calibrated.
Completeness is the fraction of categories with evidence, penalised when
retention dropped anything. Recalibrating the weights against real sessions is
future work and needs data this project does not have yet.

### P1-4 Correlation is private, fixed-window and partial — DONE (0.7.0)

`correlate()` is a private ±3s filter (`src/diagnosis/engine.ts:124`). Extract a
reusable temporal correlation module answering before, after, within-N and
"what changed around time T", with typed relationships
(`caused_after`, `preceded`, `affected`, `correlated_with`) held in memory and
indexed by event id. No graph database — typed relationships plus indexes cover
the queries an agent asks, and there is no scale problem to justify a store.

**As shipped.** `src/diagnosis/correlation.ts`: `intervalOf`, `gapMs`,
`correlate` (nearest-first), `precededBy`, and `timelineAround`. Relations are
`preceded` / `overlapped` / `followed` / `anchor`, carried on each correlated
event alongside a signed `deltaMs`, rather than materialised as a separate
relationship graph — the relation is derivable from the interval arithmetic, so
storing it twice would be two things to keep in sync. A persisted graph remains
unjustified. This also fixed P1-8.

### P1-5 Memory and timeline are collected but never diagnosed — PARTLY DONE (0.7.0)

`sampleMemory()` writes snapshots into the store and `get_timeline` reads trace
events, yet `diagnose()` examines only exceptions, network and frames
(`src/diagnosis/engine.ts:39`). Fold both in — this is the original Phase 7 and
the cheapest available accuracy gain.

**Memory: done (0.7.0).** Sustained heap growth across a session's samples is a
hypothesis now — lowest priority, never outranking an exception, and its own
recommendation leads with the fact that growth is not proof of a leak.

**Timeline: not done, and not cheap.** Timeline events are fetched on demand and
never stored, so folding them in means either a new collector that stores them
or a slow VM call inside every diagnosis. The honest interim is what shipped:
`limitations` now states that timeline events take no part in correlation, so an
agent knows the blind spot exists rather than assuming coverage.

### P1-6 Missing agent-facing tools

`runtime_health` (one compact call instead of six), `what_changed` (evidence in a
window before an incident), `explain_diagnosis` (claim, evidence ids, timeline,
alternatives, missing evidence), and `get_capabilities` (which collectors are
active, which tools exist and their safety class, what this target cannot
observe). All additive.

### P1-7 Diagnosis output lacks structure for citation — DONE (0.7.0)

Add `status`, `timeline`, `alternativeCauses`, `limitations`, and evidence ids on
every claim. Keep every existing field so current consumers keep working.

**As shipped.** All of it, with every prior field unchanged. Hypotheses are now
explicit and ranked by (priority, strength), so the runner-up becomes an
`alternativeCause` with its own cited evidence instead of being discarded by an
if/else chain. Priority preserves the original ordering — an actionable
exception still beats a performance pattern — so the primary result for any
given evidence is the same as before.

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
