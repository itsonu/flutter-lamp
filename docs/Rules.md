# Rules

Non-negotiable constraints. Every change is checked against these.

## Data sources

Use official Flutter and Dart VM Service APIs. Never scrape DevTools HTML.
Never parse screenshots. Prefer structured JSON over text at every boundary.

## Events

Every runtime event carries `timestamp`, `source`, `severity` and `category`.
Runtime history is not silently discarded — when the buffer is capped, the cap
is explicit and documented.

## Diagnosis

Every diagnosis includes confidence, the evidence it rests on, and recommended
fixes. A claim must be traceable to a concrete captured event.

Below the confidence threshold, report `Unknown` and say which evidence is
missing. Never manufacture certainty. The runtime is the source of truth; the
model is not.

## Architecture

The runtime cache is centralized — one store, one source of evidence. MCP tools
are stateless; all state lives in the connection manager. A new runtime source
is added by implementing `Collector`, without touching other layers.

## Safety

Runtime inspection is read-only against the running app. Anything that mutates
app or VM state is declared as such. No autonomous modification of a user's
project — diagnose, propose, show evidence, request approval, then act.

Treat runtime data as sensitive: it can contain tokens, cookies, credentials and
user data. Redact by default. Keep the dashboard bound to localhost unless the
operator explicitly opts out, and make the implications of opting out explicit.
