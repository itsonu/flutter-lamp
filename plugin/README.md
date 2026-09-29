# Flutter Lamp

Give Claude **live** eyes on a running Flutter app, so you never paste logs
again. This plugin adds two things:

- The **`flutter-lamp` MCP server**. It connects to your app's Dart VM Service
  and streams exceptions with stack traces, logs, HTTP calls, frame timings,
  rebuilds, navigation and memory as structured data. It also runs
  evidence-first root-cause diagnosis, and reports "Unknown" when the evidence
  is below 70% confidence instead of guessing.
- The **`flutter-runtime-diagnosis` skill**. It teaches Claude the connect →
  gather → `diagnose_runtime` flow, so it asks your app what happened instead
  of asking you to paste logs.

## Use it

1. Run your app in debug or profile mode: `flutter run`
2. Copy the VM Service URI it prints, for example
   `http://127.0.0.1:PORT/TOKEN=/`
3. Ask Claude: *"connect to my Flutter app at `<uri>` and tell me why it's
   throwing."*

Open `http://127.0.0.1:7373` for the live dashboard.

## What it runs, sends and fetches

- **Runs** `npx -y flutter-lamp@<pinned version>`, which downloads the
  [flutter-lamp](https://www.npmjs.com/package/flutter-lamp) package from npm
  the first time. Requires Node 20 or newer.
- **Connects** only to the VM Service URI you give it, normally on
  `127.0.0.1`. `connect_vm` enables `dart:io` HTTP profiling in your app so
  network capture works.
- **Serves** a dashboard on `127.0.0.1:7373`, bound to localhost only. Set
  `DASHBOARD_DISABLE=1` to turn it off.
- **Runs `adb`** on your machine only when you call `ensure_tcp_device`, to list
  Android transports or switch a USB device to TCP.
- **Sends nothing** to any other server. There is no telemetry. Credential
  header values are redacted in captured network data by default.

It never writes to your project files.

Source, full tool list and docs: <https://github.com/itsonu/flutter-lamp>.
License: MIT.
