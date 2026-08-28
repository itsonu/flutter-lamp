# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences of equal weight, sometimes present in the same session.

**A developer debugging a running Flutter app.** They have an app on a device or
emulator misbehaving — jank, an exception, a failing request, memory growth —
and they want the runtime's own evidence rather than a reconstruction from
`print` statements. The dashboard is their surface.

**An AI coding agent working on that same app.** It connects over MCP (stdio)
and calls tools to read the same runtime. Claude Code, Cursor, Codex and any
other MCP client are equivalent here; none is privileged.

The two are not sequential phases. A session where the agent debugs while the
human watches the dashboard to judge whether to trust it is as common as a
session where the developer debugs alone and the agent is merely running.
Neither audience is the primary one, and design work must not quietly optimise
for one at the other's expense.

## Product Purpose

Give whoever is debugging a running Flutter app direct access to what the Dart
VM Service actually reports — exceptions with reconstructed stack traces, logs,
`dart:io` HTTP traffic, frame timings, navigation, rebuilds, state activity and
memory — plus a diagnosis over that evidence.

Success is that a question about a running app is answered from observation
instead of from guesswork, and that the answer carries its own evidence. The
failure this product exists to prevent is a confident wrong conclusion; an
honest `unknown` is the better outcome.

## Positioning

The distinguishing mechanism is that **the observability layer and the agent's
tool surface are the same process reading the same store.** Collectors run
inside the MCP server and write a normalized event store; the MCP tools and the
dashboard are two readers of it. There is no bridge between them that could
drift, lag or disagree.

That makes possible something a screen-scraping or log-tailing tool cannot
offer honestly: the dashboard can report what the agent asked for and what it
cost, because those calls happened in the same process, and it can guarantee the
human and the agent are looking at identical evidence.

## Operating Context

- The server is launched by an MCP client over **stdio**, which means exactly
  one peer: the process that spawned it.
- The dashboard is served on **loopback** by the same process, over HTTP with a
  WebSocket stream, and is reached in a normal browser.
- The observed app runs in a **debug or profile build**, connected over USB or
  TCP, typically via `adb` on Android.
- Sessions are short and bounded by a connection. A hot restart or a dropped
  socket starts a new session; evidence is not correlated across two runs,
  because correlating across a gap invents causes.

## Capabilities and Constraints

**Observable:** VM Service streams (Stdout, Stderr, Logging, Extension, Debug);
Flutter framework errors with reconstructed stack traces; frame build/raster
timings and jank; per-frame widget rebuilds; `dart:io` HTTP; route changes;
Riverpod/provider activity as timing and volume only; Dart heap and external
memory; VM timeline on demand; and MCP tool calls at call granularity — name,
count, duration, response bytes, error flag.

**Available but weakly guaranteed:** the connected agent's identity, from the
`clientInfo` it sends at MCP `initialize`. Self-reported, not authenticated.

**Not observable, and stated as such rather than approximated:**

- **CPU** — the VM Service does not sample it.
- **A second MCP client** — stdio has one peer by construction.
- **What the agent did with a result** — tool calls are counted; the model's
  reasoning never enters this process.
- **Causality between events** — time is measured; cause is not.
- **A live widget tree** — inspection is pull-based RPC. Nothing pushes trees
  into the store, so there is no stream to render.
- **Anything in a release build**, before `connect_vm`, or older than the
  retention window.

**Constraints that future work must preserve:**

- The dashboard is a **single static HTML file with no build step** and no
  runtime dependencies, served by `node:http` with a `ws` WebSocket. Anything
  requiring bundling, a framework or a package install is out of scope.
- Retention is a **bounded ring buffer** per category. Truncation is reported
  rather than hidden.
- Credentials are redacted before storage, not at the point of display — the VM
  Service URI authorises arbitrary Dart execution and must not reach the store,
  the dashboard, an export, or a tool response.
- The dashboard WebSocket requires a per-process token inlined into the served
  page, because loopback alone does not protect a WebSocket from a hostile tab.

## Brand Commitments

Name: **Flutter Lamp**; npm package `flutter-lamp`; MIT. The documented voice is
plain and specific about limits — it names what it cannot see rather than
leaving a gap for the reader to fill optimistically. That plainness is a product
commitment, not a stylistic preference.

## Evidence on Hand

- A working implementation with an eval suite that replays recorded sessions
  against the diagnosis engine, including deliberate negative cases.
- Real captured sessions from a physical Android device, and an architecture
  note (`docs/Data-Path.md`) whose topology claim was verified empirically
  rather than asserted.
- **No external adopters are known.** The package is public on npm, but nobody
  beyond the author is known to use it. Future work must not invent users,
  testimonials, download counts, adoption claims or case studies.

## Product Principles

1. **The dashboard must never imply a fact that the runtime cannot actually
   observe.**
2. **One normalized event store, multiple observers.** Not one pipeline per
   consumer, and never a second store.
3. **Absence of evidence is not zero.** "Not sampled", "unobservable on this
   target", "not connected" and a measured `0` are four different facts and
   must never share an appearance.
4. **Adjacency is measured; cause is inferred and labelled as such.** Where the
   evidence supports a cause, state it. Where it does not, say that it does not.
5. **A confident wrong answer is worse than `unknown`.** This governs the
   diagnosis engine, the dashboard, and every future surface.

## Accessibility & Inclusion

No external conformance standard has been committed to. What is implemented and
should not regress:

- **Keyboard operability.** Every interactive control is reachable and operable
  without a mouse. The tab strip is a single tab stop navigated with arrow keys;
  the activity stream is a single tab stop with a roving cursor (arrows move,
  Home/End jump, Enter/Space expands a row), so 400 rows do not become 400 tab
  stops; findings and drill-through controls are ordinary tab stops. Focus is
  restored across the wholesale re-render that follows every state change.
- **Visible focus** on every focusable element, from one unscoped
  `:focus-visible` rule.
- `prefers-reduced-motion`, `prefers-reduced-transparency` and
  `prefers-contrast` are honoured.
- **Status is never carried by colour alone** — every state has a word beside
  its dot, and a live region announces runtime, MCP, stream and view-paused
  transitions.

Known gap, stated rather than implied: non-text contrast (control borders and
hover feedback) is below the 3:1 of WCAG 1.4.11. Text contrast passes AA
throughout.
