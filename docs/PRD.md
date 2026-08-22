# Product Requirements

## Problem

Debugging a Flutter app with an AI coding agent means copy-pasting: stack
traces, `flutter run` output, DevTools screenshots, network logs. The agent sees
a snapshot that is already stale by the time it answers, and it cannot ask a
follow-up question of the app — only of you.

## Goal

Give MCP-compatible agents live, structured runtime context from a running
Flutter app, so diagnosis is grounded in what the app actually did rather than
in what got pasted into the chat.

## Users

| User | What they get |
| --- | --- |
| Flutter developers | Stop pasting logs; the agent reads the runtime directly |
| AI coding agents | Structured, queryable runtime evidence instead of prose |
| QA engineers | A live dashboard and exportable evidence for bug reports |
| Performance engineers | Frame timings, memory and timeline correlated with app activity |

## Principles

**Evidence over opinion.** A diagnosis names a concrete captured event or it
reports `Unknown`. The runtime is the source of truth; the model is not.

**Relevant context over maximum context.** Tools return the smallest sufficient
answer. Dumping the whole store into a prompt is a failure mode, not a feature.

**Structured over textual.** Every tool returns JSON. Agents should not be
parsing human-readable log lines.

**Official APIs only.** The Dart VM Service Protocol and Flutter service
extensions. Never scrape DevTools, never parse screenshots.

**Read-only by default.** Runtime inspection must not mutate app state without
explicit intent.

**Local-first.** Runtime data stays on the machine unless the developer
deliberately routes it elsewhere.

**Flutter-first.** This is Flutter runtime intelligence, not a generic APM.

## Shipped in v0.1.0

| Capability | Tool |
| --- | --- |
| VM Service connection | `connect_vm` |
| Health and event counts | `runtime_status` |
| Console and structured logs | `get_logs` |
| Exceptions with reconstructed stack traces | `get_exceptions` |
| Frame timings and jank | `get_frames` |
| HTTP requests (Dio, `package:http`) | `get_network` |
| Widget tree | `get_widget_tree` |
| Selected widget | `get_selected_widget` |
| Dart heap and external memory | `get_memory` |
| VM timeline events | `get_timeline` |
| Correlated root-cause diagnosis | `diagnose_runtime` |
| Live browser dashboard | `get_dashboard_url` |

Plus a `flutter-runtime-diagnosis` Claude Code skill that runs the whole
connect → gather → diagnose flow.

## Non-goals

Not a generic APM or observability platform. Not a hosted service. Not a
DevTools replacement — DevTools is better at what DevTools does; this exists so
an agent can reason over the same data. Not Claude-specific: any MCP client
should work.

## Constraints

Debug and profile builds only — the VM Service, the Inspector and `dart:io` HTTP
profiling do not exist in release builds. HTTP capture is Dart-side only: calls
from platform code or a WebView are invisible. There is no push stream for
`dart:io` HTTP, so network is fetched on demand.

## Direction

Evolve from "exposes Flutter runtime information" toward "a runtime evidence
layer an agent can reason over, and eventually act on with human approval". See
[`Phases.md`](Phases.md) for sequencing and
[`Improvement-Plan.md`](Improvement-Plan.md) for the current audit and backlog.
