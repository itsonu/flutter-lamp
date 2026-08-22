# AI Agent Integration

How an agent should drive Flutter Lamp. Written for the model, not for the
person reading over its shoulder.

The short version: do not call every tool. Start with `runtime_health`, follow
what it points at, and never claim a cause the evidence does not carry.

## Investigation protocol

```
1.  get_capabilities   — once per session, if you have not seen it
2.  connect_vm         — with the URI from `flutter run`
3.  runtime_health     — one call; is anything actually wrong?
4.  what_changed       — the window before the failure
5.  targeted get_*     — only what step 3 or 4 pointed at
6.  diagnose_runtime   — correlate into a root cause
7.  explain_diagnosis  — only if the user asks why, or you doubt the result
8.  report             — with the uncertainty intact
```

Steps 5 and 7 are conditional. Running all eight every time wastes context and
produces worse answers, because the model ends up reasoning over a haystack it
assembled itself.

## Step by step

**`get_capabilities`** tells you which collectors are active, which tools exist
and whether each mutates state, what this target *cannot* show you, and whether
redaction is on. Read `cannotObserve` before concluding something is absent —
"no network evidence" in a WebView app means the traffic was never visible, not
that no requests happened.

**`connect_vm`** takes the URI `flutter run` prints. If the user has not given
you one, ask for that single line — never for pasted logs. Suggest
`flutter run --vm-service-port=8181` for a stable URI next time.

This tool is **not read-only**: it enables `dart:io` HTTP timeline logging on
the app.

**`runtime_health`** is the triage call. One request returns a verdict plus
exception, network, frame, log and memory summaries, each carrying event ids.

| Verdict | Meaning | Next |
| --- | --- | --- |
| `no-data` | Connected but nothing captured | Ask the user to reproduce, then re-check |
| `healthy` | No exceptions, no failures, frames within budget | Say so; do not manufacture a problem |
| `degraded` | Network failures or a jank pattern | `what_changed`, then the matching `get_*` |
| `failing` | Exceptions captured | `what_changed`, then `diagnose_runtime` |

Read `notes`. It says when the numbers are qualified — disconnected, mid-reconnect,
evidence dropped by retention, network not refreshed.

**`what_changed`** answers "what happened before this". Anchors on an `eventId`,
or the most recent exception, or now. Network matching is interval-based, so a
request that started before the window and failed inside it still appears —
that is usually the request you want.

**Targeted `get_*` calls.** Only fetch what you are going to use.

| Question | Tool |
| --- | --- |
| What is the stack trace? | `get_exceptions` |
| Which request failed? | `get_network` |
| Is the jank build or raster? | `get_frames` with `onlyJanky: true` |
| What did the app print? | `get_logs` with `minSeverity: "warning"` |
| Which screen is broken? | `get_navigation` |
| What is on screen? | `get_widget_tree`, `get_selected_widget` |
| Is memory growing? | `get_memory`, called more than once |

**`get_navigation`** answers "which screen". It returns the current route and
recent transitions, each with how long it was on screen and the exceptions,
failed requests and janky frames attributed to it. A request spanning a route
change counts for both screens, because assigning it to one would hide it from
the screen the user actually saw fail. `diagnose_runtime` already names the
active route in its summary; use this tool when the question is about screens
rather than about one failure.

**`diagnose_runtime`** correlates the evidence and returns a root cause anchored
to a real event.

| Field | Use |
| --- | --- |
| `status` | `diagnosed` or `unknown`. Respect it. |
| `rootCause` | The claim, anchored to a captured event |
| `evidence[]` | Each with an `eventId` you can cite |
| `timeline[]` | Chronological, with `deltaMs` and relation to the root cause |
| `alternativeCauses[]` | Other explanations that fit — mention them |
| `confidenceBreakdown` | Evidence strength, data completeness, alternative strength |
| `limitations[]` | What the diagnosis could not see |

**`explain_diagnosis`** resolves every cited id back to its full record and adds
`missingEvidence`. Use it when the user asks why, or when the confidence
breakdown makes you doubt the answer. Do not invent reasoning of your own — if
this tool does not support a step, you do not have it.

## Reporting

Present exactly this, and nothing you cannot source:

- **Summary** — one line
- **Root cause** — or "Unknown", if that is what `status` says
- **Evidence** — cite the concrete events, with ids, timestamps and messages
- **Confidence** — as a percentage, with the caveat below
- **Recommended fixes**

When `status` is `unknown`, say the cause is unknown and name the evidence that
would settle it. Do not upgrade a low-confidence guess into an answer because
the user wants one.

Mention `alternativeCauses` when present. A single confident-sounding answer
that hides a competing explanation is worse than two honest ones.

## What confidence actually means

`confidence` is a **conservative heuristic scored from corroborating evidence,
not a calibrated probability**. Nothing has been measured against ground truth.
0.85 means "several independent pieces of evidence line up", not "right 85% of
the time".

`confidenceBreakdown` separates three things a single number hides:

- `evidenceStrength` — how much corroboration the chosen cause has
- `dataCompleteness` — how much of the possible evidence was captured at all
- `alternativeStrength` — how good the next-best explanation is

High strength with low completeness means a confident conclusion drawn from a
narrow slice. Say so.

## Rules

**Never ask for pasted logs while a VM Service is reachable.** That is the
entire point of this server. Ask for the URI, not the output.

**Never claim a cause the evidence does not carry.** Every claim cites an
`eventId`. If you cannot cite one, you are speculating — label it as such.

**Correlation is not causation, and the tool does not pretend otherwise.** A
network failure before an exception is a lead. Confirm it against the stack
trace before presenting it as the cause.

**Absence of evidence is not evidence of absence.** Check `limitations` and
`cannotObserve` first. Retention drops old events, network is pull-on-demand,
and platform-code and WebView activity is never visible.

**Two tools change state**, and neither touches the user's project:
`connect_vm` enables HTTP timeline logging on the app, and `get_timeline` with
`recordFrom: true` rewrites VM recording flags. Everything else only reads. This
server never modifies code or files.

**Sessions matter.** A hot restart or a reconnect starts a new session, and
tools return only the current one. If `runtime_status` shows a `sessionId` you
have not seen, the evidence you were reasoning about belongs to a previous run.

## Worked example

> User: "the checkout screen crashes sometimes"

```
runtime_health
  → verdict "failing", exceptions.latest[0] = exc_00142
    "Null check operator used on a null value"

what_changed { eventId: "exc_00142" }
  → network: net_00138  GET /api/cart → 500, ended 180ms before
  → logs:    log_00140  "cart was null"
  → timeline: net_00138 → log_00140 → exc_00142

get_exceptions { limit: 1 }
  → stack trace: #0 _CheckoutState.build (checkout.dart:88)

diagnose_runtime
  → status "diagnosed", confidence 0.9
  → rootCause: the null check at checkout.dart:88
  → evidence: [exc_00142, net_00138, log_00140]
  → alternativeCauses: []
```

Reported:

> **Summary** — Checkout crashes when the cart API fails.
> **Root cause** — `checkout.dart:88` dereferences the cart with `!`, and
> `GET /api/cart` returned 500 180ms earlier (`net_00138`), so the cart was null
> (`log_00140`) when `build` ran (`exc_00142`).
> **Confidence** — 90%, from three corroborating events. Heuristic, not calibrated.
> **Fix** — handle the non-2xx response and render an error state instead of
> assuming a cart.

Note what did not happen: no `get_widget_tree`, no `get_frames`, no
`get_timeline`. None of them would have changed the answer.
