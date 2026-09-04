---
name: Flutter Lamp Dashboard
description: A calibrated readout of a running Flutter app — dense, dark, and never louder than its evidence.
colors:
  ground: "#0d1117"
  surface: "#161b22"
  surface-recessed: "#1c2128"
  rule-strong: "#666c73"
  rule: "#3d444d"
  rule-soft: "#2b323a"
  hover: "#232932"
  text: "#e6edf3"
  text-secondary: "#b6c0cb"
  text-muted: "#8b949e"
  signal-blue: "#58a6ff"
  signal-green: "#3fb950"
  signal-amber: "#d29922"
  signal-red: "#f85149"
  trace-red: "#ffa198"
  trace-amber: "#e3b341"
typography:
  metric:
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  meta:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  section:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0.08em"
rounded:
  control: "6px"
  surface: "8px"
  dot: "50%"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s6: "24px"
  s8: "32px"
components:
  button:
    backgroundColor: "{colors.surface-recessed}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  button-active:
    backgroundColor: "{colors.surface-recessed}"
    textColor: "{colors.signal-blue}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  block:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  status-row:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "8px 16px"
  activity-row:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    padding: "5px 12px"
  detail:
    backgroundColor: "{colors.surface-recessed}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
    padding: "12px"
  nav-tab:
    textColor: "{colors.text-muted}"
    typography: "{typography.body}"
    padding: "12px"
  nav-tab-active:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "12px"
---

# Design System: Flutter Lamp Dashboard

## Overview

**Creative North Star: "The Instrument Panel"**

This is a calibrated readout, not a report. Its authority comes from restraint:
every marking is there because something measured it, and a gauge with no signal
reads *no signal* — never zero. The surface is dark and dense because it is read
for long stretches beside an editor and a device, and because density is what
lets a whole session sit in one viewport instead of three scrolls.

Nothing here is expressive for its own sake. Colour appears only where it
carries state; a container appears only where something is genuinely grouped;
motion appears only as press feedback. The visual system's job is to disappear
behind the evidence, and the fastest way to fail is to make a healthy dashboard
look busy.

The one non-negotiable, inherited from PRODUCT.md: **the interface must never
imply a fact the runtime cannot observe.** That is a visual constraint as much
as a product one — it is why unavailable readings render as prose in the body
face rather than as a monospace number, so absence never wears the costume of a
measurement.

**Key Characteristics:**

- Dark-only, GitHub-dark-adjacent ground with two raised tints
- Five type sizes, monospace reserved for machine-produced values
- One status vocabulary, six states, used identically on every view
- Containers are rare; rows and tables carry most structure
- No webfont, no build step, no runtime dependency

## Colors

A near-neutral dark ground with four signal hues that only ever mean state.

### Primary

- **Signal Blue** (`#58a6ff`): Active navigation underline, focus ring, drill-through affordances, the frame-time chart line, and the `RECEIVING` status. It marks *this is live* or *this is a way through*, never decoration.

### Neutral

- **Ground** (`#0d1117`): Page background. The only true backdrop.
- **Surface** (`#161b22`): Blocks, the header, the nav strip. One step up from ground.
- **Surface Recessed** (`#1c2128`): Expanded detail panes, controls, hover states. Reads as *inside* a surface, not above it.
- **Rule Strong** (`#666c73`): the boundary of a *control* — buttons, inputs, filter chips, the header chip group on hover. **3.05:1 against `--panel2`**, which is what WCAG 1.4.11 asks of a component boundary.
- **Rule** (`#3d444d`): structural edges — block borders, canvases, the table header underline (1.92:1 against the page). Visible, deliberately not a control.
- **Rule Soft** (`#2b323a`): row dividers inside a block. Present, not counted.
- **Hover** (`#232932`): pointer feedback only. Distinct from `--panel2`, which is a surface tint; using the surface tint for hover made the row under the pointer change by 1.07:1, effectively nothing.
- **Text** (`#e6edf3`): Primary values, row names, active tab.
- **Text Secondary** (`#b6c0cb`): Activity messages and inline code — legible without competing with primary values.
- **Text Muted** (`#8b949e`): Labels, explanations, timestamps, all `.sub` and `.why` copy.

