---
name: flutter-runtime-diagnosis
description: Diagnose a running Flutter app from LIVE runtime data via Flutter Lamp instead of pasted logs. Use whenever a Flutter app is running and the user asks why something is failing, slow, throwing, rebuilding, or dropping frames — "why is this widget failing", "why are frames dropping", "which API caused this", "what's the root cause". Connects to the Dart VM Service, gathers exceptions/frames/logs/network, and runs diagnose_runtime().
---

# Flutter Runtime Diagnosis

Diagnose Flutter issues from **live runtime telemetry**, never from pasted logs.

## Hard rule

If a Flutter app is running and a VM Service can be reached, **never ask the
developer to paste logs, stack traces, or screenshots.** Live runtime context
always wins. Only fall back to manual logs if no VM Service is reachable.

## Prerequisite

The `flutter-lamp` MCP server must be configured in the client (see the
repo README). Its tools appear as `connect_vm`, `runtime_status`, `get_logs`,
`get_exceptions`, `get_frames`, `get_network`, `diagnose_runtime`.

## Procedure

1. **Detect the Dart VM Service URI.** Look, in order:
   - the `flutter run` / `flutter attach` console output for the line
     `A Dart VM Service on <device> is available at: http://127.0.0.1:PORT/TOKEN=/`
   - if you launched the app yourself, capture that line from stdout
   - if the app is running but the URI is not visible, ask the developer for
     that **one line only** (the URI) — not logs. Suggest they relaunch with
     `flutter run --vm-service-port=8181` for a stable URI next time.

2. **Connect:** call `connect_vm` with the URI (http:// or ws:// both accepted).

3. **Confirm data is flowing:** call `runtime_status`. If `connected` is false,
   the URI is wrong or the app exited — re-detect. If `eventsCaptured` is 0, ask
   the developer to reproduce the issue in the app now, then continue.

4. **Gather runtime context** (do not summarize these to the user yet):
   - `get_exceptions`
   - `get_frames` with `onlyJanky: true`
   - `get_logs` with `minSeverity: "warning"`
   - `get_network`
   - for structure/rebuild questions: `get_widget_tree` (and `get_selected_widget` if the dev has selected one)
   - for slowness/leak questions: `get_memory`, and `get_timeline` (call once with `recordFrom: true`, ask the dev to reproduce, then read)

5. **Diagnose:** call `diagnose_runtime()`. It correlates the evidence and
   returns `summary`, `rootCause`, `evidence`, `confidence` (0–1), and
   `recommendedFixes`.

6. **Present** exactly these sections:
   - **Summary**
   - **Root Cause**
   - **Evidence** (cite the concrete runtime events — source, timestamp, message)
   - **Confidence** (as a percentage)
   - **Recommended Fixes**

   If `confidence` < 0.70, say the cause is **Unknown** and state which
   additional runtime evidence is needed (e.g. "reproduce the crash while
   connected", "enable pause-on-exceptions"). Do not guess a cause.

## Notes

- Correlate before concluding — a network 500 immediately before a null-check
  exception is the story; the exception alone is not.
- The MCP returns JSON only. Turn it into the six sections above for the human.
- This skill is read-only against the running app; it never mutates app state.
