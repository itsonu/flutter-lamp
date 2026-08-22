# Dashboard Design

Visual and interaction spec for the live dashboard (`dashboard/index.html`).

The dashboard exists so a developer can watch the runtime without an AI in the
loop. It is intentionally not a DevTools clone: it shows the same evidence the
agent sees, in the order it arrived.

## Constraints

Zero build step, zero runtime dependencies. One static HTML file served by a
native `node:http` server, with a WebSocket for the live stream. Anything that
would require bundling, a framework, or a package install is out of scope.

## Palette

Dark only. Values are declared as CSS custom properties on `:root`.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0d1117` | Page background |
| `--panel` | `#161b22` | Cards, panels |
| `--panel2` | `#1c2128` | Nested surfaces, expanded rows |
| `--border` | `#30363d` | Dividers, card edges |
| `--text` | `#e6edf3` | Primary text |
| `--muted` | `#8b949e` | Secondary text, labels |
| `--accent` | `#42a5f5` | Flutter blue — links, active tab |
| `--accent2` | `#13b9fd` | Chart highlights |

Status colors carry meaning and are used consistently across tabs, charts and
severity badges:

| Token | Value | Meaning |
| --- | --- | --- |
| `--green` | `#3fb950` | Healthy — connected, frames within budget |
| `--yellow` | `#d29922` | Warning — 4xx, warn-level logs |
| `--orange` | `#db6d28` | Performance — janky frames, memory pressure |
| `--red` | `#f85149` | Critical — exceptions, 5xx, transport errors |

## Typography

`Inter` for UI, `JetBrains Mono` for anything the runtime produced — log lines,
stack traces, URIs, JSON. Both load from Google Fonts with a system fallback
stack, so the dashboard degrades cleanly offline.

## Layout

A fixed header (brand, connection state, controls) over a tab strip over one
scrolling content region. Tabs:

| Tab | Content |
| --- | --- |
| Overview | Connection, FPS, memory, per-category event counts |
| Logs | Streaming list, severity filter, text search, auto-scroll |
| Network | Request rows; expand for headers and timing |
| Exceptions | Error rows; expand for the reconstructed stack trace |
| Timeline | VM trace events |
| Performance | Live canvas charts — frame times, memory |
| Inspector | Widget tree snapshot |

## Interaction

Pause and resume the stream, clear the view, export the current buffer as JSON,
per-tab search, and automatic reconnection when the socket drops.

Pause freezes the view, not collection — the store keeps ingesting, so resuming
shows what was missed. Clear affects the browser's view only; it does not touch
the store.

## Implementation notes

The render loop is `setInterval`, deliberately, not `requestAnimationFrame`.
`rAF` is throttled or paused when the tab is not painting, which silently
freezes the live view while the WebSocket keeps delivering events.

`index.html` is read once at server startup and cached in memory. That is right
for normal use and means a restart is needed to pick up UI edits during
development.
