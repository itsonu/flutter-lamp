---
target: dashboard/index.html
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
timestamp: 2026-08-28T09-52-50Z
slug: dashboard-index-html
---
Method: dual-agent (A: design review · B: detector + browser evidence), isolated until synthesis.

Target: `dashboard/index.html`, inspected live at `http://127.0.0.1:7374/`. Screenshots unavailable (browser pane does not composite); every claim below is a DOM measurement or a source citation. The Flutter runtime disconnected part-way through both assessments, so connected and disconnected states were both observed live — but live-stream drift could not be re-exercised under arrival (see Coverage gaps).

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Six-row system panel and staleness stamps are excellent; Pause freezes every "N ago" reading while still labelling the stream `RECEIVING`. |
| 2 | Match System / Real World | 3 | Domain vocabulary is the domain's own. `Errors` names three unrelated things: 80 MCP tool failures, 35 janky frames, 0 app exceptions. |
| 3 | User Control and Freedom | 2 | No back from a drill-through; `Clear view` irreversible in-session with no statement that reload restores it; no filter/tab state in the URL. |
| 4 | Consistency and Standards | 2 | Findings not severity-sorted; staleness stamp on 2 of 6 stats; four nav badges carry three meanings; tab pattern half-implemented (`role=tab` without `tabpanel`/`aria-controls`). |
| 5 | Error Prevention | 3 | Read-only surface. `Clear view` sits beside Pause and discards the browser buffer with no confirmation and no undo. |
| 6 | Recognition Rather Than Recall | 2 | Chart `max` is an axis ceiling, not a reading; `371 frames` vs `684 events` requires recalling which is buffer and which is store; four finding glyphs have no legend. |
| 7 | Flexibility and Efficiency | 2 | 418 interactive elements unreachable by keyboard; no way to suppress the heap-poll noise; no URL state; no copy-to-clipboard. |
| 8 | Aesthetic and Minimalist Design | 3 | Pixel restraint is first-rate; undone at row level — 52–67% of the visible stream is the dashboard's own heap poller. |
| 9 | Error Recovery | 2 | The store holds the exact fix (`adb connect <ip>:5555`); the UI shows the headline instead. |
| 10 | Help and Documentation | 3 | Why-lines are exemplary; nothing explains what Pause / Clear view / Export JSON scope to. |
| **Total** | | **25/40** | Fair — strong thesis, weak reach |

No heuristic is n/a; Operate mode makes all ten live.

## Design Specificity Verdict

**Strongly grounded — roughly 85% of the composition is non-transferable.**

Diagnostics could not be lifted into another product: its rows are propositions about this architecture (`MCP tools — read the same store directly, one process, no bridge between them`; `Other MCP clients UNAVAILABLE — the transport is stdio: exactly one peer`). The *Not observable* section has no analogue in a generic dashboard. The status vocabulary encodes distinctions no template carries (`REACHABLE` / `RECEIVING` / `SUBSCRIBED` / `PULL ONLY` / `NOT IMPLEMENTED`), and the hollow-ring rule is implemented, not merely documented (`.s-na::before` drops `background` for `box-shadow: inset 0 0 0 1px`).

The generic slice is the stat strip and the two line charts — and that is where the worst trust defect lives, which is not a coincidence: the borrowed component did not receive the same epistemic scrutiny as the bespoke ones.

**Deterministic scan:** `detect.mjs` exit 2, **1 advisory finding, 0 blocking** — `design-system-color` at index.html:183, `rgba(0,0,0,.4)`. **False positive**: that is the shadow alpha on the sticky jump-to-latest control, not a palette colour. All 12 palette entries resolve from `:root` custom properties.

**Visual overlays:** not available. Screenshots and overlay injection are impossible in this environment (pane does not composite); both assessments substituted direct DOM measurement, which is more precise for every question asked.

## Overall Impression

The product's thesis — never imply a fact the runtime cannot observe — is genuinely implemented and survives contact with a real disconnect. The failure is not in the thesis but in its reach: the discipline was applied to the bespoke components and skipped on the borrowed ones, and applied to *what is shown* but not to *what can be reached*. The single biggest opportunity is that the dashboard already holds better answers than it displays.

## What's Working

1. **The absent-reading discipline survives reality.** Verified across a live disconnect: `EXCEPTIONS` flips from mono `0` to body-face `not connected / requires a connected app` (`fontFamily` measured switching `ui-monospace` → `system-ui`, 20px → 13px). Four kinds of nothing are distinguished. Most dashboards print `0` in all four cases.

2. **Drill-through precision.** Measured end to end: Performance worst-frame `#1707` → Activity, filter `frame`, query `Frame #1707`, exactly 1 row. Filter change clears the carried query (index.html:831) so a stale search never fakes an empty category.

3. **Epistemic honesty as a UI primitive.** `self-reported, not authenticated` beside the agent name; `it hosts this page, so it cannot report otherwise` beside MCP; and an entire finding whose only job is to say `That link is a correlation, not a proven cause`. Every text colour pair clears WCAG AA (lowest 5.16:1 across 18 measured pairs).

## Priority Issues