### Status

Four hues, six states. These are the entire state vocabulary and are used identically on Overview, Activity, Performance and Diagnostics.

- **Signal Green** (`#3fb950`): `ACTIVE`, `CONNECTED`, `REACHABLE`, `SUBSCRIBED`, `AVAILABLE`, `HEALTHY`.
- **Signal Blue** (`#58a6ff`): `RECEIVING` — live and flowing, distinct from merely up.
- **Signal Amber** (`#d29922`): `DEGRADED`, `RECONNECTING`, `PULL ONLY`, `FAILING`.
- **Signal Red** (`#f85149`): `DISCONNECTED`, `NEEDS ATTENTION`, error counts, error rows.
- **Text Muted, filled dot** (`#8b949e`): `IDLE`, `NO CALLS`, `UNKNOWN`, `NONE` — a thing that exists and is quiet.
- **Text Muted, hollow ring**: `UNAVAILABLE`, `NOT IMPLEMENTED` — a thing that cannot exist here.

### Trace

- **Trace Red** (`#ffa198`) and **Trace Amber** (`#e3b341`): message text for error and warning severity inside the activity stream and stack traces. Softer than the signal hues so a screen of errors stays readable.

### Named Rules

**The Hollow Ring Rule.** A filled dot means *observed*. A hollow ring means
*unobservable*. These are different facts and must never share a glyph, even
when both render grey. This is the visual expression of PRODUCT.md's third
principle.

**The Three-Boundary Rule.** Boundaries come in exactly three weights and each
one means something: a *control* takes `--rule-strong` and clears 3:1; a
*structural* edge takes `--rule`; a *separator between rows* takes
`--rule-soft`. Raising them all to the control weight would make an instrument
panel shout, and leaving them all at the separator weight is what put every
boundary at 1.33:1.

**The Four-Hue Rule.** No fifth accent. If a new state needs distinguishing, it
earns a new *word* in the status vocabulary, not a new colour. The palette's
smallness is what makes red mean something.

## Typography

