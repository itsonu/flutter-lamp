# Observability Roadmap

Audit of the observability/agent-intelligence target architecture against the
repository as of 0.11.0, and the phased plan that follows from it. The earlier
per-defect audit lives in [Improvement-Plan.md](Improvement-Plan.md); this
document maps the *architecture* — what exists, what is a real gap, and what is
rejected with reasons.

The governing pipeline:

```
Runtime → Collectors → Normalize → RuntimeStore → Correlate → Reduce
        → Targeted retrieval → Diagnose → Verify → Result (or UNKNOWN)
```

Rule of the house, already enforced and kept: **nothing deterministic is
delegated to the model.** Timestamps, gaps, percentiles, correlation windows,
diffs and identity are computed; the model consumes results.

## What already exists (mapped, not rebuilt)

| Target concept | Where it lives today | Shipped |
| --- | --- | --- |
| Stable evidence IDs (`exc_00142`) | `RuntimeStore.add`, `byEventId` | 0.6.0 |
| Session identity, reconnect, collector reset | `ConnectionManager`, `sessionId` on every event | 0.4.0 |
| Bounded retention, per-category, reported not hidden | per-category rings, `retention()` | 0.3.0 |
| Secret redaction at capture (headers, URIs, log text) | `core/redaction.ts` | 0.2.0 |
| Temporal correlation on intervals, relations `preceded/overlapped/followed` | `diagnosis/correlation.ts` | 0.7.0 |
| Diagnosis with evidence refs, timeline, alternatives, confidence breakdown, limitations, `unknown` | `diagnosis/engine.ts` | 0.7.0 |
| Progressive disclosure entry point | `runtime_health` verdict + citable ids | 0.8.0 |
| Incident-window investigation | `what_changed` (anchor, window, interval-matched network) | 0.8.0 |
| Explainability, missing evidence | `explain_diagnosis` | 0.8.0 |
| Capability discovery incl. `cannotObserve` | `get_capabilities` | 0.8.0 |
| Route-level attribution (exceptions, failures, jank per route) | `diagnosis/navigation.ts` | 0.9.0 |
| Performance diagnosis: percentiles, build/raster, correlated findings | `diagnosis/performance.ts` | 0.10.0 |
| Rebuild intelligence with file:line, app-vs-package | `RebuildCollector`, `get_rebuilds` | 0.11.0 |
| Tool safety metadata (read-only/mutating, single source) | `TOOL_SAFETY` map + MCP annotations | 0.5.0 |
| Canonical agent protocol with per-problem routing | `docs/AI-Agent-Integration.md` | 0.8.0+ |
| Platform boundaries stated (release builds, WebView, platform code) | `cannotObserve`, `limitations`, SECURITY.md | 0.2.0+ |

Language discipline the target asks for is already practice: growth is a
"memory growth pattern" not a leak, co-occurrence is a lead not a cause,
`caused_by` is never asserted, and rebuild activity is "high", never
"unnecessary", without evidence of waste.

## Phase A — Foundation (this release, 0.12.0)

Genuine gaps, smallest useful cut:

### Collector health

**Problem.** Collectors fail silently by design (`try/catch → return`). On a
target without `dart:io` HTTP profiling, `get_network` returns `[]` and nothing
distinguishes "no requests happened" from "the collector cannot see requests".
That violates the core honesty rule: *not observed* must never read as *did not
happen*.

**Current implementation.** `NetworkCollector.start()` and `refresh()` swallow
extension failures; `RebuildCollector` emits a one-off system event when widget
creation is untracked, discoverable only by reading logs.

**Design.** Optional `health(): {status, detail}` on the `Collector` interface —
`active | degraded | unavailable` — set at start and reset per session.
`ConnectionManager.collectorHealth()` joins it with per-category retained counts
and the newest event timestamp. Surfaced in `runtime_health` (with a note per
non-active collector) and `get_capabilities` (additive `collectorHealth` field;
`collectors` stays a name list for compatibility).

**Agent impact.** "Network collector: unavailable — do not treat empty network
evidence as absence of traffic" arrives in the first tool call instead of never.

### Evidence coverage on every diagnosis

**Problem.** `limitations` is prose; agents parse structure. Coverage — which
categories have evidence, what was evicted, the observed window — should be a
field, not a sentence.

**Design.** `diagnose_runtime` gains `coverage`: categories present/empty,
per-category evicted counts, oldest and newest retained event. Additive.

### Correlation identity

**Problem.** The event model has no place for a real runtime identity. The
dart:io HTTP profile provides one (`requestId`); it is buried in `data`.

**Design.** Nullable `correlationId` on `RuntimeEvent`, set only when the
runtime provides one. Never invented — the field stays null for sources with no
identity, exactly as the target requires. Identity *matching* joins the
correlation engine in Phase B when a second identity-bearing source exists;
today only network carries one, so there is nothing to join.

