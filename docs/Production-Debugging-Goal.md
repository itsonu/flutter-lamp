# Next Goal — Production Debugging Pipeline (proposed)

**Status: PROPOSED, not accepted.** Logged 2026-10-12. Nothing here ships
until the decision gate (G0) below is resolved, because the goal reverses
several standing rejections in
[Observability-Roadmap.md](Observability-Roadmap.md#standing-rejections) and
[Phases.md](Phases.md#deliberately-out-of-scope).

## The goal

Offer, as open source and plug-and-play, the end-to-end debugging pipeline
Uber described for its internal tools (talk: "DebugAssist — an AI agent for
debugging at Uber"):

```
Discover → Auto-triage → Root-cause analysis → Mitigate / Fix → Validate → Deliver
```

Delivered to Flutter teams as three surfaces:

1. **A Flutter SDK** (`flutter_lamp` on pub.dev) — in-app capture.
2. **An API + webhooks** — ingest reports, push results to Slack, GitHub,
   Jira, or anything that takes HTTP.
3. **The agent pipeline** — evidence-anchored RCA, a proposed fix, a validating
   test, a draft PR.

Self-hosted, no Flutter Lamp cloud, any LLM provider.

## Reference: what Uber built

Facts from the talk (Uber's numbers, not ours):

| Uber system | Job | What it captures / does |
| --- | --- | --- |
| **Wisdom** | Manual in-app bug report (employees, beta testers) | Free-text description, app + version, OS, city, screenshots, network / analytics / console / GraphQL / UI-state logs |
| **Healthline** | Automatic quality capture | Crashes, hangs, jitter, perf regressions; session id, prior user actions, logs, full stack trace / crash dump |
| **Auto-triage** | Priority, severity, owner, on-call | Routes the issue to the owning team |
| **DebugAssist** | Agentic RCA → fix → validate → PR | LangGraph pipeline with a fixed plan; deterministic + LLM nodes |

DebugAssist pipeline as described:

| Node | Kind | Detail |
| --- | --- | --- |
| Context collector | **Deterministic** | Fetches + prunes logs (MB–GB). No LLM: cost, latency, context bloat |
| Classify / RCA | LLM, cheaper model, **≤ ~20 turns** | Categorise (own code / 3rd-party / infra / network), confidence score, query more data over MCP (tracing, logs, incidents), fan out sub-agents, consolidate |
| Fix + mitigate | LLM, strongest model, more turns | Locate module/code path; first try **feature-flag rollback** if correlation is strong |
| Validate | Test run | Repro via unit → integration → device automation (simulators with captured network/battery/flags); bounded retries |
| Deliver | Deterministic | Diff/PR, linked to the issue, sent over Slack |

Sub-agents named: breadcrumb (rebuild the user's timeline — also gives a
repro), crash ↔ release-version correlation, offending-commit finder (given a
clean and a bad version, filtered by module). ~30 unique sub-agents.

Architecture choices worth copying:

- **Fixed skeleton, pluggable skills.** The plan never changes; per-domain
  skills/plugins are fetched at runtime by agent type — never the whole
  marketplace (3,000 plugins would flood the context).
- **Teams bring skills; the platform owns the harness.**
- **Tracing on every LLM and tool call** (they use Arize).
- **Human loop after the PR:** small "diff fixer" follow-ups, an ask-the-agent
  chat whose corrections feed back into prompts/skills, and one-click
  "open locally" with the issue's environment pre-set.

Reported outcomes: ~9,000 RCAs/month, 50% exact-match RCA vs. the developer's
fix (+~40% "right direction"), PR merge rate 5% → 48% over a year, Jira
resolution ~2× faster.

## What Flutter Lamp already has

Most of the *debug-time* half exists. The gap is production capture and
delivery.

| Uber piece | Flutter Lamp today | Gap |
| --- | --- | --- |
| Captured logs, network, UI state, stack traces | Collectors: exceptions with reconstructed stacks, logs, `dart:io` HTTP, frames, routes, rebuilds, state, memory, GC | **Debug/profile builds only.** Nothing in release. |
| Bug-report bundle | `export_session` — versioned (`schemaVersion` 1), redacted, `full` / `brief` | No report envelope (description, device, screenshots) |
| Deterministic context collector | Diagnosis engine is deterministic by rule; correlation, coverage, percentiles computed | Runs only against a live store |
| Offline RCA on a recorded bundle | **Exists:** `eval/` hydrates a full export into a store and re-runs the diagnosers | Not exposed as a product path |
| Breadcrumb timeline | Route attribution, `what_changed`, ordered evidence timeline | — |
| Confidence + evidence + `unknown` | Every diagnosis | — |
| RCA accuracy measurement | `eval/` golden incidents, negative cases | No "RCA vs merged fix" metric |
| Pluggable skills | `plugin/skills/flutter-runtime-diagnosis` | One skill; no loader by agent type |
| Fix → validate → PR | Phase E "safe remediation" — planned, not built | Everything |

## Conflicts with standing rules — the decision gate (G0)

This goal cannot be logged as "just more features". It collides with rules
the project adopted on purpose:

| Rule today | Collision | Proposed resolution |
| --- | --- | --- |
| "Hosted infrastructure of any kind" is out of scope; runtime data stays local | Ingest server, webhooks | **Self-hosted only.** Ship a container the team runs. No Flutter Lamp-operated cloud. Still a reversal — needs an explicit yes. |
| "Anything in a release build" is not observable | Production capture | SDK is a **new evidence source**, labelled `source: sdk` vs `vm-service`, with its own (weaker) `cannotObserve` list. Never presented as VM-Service fidelity. |
| No autonomous modification | Auto-fix, auto-PR, flag rollback | Output is a **draft PR = a proposal**. Opening it is opt-in per repo. Never merges. Flag rollback: off by default, approval required, behind an adapter. |
| Tool sprawl ceiling (16 disjoint tools) | New capability | New surfaces live in **separate packages** (SDK, ingest server, pipeline), not new MCP tools. MCP gains at most `load_report`. |
| Vendor-coupled AI rejected | LLM nodes | Provider-agnostic interface; model per node is config. |
| "Never parse screenshots" | Screenshots in reports | Screenshots are **human attachments only**, never diagnosis input. Rule stands. |
| Credentials redacted at capture | Production user data, PII, screenshots | Redaction runs **on device** before upload; screenshot masking for marked widgets; explicit user consent for manual reports. |
| No adopters known; don't invent claims | "Uber-level" | Targets below are goals measured by `eval/`, not claims. Uber's numbers are Uber's. |

**G0 is: accept or reject each row above.** Until then this stays proposed.

## Phased plan (if G0 is accepted)

Order follows the house rule: reliability and evidence before agents.

| Phase | Deliverable | Reuses | Size |
| --- | --- | --- | --- |
| **G1** | **Report bundle format** — `export_session` schema v2 adds a report envelope: description, app/version/build, OS, device, locale, screenshot refs, reporter consent. v1 readers refuse v2 as today. | `src/export/session.ts`, schema-pin test | S |
| **G2** | **Flutter SDK — manual reports** (Wisdom-equivalent): shake or button → description + screenshot + last N minutes of breadcrumbs → bundle. Offline queue. On-device redaction. | Bundle from G1, redaction rules from `core/redaction.ts` (ported to Dart) | M |
| **G3** | **Flutter SDK — automatic capture** (Healthline-equivalent): `FlutterError.onError`, `PlatformDispatcher.onError`, frame timings via `addTimingsCallback`, ANR/hang watchdog, route observer, opt-in Dio / `package:http` interceptors (release has no `dart:io` profiling). Sampling + rate limits. | Event schema (`timestamp`, `source`, `severity`, `category`) | M |
| **G4** | **Ingest API + webhooks**, self-hosted container: `POST /v1/reports`; outbound events `report.created`, `issue.triaged`, `rca.completed`, `fix.proposed`, `fix.validated`; HMAC-signed; retries. Slack + GitHub Issues adapters first. | — | M |
| **G5** | **Auto-triage**: group by error signature, severity rules (crash > hang > jank > report), owner from `CODEOWNERS` + stack frames, crash ↔ app-version correlation. All deterministic. | Phase C "error signatures" | S–M |
| **G6** | **Offline RCA**: hydrate a bundle into a store and run the existing diagnosers — no model. Then an optional LLM RCA node: cheap model, hard turn cap, sub-analyzers (breadcrumb timeline, version correlation, offending commit between last-good and first-bad version filtered by path). Output keeps evidence ids + `unknown`. | `eval/` replay path, diagnosis engine | M |
| **G7** | **Fix + validate + draft PR**: strongest model proposes a patch; validation tries unit → widget → integration test reproducing the issue; bounded retries; draft PR linked to the issue; webhook. Never merges. | Phase E safe remediation, snapshot diff | L |
| **G8** | **Skills harness**: fixed pipeline skeleton; skills loaded by agent type (Android, iOS, state mgmt, networking…); teams contribute skills, not pipeline code. Tracing on every LLM/tool call. | `plugin/skills/` | M |
| **G9** | **Human loop**: ask-the-RCA chat, small follow-up edits on the draft PR, corrections recorded as new `eval/` incidents, "open locally" = replay the bundle into a local Flutter Lamp session. | `eval/` failure intake | M |

Recommended first cut: **G1 → G2 → G4 (Slack + GitHub only) → G6 deterministic
part.** That gives "report from phone → triaged issue with an evidence-anchored
diagnosis" with zero LLM cost and no rule reversal beyond the self-hosted
server.

## Success measures (goals, measured, not claimed)

Measured by `eval/`, reported per release, never estimated:

- **RCA exact-match rate** vs. the merged fix (file + function) on golden
  incidents.
- **RCA direction rate** — right module, wrong file/function.
- **`unknown` correctness** — negative cases must stay `unknown`.
- **Time to RCA** from report receipt (Uber: under 30 minutes).
- **Draft PR merge rate** and **validation pass rate**.
- **False-confidence rate** — a confident wrong RCA counts against us harder
  than an `unknown` (Product Principle 5).

## Open questions

- Name the surfaces. Uber's internal names (Wisdom, Healthline, DebugAssist)
  must **not** be reused.
- Storage for the ingest server: SQLite default, Postgres optional?
- iOS/Android native crash capture (signals, NDK, ANR) — in scope for the SDK,
  or Dart-level errors only at first?
- Device-automation validation (emulator farm) — out of scope for open source
  v1, or an adapter to Firebase Test Lab / BrowserStack?
- License for the SDK and server — MIT like the core?