**Body Font:** `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
**Mono Font:** `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`

No webfont. The dashboard is served from loopback by a local developer tool, and
a font `<link>` fails precisely when the machine is offline — the moment a local
tool most needs to work. The platform font also ships optical sizing and
tracking tables already tuned.

**Character:** Unadorned and current. The pairing carries no personality of its
own, which is the point: personality here would compete with the data.

### Hierarchy

- **Metric** (mono, 400, 20px, 1.1, `-0.02em`): the one number a stat is about. Negative tracking because monospace digits read loose as they grow.
- **Body** (sans, 400, 13px, 1.45): row names, findings, prose, button labels.
- **Label** (sans, 400, 12px, 1.45): explanations beside a status, table cells, activity rows.
- **Meta** (sans, 400, 11px): timestamps, sub-labels, per-row metadata, status words.
- **Section** (sans, 600, 11px, `0.08em`, uppercase): the only uppercase in the system. Positive tracking because small caps read tight.

### Named Rules

**The Machine-Values Rule.** Monospace is for values a machine produced — tool
names, timestamps, durations, byte counts, identifiers, stack traces, JSON. It
is *not* for headings, labels, explanations or any sentence written for a human.
An earlier revision was 65% monospace and read as terminal output rather than as
an instrument; the working target is under half.

**The Absent-Reading Rule.** A real measurement renders in the metric face. An
absent one (`not sampled`, `unavailable`, `none yet`) renders in the body face
at body size, in muted grey. The typeface itself tells you whether a number
exists.

## Layout

A fixed header over a tab strip over one scrolling region, with content capped
at `1180px` and centred. The header is `position: relative; z-index: 3` above the
nav at `z-index: 2`; only the content region scrolls.

Spacing is a single 4px-based scale — `4 / 8 / 12 / 16 / 24 / 32` — exposed as
`--s1`…`--s8`. Every gap in the stylesheet is a step on it. Sections are `--s8`
apart, rows are `--s2` tall internally, block padding is `--s4`.

Three row grids carry nearly all structure:

- **Status row** `168px 116px 1fr` — name, status, explanation.
- **Activity row** `92px 76px 1fr auto` — timestamp, source, message, metadata.
- **Finding** `18px 1fr auto` — mark, title and evidence, destination.

**Responsive.** One breakpoint at `760px`, chosen because that is where the
explanation column of a status row would otherwise be squeezed below legibility
(it computed to 26px at 420px before the breakpoint existed). Below it, status
rows and activity rows collapse to a single column and stack; the nav strip
scrolls horizontally; tables scroll inside their own `.scroll-x` container so
the page body never scrolls sideways. Stat strips reduce their gap from `--s8`
to `--s6`.

**The scroll region owns its own anchoring.** `overflow-anchor: none` on `main`,
because the browser's native anchoring fought the explicit row anchoring in the
activity stream and silently pushed a following view off the top.

## Elevation & Depth

Tonal, not shadowed. Depth comes from three background steps —
ground → surface → surface-recessed — plus a 1px border. There is exactly one
shadow in the system.

### Shadow Vocabulary

- **Floating control** (`box-shadow: 0 4px 16px rgba(0,0,0,.4)`): only the sticky *jump to latest* button in the activity stream, which floats over content and needs to read as detached from it.

The header is the one translucent surface:
`background: rgba(22,27,34,0.82)` with `backdrop-filter: blur(20px) saturate(160%)`,
so content scrolls *under* it and the chrome reads as a layer rather than a strip
carved out of the page. Under `prefers-reduced-transparency` and
`prefers-contrast: more` it becomes solid.

### Named Rules

**The One-Shadow Rule.** A shadow is reserved for something genuinely floating
over content. Blocks, rows, tables and the header do not get one — a border and
a tonal step are enough, and shadows on a dense dark surface read as smudge.

## Shapes

Two radii and one circle. `8px` (`--radius`) for blocks and canvases; `6px` for
controls, detail panes and inputs; `50%` for the 7px status dot. Nothing else is
rounded.

Borders are the primary structural device: `1px solid` in `--border` around
blocks and controls, `--border-soft` between rows within a block. The last row
in a block drops its border so the container edge is not doubled.

Form language is rectangular and quiet. No gradients, no glows, no
decorative dividers, no icons — status is a dot and a word.

## Components

Character line for the whole set: **precise and quiet.** Restrained surfaces,
hairline rules, state carried by one dot and one word. Nothing moves unless it
means something.

### Buttons

- **Shape:** `6px` radius, `1px solid var(--border)`, `--panel2` background, `5px 10px` padding, label typography.
- **Hover:** border shifts to `--accent`. No background change.
- **Active (pressed):** `transform: scale(0.97)` over `90ms ease-out`. Feedback lands on pointer-down, not on release.
- **Toggled on** (`.on`, used by Pause and the active filter chip): border and text both `--accent`.
- **Focus:** `2px solid var(--accent)` outline at `2px` offset, from a single global `:focus-visible` rule.

### Filter chips

Buttons in the `.filters` row carrying `aria-pressed`. Identical geometry to a
button; the selected one carries `.on`. The first four scope the source and the
rest pick a category — a `--s4` gap marks the boundary, rather than a divider, a
heading or a second colour. They wrap naturally and are never truncated.

### Blocks (containers)

- **Corner:** `8px`. **Background:** `--panel`. **Border:** `1px solid var(--border)`. **Overflow:** hidden, so child row borders clip to the radius.
- **No shadow.** Internal padding is applied by the child rows, not the block.
- Reserved for genuine grouping. An earlier revision had nine metric cards on one screen; the current Overview has four blocks total.

### Status rows

Name in `--text` at 500 weight, status chip, then an explanation in `--label` and
`--muted`. Inline `<code>` and `<b>` inside the explanation shift to the mono
face and `--text2`, so an identifier is distinguishable from the sentence
carrying it. A `.head` variant (used for *Overall*) takes a full `--border`
underline and 600 weight.

### Stat strip

A flex-wrapped row of `.stat` blocks inside a single block — a label, a value, a
sub-line. This replaced a grid of equal cards. The value takes `.none` when the
reading is absent, which switches it to the body face (see The Absent-Reading
Rule).

### Activity rows

Four columns, `12px` mono message (`--fs-label`). Severity tints only the message text, not
the row. Expandable rows take `cursor: pointer` and a `--panel2` hover; the
expanded `.detail` is a recessed pane with `pre-wrap` text, `--text` bold keys
and `--trace-red` stack traces.

### Findings

Mark glyph (`●` error, `▲` warning, `○` informational or blind, `✓` clear),
title at 500, muted rationale, then an evidence line in mono `--text2`. When a
finding has a destination it takes `.clickable` and a right-aligned
`Destination →` in `--accent`.

### Tables

Uppercase `11px` muted headers with a `--border` underline; mono cells with
`--border-soft` dividers and `white-space: nowrap`. Error counts take `.bad`
(red) or `.good` (green). Rows that drill through take `.clickable` and a hover
tint. Always wrapped in `.scroll-x`.

### Navigation

Four tabs, borderless, `12px` padding, `13px` body type. Inactive `--muted`;
hover adds a `--border` underline and lifts text to `--text2`; active is `--text`
with a `2px --accent` underline. Badges are `11px` mono `--muted`, turning
`--red` when they represent something needing attention. Tabs carry `role="tab"`
and `aria-selected`. Nav buttons opt out of the global press-scale — a
navigation strip that flinches reads as unstable.

### Charts

Canvas at `180px`, block background, `8px` radius, DPR-scaled. Frame time draws
a dashed `rgba(248,81,73,.5)` budget line and a `1.5px` `--accent` series;
heap draws a `--green` series. An empty chart writes *no data yet* in muted grey
rather than rendering an empty axis.

## Do's and Don'ts

### Do:

- **Do** use the four signal hues for state only, and add a *word* rather than a fifth hue when a new state appears.
- **Do** render an absent reading in the body face and a real measurement in the metric face, so the typography itself distinguishes them.
- **Do** keep monospace for machine-produced values; write labels, headings and explanations in the sans face.
- **Do** take every gap from the `--s1`…`--s8` scale.
- **Do** give a filled dot to something observed and a hollow ring to something unobservable.
- **Do** wrap any table in `.scroll-x`, and stack row grids below `760px` rather than compressing the explanation column.
- **Do** keep press feedback at `scale(0.97)` / `90ms` on controls, and none on navigation.
- **Do** honour `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`.
- **Do** give a long list one tab stop and a roving cursor, never one tab stop per row.
- **Do** name a filter after the single thing it returns.
- **Do** print the observed maximum; the padded drawing ceiling is not a reading.

### Don't:

- **Don't** add a container to something that is a row. Blocks are for genuine grouping; the current Overview needs four.
- **Don't** print `0` where nothing could have been measured. Name which kind of nothing it is.
- **Don't** introduce a webfont, a build step, or a runtime dependency — the whole surface is one static file.
- **Don't** add a second shadow. One floating control has one; everything else uses a border and a tonal step.
- **Don't** carry state in colour alone; every status has a word beside its dot.
- **Don't** animate anything that is not direct feedback on a press. Decorative transition on a data view reads as latency.
- **Don't** collapse two semantically different states into one label to tidy the UI — `connected`, `reachable`, `receiving`, `available`, `observed`, `not sampled` and `unavailable` are distinct and stay distinct.
- **Don't** let a control look interactive without being reachable by keyboard.
- **Don't** let the dashboard's own telemetry outnumber the app's evidence in the default view.

## Behavior notes

Not visual style, but design decisions a future change must not undo.

**Four destinations.** Overview (session report), Activity (one unified stream),
Performance (frame analysis), Diagnostics (topology, health, capability, blind
spots). Logs, Network, Exceptions, Timeline and the MCP call log are *filters
within Activity*, not destinations. Inspector is a section of Diagnostics.

**The header carries three chips** — Runtime, MCP, Stream — because those states
vary independently. A single badge cannot express "the app is gone but MCP is
serving an agent", which is a real and common state. Clicking the chips opens
Diagnostics.

**The activity stream anchors on a row, not on scroll position.** At the top it
follows new entries, holding the newest row in place. Scrolled away it pins,
holding the row under the reader still, and offers *N new entries — jump to
latest*. Returning to the top resumes following. Measured: 0px drift following,
0.2px pinned, under live traffic.

**Keyboard model.** The tab strip is one tab stop with arrow-key movement
(roving tabindex). The activity stream is one tab stop with a roving cursor —
arrows move, Home/End jump, Enter/Space expands — so several hundred rows never
become several hundred tab stops. Findings and the drill-through buttons inside
tables are ordinary tab stops. Focus is captured and restored across the
wholesale re-render that follows every state change.

**Filters name one thing each.** `All`, then three source filters — `App` (what
the observed application produced), `MCP` (the agent's calls), `System` (this
server's own notes and heap sampling) — then `Tool failures`, `Exceptions`,
`Logs`, `Network`, `Frames`. There is deliberately no generic *Errors* filter:
it previously returned MCP tool failures, janky frames and app exceptions
together, three unrelated kinds of failure under one word. When any filter or
search is active a summary line names it and offers **Clear filters**.

**Runs of self-generated rows are rolled up**, keeping every original behind a
disclosure. Two qualify: reconnect churn, and the dashboard's own heap poller,
which otherwise accounted for 52-67% of the visible stream. A run of fewer than
three rows is left alone.

**Drill-through** sets a filter and a search together and lands on the exact
evidence — a worst-frame row opens Activity filtered to that frame number.
Changing a filter clears a drill-through's search, because carrying it across
made a populated category look empty.

**Findings are ordered most severe first**, from the severity already assigned;
nothing is invented to rank them. A caveat that qualifies the finding above it
inherits that finding's rank so the pair stays together.

**Findings carry the remedy when the evidence already contains one.** The VM
Service diagnosis event holds concrete transport advice in `data.transport`;
the finding renders it verbatim. Remediation is never synthesised — if the
evidence has no remedy, the finding shows none.

**Pause is a view control, and the header says so.** `STREAM` and `VIEW` are
separate chips: the stream can read `receiving` while the view reads `paused`,
because both are true. While paused the chip counts what has arrived behind the
frozen view (`+N behind`), and an Overview row states the freeze timestamp.
Pause does **not** stop collection: the server keeps ingesting, and the browser
keeps appending to its own buffer. That buffer is finite — approximately 5,000
entries, trimmed oldest-first — so a sufficiently long pause **can** evict
entries client-side. The UI says this in the paused row. Do not document or
imply that nothing is lost while paused.

**Tab, filter and search live in the location hash** (`#Activity/mcp/get_frames`),
so a filtered view can be reloaded, bookmarked or handed to someone else. A
drill-through *pushes* a history entry, so the browser's own Back button
reverses it — a bespoke back control would be a second, less familiar way to do
something every user already knows. Refinements of the current view (changing a
filter, typing in search) *replace* instead, so they never fill the history.
Filter and search appear in the hash only on Activity, because `#Overview/system`
would imply Overview is filtered.