### Rejected in Phase A, with reasons

| Item | Verdict |
| --- | --- |
| Query indexes on the store | **Rejected at current scale.** Rings cap at 3,000/1,000; an unfiltered query scans ≤ 8,500 events via k-way merge, and ingestion measured 2.47M events/sec (0.3.0 benchmark). An index is a solution shopping for a problem; revisit only if caps grow 10×. |
| Monotonic timestamps | **Deferred, honestly.** Collectors stamp `Date.now()` because their sources (stream events) carry no usable monotonic clock; the only monotonic source (VM timeline `ts`) is fetched on demand and not stored. Adding an always-null field is schema theater. Revisit when timeline events are collected (Phase B). |
| `observed/inferred/correlated/hypothesized` enum on events | **Partially rejected.** Everything in the store is *observed* by construction — collectors never write inferences. Correlation and hypothesis provenance already live where they belong: relation types on correlations, strength on findings. An enum that always says `observed` adds nothing. |

## Phase B — Correlation and comparison

- **Baseline-vs-incident `what_changed`** — DONE (0.13.0). Adjacent equal
  windows, per-dimension directions with evidence, `unknown` when the baseline
  predates observation. Extended `what_changed`; no new tool.
- **Snapshots + `diff_runtime_snapshots`** — deterministic before/after
  comparison; also the verification primitive Phase E remediation needs.
- **Derived metrics** — error rate, p95 per endpoint, jank ratio, memory growth
  rate; computed from the store, queryable, never fabricated.
- **Timeline collection** — **BLOCKED by measurement (2026-08-25).** Verified
  live on a physical Android device (Dart 3.12, recorder "Ring") before
  building, per this document's own rule, and the source failed the audit:
  (1) GC events are B/E begin-end pairs, not complete events — pairing per
  (tid, name) is required to derive durations; (2) event `ts` shares a base
  with `getVMTimelineMicros`, so wall-clock calibration is possible;
  (3) the recorder **stalls silently once its buffer fills** (~24,500 events —
  under a minute of Dart+GC recording), while `getVMTimelineFlags` continues
  to report the streams as recorded; and (4) `clearVMTimeline` restores
  recording — an earlier read that nothing revives it was premature, corrected
  after a later live check showed 64ms lag following a clear. A collector is
  therefore *possible* via clear-on-stall self-healing, but shipping one on a
  source that lies about its own liveness needs a soak test on a real device,
  not a single session. What shipped now (0.14.0): `get_timeline` measures
  recorder staleness against the VM's timeline clock and labels stalled data,
  so the on-demand path can no longer present minutes-old events as current.
  GC correlation stays a stated limitation of `diagnose_performance` until the
  collector earns its way in.
- **Evidence graph (`get_evidence_graph`)** — typed in-memory nodes/edges over
  what `correlate()` and route attribution already compute; targeted queries
  only, never the whole graph. No graph database — that rejection stands.
- **Incident model** — detected/investigating/diagnosed/unknown lifecycle over
  an anchored window; the timeline reproducible from stored events, never from
  prose.

## Phase C — Agent intelligence

- Investigation profiles (crash/performance/network/memory/startup) as
  metadata in `get_capabilities` — not new tools.
- Cost metadata per tool (cheap/normal/expensive/state-changing) alongside the
  existing safety map, one source of truth.
- Compressed summaries: error signatures over raw logs, endpoint aggregates
  over raw requests; drill-down by id.
- Verification stage in diagnosis: every cited id must resolve
  (`byEventId`), timeline must be internally consistent, contradictory evidence
  listed per hypothesis.

## Phase D — Evaluation — STARTED (0.19.0)

Done, in `eval/` and `src/eval/`:

- **Golden incidents** — recorded sessions with expected cause, evidence ids and
  a confidence band, including a negative where `unknown` is correct. Three so
  far. Two deliberately straddle the jank threshold (19.4% must stay unknown,
  20.0% must be diagnosed) so they pin the boundary rather than two unrelated
  points. The other two are a ranking pair: an uncaught `StateError` with a stack
  where `exception` is right, and a `RenderFlex overflowed` alongside build-bound
  jank where `jank` is right. Both contain an exception and jank over threshold,
  so no fixed ordering of the two hypotheses satisfies both — which is how the
  unconditional `exception` priority was found to be wrong. A fifth covers
  `network` against a local server that fails one endpoint, and doubles as the
  first proof that header redaction runs at capture rather than only in a unit
  test. A sixth covers `memory` — twelve monotonically rising heap samples, no
  drop, with `externalUsageMB` flat at 0 and capacity climbing alongside usage.
  Every `CauseKind` now has a recording.

