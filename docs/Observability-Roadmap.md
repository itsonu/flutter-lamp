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

## Phase D — Evaluation

- Golden incidents: recorded sessions with expected hypothesis, expected
  evidence ids, acceptable confidence band — including negatives where the
  correct answer is `unknown`.
- Replay harness over exported sessions (session export lands here; schema
  versioned).
- Metrics: top-1 accuracy, evidence precision, false-confidence rate, unknown
  precision, tool calls and tokens per diagnosis.

## Phase E — Advanced

- Riverpod activity collector — measured constraint (2026-08-25): posts
  `riverpod:new_event {offset}` with **no** `ext.riverpod.*` RPC, so activity
  can be counted and correlated with rebuild storms; values cannot be read.
  Bloc unmeasured, therefore unbuilt.
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