**Clear view** empties the browser's buffer only. The server's store is
untouched, and a reload restores what it still retains.

**Export events** downloads that same browser buffer — not MCP tool telemetry,
not diagnoses, not anything already evicted. The full session export is the
`export_session` MCP tool. The button is named and titled for that scope.

**Nav badges name themselves.** Four badges carried three different meanings —
findings, events, frames over budget, impaired collectors — with nothing saying
which. The number stays; each now carries a title and an accessible label.

**Counts name their window.** *Events in view* and *Frames in view* are the
browser's buffer; Diagnostics reports what the store retains. The two differ
routinely and the labels say why.

**The frame budget comes from the server, not from a second copy here.** The
page previously held its own `16.7` literal, which was correct only while the
server's was. It now reads the budget the collector actually classified against,
including its provenance (`assumed` or `configured`), and falls back to the same
assumed value only before telemetry arrives.

**Charts report the observed maximum, never the drawing ceiling.** The plotting
area is padded 15% above the data so the series does not touch the top edge;
that padded number is not a measurement and is never printed. The caption gives
the true maximum, the last value, and the sample count.

**Empty states name their kind.** An empty view says whether a filter is hiding
rows, the collector cannot see this category on this target, the app is not
connected, or the collector is watching and has genuinely seen nothing.
