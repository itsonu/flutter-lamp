# Roadmap

Status of each phase. Detail on what is planned next, and why, lives in
[`Improvement-Plan.md`](Improvement-Plan.md).

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation — MCP server on stdio, VM Service client, `connect_vm`, `runtime_status` | Shipped |
| 2 | Logs, exceptions with reconstructed stack traces, frame timings with jank | Shipped |
| 3 | Network via `dart:io` HTTP profiling (Dio, `package:http`) | Shipped |
| 4 | Widget Inspector — tree and selected widget | Shipped |
| 5 | VM timeline — build, paint, layout, raster, GC | Shipped |
| 6 | Memory — Dart heap, capacity, external | Shipped |
| 8 | AI diagnosis — evidence-anchored `diagnose_runtime` with confidence | Shipped (early) |
| 12 | Live browser dashboard | Shipped |
| 7 | Correlation engine — fold memory, timeline and frames into diagnosis | Planned |
| — | Evidence intelligence — stable IDs, temporal correlation, `runtime_health`, `what_changed`, `explain_diagnosis` | Planned |
| — | Navigation intelligence — current route, transitions, route-scoped evidence | Planned |
| — | State management — Riverpod and Provider activity correlation; Bloc observable through provider | Shipped |
| — | Session recording — versioned export for bug reports and offline analysis | Shipped |
| 9 | Knowledge graph over runtime evidence | Exploratory |
| 10 | Proposed fixes with human approval | Exploratory |

## Sequencing

Reliability and security come before new capability. An evidence layer that
leaks auth headers, or that loses the exception you are chasing, is worse than
one with fewer features.

1. **Reliability and security** — redaction, dashboard hardening, evidence
   retention, reconnection, tool safety metadata.
2. **Evidence intelligence** — stable IDs, temporal correlation, health and
   change summaries, explainable diagnosis.
3. **Developer intelligence** — navigation, state management, performance
   diagnosis.
4. **Session intelligence** — recording, export, replay.
5. **Agent capabilities** — proposed fixes, code correlation, approved
   remediation.

Nothing from a later group ships while an earlier one is unreliable.

## Deliberately out of scope

A persistent graph database. Typed in-memory relationships and correlation
indexes cover the queries an agent actually asks; a graph store is a scale
decision, not an architecture decision, and there is no scale problem yet.

Hosted infrastructure of any kind. Runtime data stays local.

Hard dependencies on state-management packages. Riverpod and Bloc support
arrives as optional adapters or not at all.