### [P0] 418 interactive elements are unreachable by keyboard
**Both assessments found this independently.** Measured: 400 `.arow.clickable`, 3 `.fnd.clickable`, 15 `tr.clickable` — all `tabIndex < 0`, no `tabindex`, no `role`. `main a[href], main button, main input, main [tabindex]` returns **0** on Overview. Page-wide there are 8 focusable elements, every one of them chrome.

The focus ring is textbook-correct (`2px solid #58a6ff`, offset 2px, 6.85–7.49:1) and there is nothing in the content for it to land on. Every drill-through, every stack-trace expansion, every tool-row destination is mouse-only.

PRODUCT.md lists keyboard operability among the things implemented and not to be regressed. That claim is currently false.

**Fix:** `tabindex="0"` + `role="button"` + `aria-expanded` on clickable rows, Enter/Space handlers — the correct pattern already exists on `.chips` (index.html:236, 310). Add `aria-pressed` to `.fbtn` plus a non-colour cue. Label `#aq`. One `aria-live="polite"` node for runtime transitions.
**Command:** `/impeccable audit dashboard/index.html`
**Confidence:** very high (measured twice, independently)

### [P1] The charts print an axis ceiling under the word "max"
`index.html:907` computes `Math.max(...data)*1.15` as the drawing ceiling; `:914` prints that same inflated number as `max`. Confirmed in source and independently derived from canvas pixels: budget line located at y=112–113, inverse of the plotting transform gives ceiling **47.12ms** against a true window max of **40.97ms**, while the stat strip four inches above reads `MAX 221.8ms`. On the heap chart the caption reads ≈`155.6` while the page's own heap reading is `135.27 MB / cap 141.54 MB` — **a maximum above reported heap capacity, physically impossible in a memory tool.**

Three numbers labelled "max" on one screen, no two agreeing. This is Product Principle 1 violated in the most corrosive possible place: a hand-rolled 15% inflation printed as a measurement.

**Fix:** keep `*1.15` as the drawing ceiling; print `Math.max(...data)`. Better, drop the caption and put the real value in the section header where it can be compared with the stat strip.
**Command:** `/impeccable polish dashboard/index.html`
**Confidence:** very high

### [P1] The one actionable answer in the session is three layers down
The store holds the exact remedy. Expanding the `Why the VM Service is unreachable` event yields `data.transport`: *"No device is attached to adb… reconnect wirelessly with `adb connect <ip>:5555`"*, plus `192.168.88.19:5555 is offline`.

What the UI shows: the Overview finding renders `diag.message` only (index.html:557) — the bare heading with no payload. The payload is reachable only by locating row 37 in Activity, clicking it, and reading a raw escaped JSON array. That row is classed `sev-info`, so it renders *quieter* than the jank rows above it. And the expander is mouse-only (P0).

PRODUCT.md's success criterion is that the answer carries its own evidence. Here the answer exists, is correct, is specific, and the design shows the question instead.

**Fix:** render `data.transport[0]` as the finding's evidence line with the rest as sub-lines; promote the event to `warning`; format `transport` as a list rather than `JSON.stringify`.
**Command:** `/impeccable clarify dashboard/index.html`
**Confidence:** very high

### [P1] Pause freezes readings that keep asserting they are live
With Pause active, `Dashboard stream | RECEIVING | last event 4m ago · last server message 2s ago` was byte-identical across two reads **19.5 seconds apart**, while the server processed 32 further tool calls. `main.innerText` contains no occurrence of "paus" — the only indicator is a 64×28px `Resume` button at x=1181, roughly 900px from the readings it froze.

`RECEIVING` is defined in DESIGN.md as "live and flowing, distinct from merely up". Pause turns the one row that certifies the pipeline into a claim the page cannot support.

**Fix:** while paused, freeze the label too — `VIEW PAUSED` (a word, per the Four-Hue Rule), absolute timestamp instead of `N ago`, and one persistent in-content strip stating that collection continues and the ~5,000-entry buffer trims oldest-first.
**Command:** `/impeccable clarify dashboard/index.html`
**Confidence:** very high

### [P1] The stream is majority self-telemetry, and it buries the incident
Of the newest 400 rows on `All`: **268 (67%)** were `Heap … / cap …` polls in one sample, **207 (52%)** in another, plus 132 MCP tool-call rows. `bySource` for that window was `{mcp: 132, system: 268}` — **zero frame, log, network or exception rows visible** while the same page reported 371 frames and 102 rebuilds captured. Only 71 unique messages across 400 rows. Diagnostics simultaneously reported **2,419 events evicted**.

There is no escape: `FILTERS` has no `system` chip, and `Runtime` is defined as `src !== "mcp"`, so it *includes* every heap poll. This also makes the disconnect worse — `Gave up reconnecting` sits at index 37 beneath a wall of `0ms · 0 B`.

**Fix:** roll up consecutive heap samples exactly as reconnect churn already is (`RETRY_RE`, index.html:703 — pattern and disclosure UI both exist). Add a `System` chip, or exclude polls from `All` and surface them under one. UI-only; no new telemetry.
**Command:** `/impeccable distill dashboard/index.html`
**Confidence:** high