Measured while recording it, on a real device over adb TCP: `clockOffsetMs` is
**-839ms**. The phone's clock runs most of a second behind the recorder's. That
is the first real reading of the skew the previous commit made observable, and
it is nearly a third of the 3s correlation window — which is why our own notes
and the app's events must not be compared naively, and why the offset is
reported rather than silently corrected.
- **Replay harness** over `export_session` output. Needed `RuntimeStore.hydrate`,
  because `add()` mints fresh ids and replaying through it would renumber every
  event and invalidate every cited `exc_00042`.
- **Metrics**: top-1 accuracy, evidence recall, false-confidence rate, unknown
  precision, dangling-evidence count.
- **A CI gate**, asymmetric on purpose: accuracy has a floor, false confidence
  has a ceiling of zero. Verified by mutation in both directions rather than
  assumed — loosening the jank threshold trips false confidence, tightening it
  trips only accuracy; blinding the exception detector trips false confidence,
  removing only its stack-trace confidence bonus trips the band and not the
  ceiling.

The enabler was not the harness. `Diagnosis.rootCause` is prose containing live
numbers ("worst was 85ms"), so nothing could be scored against it; the engine now
emits `cause` as a stable `CauseKind` label beside it. Additive.

Still open:

- Ranking edges that no recording constrains. Found by mutation: promoting
  `memory` above `jank` passes the whole eval suite. Pinned by unit test for
  now; a recording needs a session that both stutters and grows, where which is
  cause and which is symptom is genuinely arguable.
- A recorded incident for the demotion itself — an incidental exception with no
  competing hypothesis. Unit-tested, not recorded.
- Tool calls and tokens per diagnosis. Not measured; needs instrumentation at
  the MCP layer rather than in replay.
- Enough incidents for top-1 accuracy to be a measurement rather than a
  regression guard. Three is a floor.

The exception incident needed a probe change, not an engine change:
`bloc_probe`'s handler failures are absorbed by `BlocObserver.onError` and
`riverpod_probe`'s become an `AsyncError`, so neither ever reached
`FlutterError.reportError`. A widget that throws inside `build` does, and the
inspector posts it as `Flutter.Error` — `isStructuredErrorsEnabled()` defaults
to true in debug off the web, which is why the event exists at all
(`widget_inspector.dart:1028`).

Recording the ranking pair surfaced the transport limit that any timing argument
has to respect, and it has since been fixed at the source. Events were stamped
on receipt, and over adb/WiFi delivery stalls for seconds and then flushes — 111
frame events inside one second, above any refresh rate; the DDS backlog drained
at connect has the same property, since within it receipt order is drain order.

Every VM Service `Event` already carried the time the VM posted it, and the
collectors now use it. Measured before the change: six backlog frames within 1ms
of each other by receipt against 331ms of real spread. After: at most 10 frames
in any second against a 100ms tick, median gap 103.0ms. This is what the 3s
correlation window, `what_changed`'s baseline-versus-incident comparison, and
every future ordering-sensitive incident rest on.

Left as a known, reported property rather than corrected: this server's own
notes and polled memory samples still carry the host clock, so a timeline can
mix two clocks. `clockOffsetMs` is on the status tool and in every export;
correcting it without ever measuring a genuinely skewed device would be a guess
applied to every timestamp.

Capturing the exception incident surfaced a real defect ahead of the golden: `diagnose()` read a
flat most-recent-2,000-event window, and the probe's 2,000 provider events in 30
seconds pushed the session's only exception to 2,436th newest. The engine
reported that no exceptions were found while the store held one. Fixed by
removing the cap — retention is the only truncation, and `coverage.evicted`
already reports it.

## Phase E — Advanced

- Riverpod/Provider/Bloc activity collector — DONE (0.17.0). Measured: posts
  `riverpod:new_event {offset}` with **no** `ext.riverpod.*` RPC, so activity
  can be counted and correlated with rebuild storms; values cannot be read.
  Bloc measured: not natively instrumented and not directly observable, but
  a flutter_bloc app still surfaces through `provider`, which it depends on
  transitively. Those events count notified dependents, not transitions.
- Startup profile, `diagnose_memory` (patterns, never "leak" without
  evidence), code correlation ("candidate regression", never "this commit
  caused it"), incident memory (`validated | unverified | historical`).
- Safe remediation: diagnose → propose → approve → act → re-observe → verify by
  snapshot diff. Never silent edits.

## Standing rejections

Generic APM, DevTools replacement, autonomous modification, graph database,
foundation-model training, cloud infrastructure, tool sprawl (16 tools with
disjoint jobs is the ceiling until one demonstrably earns its place),
vendor-coupled AI. External providers (OTel, Sentry, Crashlytics) wait for a
`RuntimeEvidenceProvider` abstraction and a demonstrated need — terminology
stays OTel-compatible so adapters remain possible.