## Persona Red Flags

**Alex (power user).** No keyboard path to any content interaction. No URL state, so a filtered view cannot be reloaded or shared — for a tool kept open beside an editor for hours, the cheapest efficiency win available. No copy-to-clipboard on a stack trace or tool row. No way to mute the heap poller.

**Jordan (first-timer).** `Errors` returns 121 rows: 80 MCP tool failures, 35 janky frames, 5 network, 1 system, **0 app exceptions** — a 41.8ms frame renders in the same `#ffa198` as a crash. `FRAMES 371` on Performance vs `frames 684 events` on Diagnostics, with nothing saying one is the browser buffer and one the server store. `Export JSON` exports `state.events` only — no telemetry, no MCP log, no diagnosis, capped at 5,000, empty after `Clear view`; the real export is the `export_session` MCP tool.

**Sam (accessibility-dependent).** Cannot reach any content control. No `aria-live`, so a continuously streaming log announces nothing. `#aq` has no label of any kind — placeholder only. No `h1`; 13 flat `h2`. 14 `<th>` with 0 `scope`, 0 `<caption>`. Activity row severity is carried by `.msg` colour alone — sample error row reads `15:10:42.392 mcp get_memory 0ms · 0 B`, indistinguishable from info except by hue. `role=tab` present without `tabpanel`, `aria-controls`, or roving tabindex.

## Minor Observations

- **Non-text contrast fails WCAG 1.4.11 throughout.** Every button/input border is **1.33:1** against its own background; hover feedback (`--panel2` vs `--panel`) is **1.07:1**; card edge **1.09:1**. Even the `prefers-contrast: more` branch only reaches **2.24:1**, still under 3:1. Text contrast is fine everywhere; boundaries are not.
- **Filter changes cost 108–182ms.** Four of eight exceed 100ms; worst is 182ms ≈ 11 dropped frames. Activity tab switch 150–159ms. Cost scales linearly with rendered rows (r ≈ 0.99). Cause is `panel.innerHTML = h` replacing ~2,000 nodes wholesale.
- **All 2,012 Activity nodes stay in the DOM permanently** — 80% of the document, on every tab.
- **Findings are not severity-sorted.** Observed order `err, warn, blind, warn, err, blind`; an HTTP-failure error sat below a jank warning. `attention()` pushes in code order; one `.sort()` fixes it.
- **420px breaks the activity message column in the way the breakpoint exists to prevent.** `.arow` becomes `80px 1fr` and only `.src`/`.meta` move to column 2, so the *message* lands in the 80px column while `src` ("MCP") and `meta` each get 278px. Rows grow 28px → 57–75px. One-line fix: `.arow .msg { grid-column: 1 / -1; }`.
- **`NETWORK 5 / requests observed`** renders in live mono face with no `· before the disconnect` stamp, while `FRAMES` and `HEAP` both carry it. `stale()` is applied to 2 of 6 stats; `observed()` never calls it.
- **Nav badges carry three meanings** with no labels: findings count, event count, jank count, impaired-collector count. `Overview 4` sat beside `Overall … 6 findings below`.
- **`span.st.s-na` clips 4px** — "NOT IMPLEMENTED" needs 120px in a fixed 116px `.srow` track, 1440→800px on Diagnostics.
- **Nav "Diagnostics" is cut 10px at 420px** — scrollable, no affordance.
- Blue `Activity →` `<td>` reads as a link but is not an `<a>`, not itself clickable, not focusable.
- Focus drops to `<body>` after every drill-through (`p.innerHTML = h`) — moot until P0 is fixed, then immediately relevant.
- Doc/impl drift: DESIGN.md specifies a 12.5px activity message; CSS resolves to 12px.
- **Subjective:** the charts have no axes and no time reference. The restraint is defensible; the consequence is that the chart cannot be read quantitatively at all, which is what pushed the caption into inventing a `max`.

## Coverage Gaps

- **Live-stream drift was not re-exercised under arrival.** The runtime disconnected mid-assessment; the Activity badge held at 1031 across 36s of sampling. Both 0px drift figures reflect an idle stream, not proven anchoring. A forced full rebuild while pinned did restore the anchored row to within **28.3px** (one row height), and an earlier measurement on this same build recorded 1px drift over 6s under real traffic — but this run did not reproduce it.
- Streaming mutation rate (0.42 records/sec) is an idle floor, not representative.
- IME composition across the input rebuild was not drivable from JS.

## Questions to Consider

1. **Should the dashboard's own polling compete with the app's evidence for the same ring buffer?** 2,419 events evicted while 52–67% of the retained stream is written by a 1Hz poller feeding a chart. The reconnect rollup proves the principle is already accepted — why is the heap poller exempt?
2. **Is Pause a view control, or a claim the page cannot support?** If a frozen reading must keep a live label, does Pause deserve a frozen-clock treatment rather than a button 900px away from what it froze?
3. **PRODUCT.md lists keyboard operability among what is implemented — was that ever exercised, or does it describe the header?** If it is intent rather than state, is it worth saying so in the same plain voice the document uses about its other limits?
