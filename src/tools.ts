import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "./core/connection.js";
import { diagnose } from "./diagnosis/engine.js";
import { exportSession } from "./export/session.js";
import { getDashboardInfo } from "./dashboard/server.js";
import { redactionEnabled } from "./core/redaction.js";
import type { Severity } from "./core/events.js";
import { runtimeHealth, whatChanged } from "./diagnosis/health.js";
import { routeHistory } from "./diagnosis/navigation.js";
import { diagnosePerformance } from "./diagnosis/performance.js";
import { rebuildReport } from "./diagnosis/rebuilds.js";
import { stateActivity } from "./diagnosis/stateActivity.js";
import { VERSION } from "./version.js";
import { withInspectorGroup, type IsolateCall } from "./vm/inspectorGroup.js";
import { timelineStaleness } from "./vm/timelineStaleness.js";
import { diagnoseUnreachable, promoteToTcp, transportReport } from "./vm/adb.js";

const SEVERITIES = ["debug", "info", "warning", "error", "critical"] as const;

/**
 * Tool safety classification (docs/Rules.md: anything that mutates app or VM
 * state is declared as such). Two tools here are NOT pure inspection:
 * `connect_vm` enables `httpEnableTimelineLogging` on the app, and
 * `get_timeline` with `recordFrom: true` changes VM recording flags. Everything
 * else only reads. An agent cannot tell the difference unless we say so.
 */
export const TOOL_SAFETY = {
  connect_vm: "mutating",
  ensure_tcp_device: "mutating",
  runtime_status: "read-only",
  runtime_health: "read-only",
  what_changed: "read-only",
  get_navigation: "read-only",
  get_rebuilds: "read-only",
  get_state_activity: "read-only",
  get_capabilities: "read-only",
  export_session: "read-only",
  get_dashboard_url: "read-only",
  get_logs: "read-only",
  get_exceptions: "read-only",
  get_frames: "read-only",
  get_network: "read-only",
  diagnose_runtime: "read-only",
  diagnose_performance: "read-only",
  explain_diagnosis: "read-only",
  get_widget_tree: "read-only",
  get_selected_widget: "read-only",
  get_memory: "read-only",
  get_timeline: "mutating",
} as const satisfies Record<string, "read-only" | "mutating">;

export type ToolName = keyof typeof TOOL_SAFETY;

/** Annotations derived from the safety map, so registration cannot drift from it. */
function ann(name: ToolName) {
  return TOOL_SAFETY[name] === "mutating" ? MUTATING : READ_ONLY;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Changes app or VM state, but nothing it changes is destructive or irreversible. */
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Inspector RPCs run through the connection's isolate-scoped caller. */
const isolateCall: IsolateCall = (method, params) => connection.isolateCall(method, params);

/** Every tool returns JSON only (docs/Rules.md). */
function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "connect_vm",
    {
      annotations: ann("connect_vm"),
      title: "Connect to Flutter VM Service",
      description:
        "Connect to a running Flutter app's Dart VM Service and start collecting runtime data (logs, exceptions, frames, network). Pass the ws:// or http:// URI printed by `flutter run` (line: 'A Dart VM Service ... is available at:'). NOT purely read-only: enables dart:io HTTP timeline logging on the app so network capture works.",
      inputSchema: {
        uri: z.string().describe("VM Service URI, e.g. http://127.0.0.1:52719/abcdef=/ or ws://..."),
      },
    },
    async ({ uri }) => {
      try {
        const info = await connection.connect(uri);
        return json({ ok: true, ...info, message: "Connected. Collectors active." });
      } catch (err) {
        // A bare ECONNREFUSED tells the agent nothing it can act on. Ask adb
        // whether the device is even attached before blaming the URI.
        return json({ ok: false, error: errMsg(err), transport: await diagnoseUnreachable() });
      }
    },
  );

  server.registerTool(
    "ensure_tcp_device",
    {
      annotations: ann("ensure_tcp_device"),
      title: "Prefer a wireless device transport",
      description:
        "Report Android device transports and recommend one, preferring wireless. A `flutter run` started on a USB transport loses its VM Service tunnel when the cable moves; one started on a TCP transport does not. Read-only by default. With promote:true it runs `adb tcpip` and `adb connect` to put a USB-attached device on a TCP transport — that restarts adbd on the device, needs the cable once, and is reversible with `adb usb`. Android-only: reports adbAvailable:false and changes nothing on iOS, desktop or web targets.",
      inputSchema: {
        promote: z
          .boolean()
          .default(false)
          .describe("Put a USB-only device onto a TCP transport. Changes device state."),
        serial: z
          .string()
          .optional()
          .describe("Which USB device to promote. Defaults to the first promotable one."),
        port: z.number().int().positive().max(65535).default(5555).describe("Device-side TCP port."),
      },
    },
    async ({ promote, serial, port }) => {
      const report = await transportReport();
      if (!promote) return json(report);
      if (!report.adbAvailable) {
        return json({ ...report, promotion: { ok: false, detail: "adb is not available on this machine." } });
      }
      const target = serial ?? report.promotable[0]?.serial;
      if (!target) {
        return json({
          ...report,
          promotion: { ok: false, detail: "No USB-only device to promote." },
        });
      }
      const promotion = await promoteToTcp(target, port);
      // Re-read: promotion changes what transports exist.
      return json({ ...(await transportReport()), promotion });
    },
  );

  server.registerTool(
    "runtime_status",
    {
      annotations: ann("runtime_status"),
      title: "Runtime health check",
      description:
        "Report connection health, the current debugging session, reconnection state, how many runtime events have been captured by category, and the retention window (per-category capacity, how many events were evicted, and the oldest event still held). Use to confirm the MCP is receiving live data and to know how far back the evidence goes.",
      inputSchema: {},
    },
    async () => {
      const status = connection.status();
      return json({
        connected: status.connected,
        // A hot restart or a dropped socket starts a new session. Other tools
        // return only the current session's evidence, so cross-run correlation
        // cannot happen by accident.
        sessionId: status.sessionId,
        reconnecting: status.reconnecting,
        reconnectAttempt: status.reconnectAttempt,
        // Captured events carry the VM's clock; this server's own notes carry
        // this machine's. A large offset means a timeline mixing the two is off
        // by that much.
        clockOffsetMs: status.clockOffsetMs,
        eventsCaptured: connection.store.size(),
        byCategory: connection.store.counts(),
        // Retention is bounded; say so rather than letting an agent reason over
        // truncated history without knowing it is truncated.
        retention: connection.store.retention(),
        dashboard_url: getDashboardInfo().url,
      });
    },
  );

  server.registerTool(
    "get_dashboard_url",
    {
      annotations: ann("get_dashboard_url"),
      title: "Get dashboard URL",
      description:
        "Return the URL of the live Realtime Runtime Dashboard (a browser UI streaming logs, network, exceptions, frames & memory). Open it in a browser to watch the app alongside the AI.",
      inputSchema: {},
    },
    async () => {
      const info = getDashboardInfo();
      return json({
        ...info,
        hint: info.running
          ? "Open this URL in a browser for the live dashboard."
          : "Dashboard is not running (disabled via DASHBOARD_DISABLE=1 or failed to bind its port).",
      });
    },
  );

  server.registerTool(
    "get_logs",
    {
      annotations: ann("get_logs"),
      title: "Get console & structured logs",
      description: "Console output (Stdout/Stderr) and dart:developer logging, most recent first.",
      inputSchema: {
        minSeverity: z.enum(SEVERITIES).optional().describe("Minimum severity to include."),
        source: z.enum(["Stdout", "Stderr", "Logging"]).optional().describe("Restrict to one log source."),
        contains: z.string().optional().describe("Case-insensitive substring filter."),
        sinceMs: z.number().optional().describe("Only events at/after this epoch-ms timestamp."),
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    async ({ minSeverity, source, contains, sinceMs, limit }) => {
      connection.requireConnectedOrThrow();
      // Query wider when a source filter is set, then narrow, so `limit` still
      // returns up to `limit` matching lines rather than limiting pre-filter.
      const rows = connection.store.query({
        category: "log",
        minSeverity: minSeverity as Severity | undefined,
        contains,
        since: sinceMs,
        limit: source ? undefined : limit,
      });
      const logs = source ? rows.filter((e) => e.source === source).slice(0, limit) : rows;
      return json({ logs });
    },
  );

  server.registerTool(
    "get_exceptions",
    {
      annotations: ann("get_exceptions"),
      title: "Get runtime exceptions",
      description:
        "Flutter framework errors and unhandled VM exceptions, most recent first. Each includes the error summary, offending widget, library, and a reconstructed stack trace (data.stackTrace) when available.",
      inputSchema: { limit: z.number().int().positive().max(200).default(20) },
    },
    async ({ limit }) => {
      connection.requireConnectedOrThrow();
      return json({ exceptions: connection.store.query({ category: "exception", limit }) });
    },
  );

  server.registerTool(
    "get_frames",
    {
      annotations: ann("get_frames"),
      title: "Get frame timings",
      description: "Frame build/raster timings. Set onlyJanky to focus on frames over the 16.7ms budget.",
      inputSchema: {
        onlyJanky: z.boolean().default(false),
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    async ({ onlyJanky, limit }) => {
      connection.requireConnectedOrThrow();
      const frames = connection.store.query({
        category: "frame",
        minSeverity: onlyJanky ? "warning" : undefined,
        limit,
      });
      return json({ frames });
    },
  );

  server.registerTool(
    "get_network",
    {
      annotations: ann("get_network"),
      title: "Get network requests",
      description:
        "HTTP requests/responses captured via dart:io profiling (covers Dio & package:http). Fetches the latest profile on demand, then returns completed requests most recent first.",
      inputSchema: { limit: z.number().int().positive().max(200).default(30) },
    },
    async ({ limit }) => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors();
      return json({ requests: connection.store.query({ category: "network", limit }) });
    },
  );

  server.registerTool(
    "diagnose_runtime",
    {
      annotations: ann("diagnose_runtime"),
      title: "Diagnose runtime",
      description:
        "Correlate captured runtime evidence into a root-cause diagnosis. Returns status (diagnosed|unknown), summary, rootCause, evidence (each with a citable eventId), a chronological timeline around the root cause, alternativeCauses that also fit, limitations describing what could not be seen, confidence (0-1) with a breakdown of evidence strength / data completeness / alternative strength, and recommended fixes. Status is 'unknown' below 70% rather than a guess.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors(); // ensure latest network is in evidence
      return json(diagnose(connection.store));
    },
  );

  server.registerTool(
    "diagnose_performance",
    {
      annotations: ann("diagnose_performance"),
      title: "Diagnose performance",
      description:
        "Why the app is janky, not just how much. Returns frame percentiles, the build-vs-raster split, and findings correlating jank against in-flight requests, route transitions and heap growth — each with its own evidence ids, strength and fix. Reports 'healthy' when jank is within normal range and 'unknown' when there are too few frames to tell a pattern from noise. States what it cannot see: no CPU sampling, no GC events, no widget rebuild counts.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors(); // network correlation needs the latest profile
      return json(diagnosePerformance(connection.store));
    },
  );

  // ── Phase 4 — Widget Inspector ────────────────────────────────────────────
  server.registerTool(
    "get_widget_tree",
    {
      annotations: ann("get_widget_tree"),
      title: "Get widget tree",
      description:
        "Snapshot of the running app's widget tree (summary tree from the Flutter Inspector). Use to understand structure, find a widget, or see what is mounted.",
      inputSchema: {
        maxDepth: z.number().int().positive().max(50).default(12).describe("How deep to traverse before truncating."),
      },
    },
    async ({ maxDepth }) => {
      connection.requireConnectedOrThrow();
      try {
        const res = await withInspectorGroup(isolateCall, (groupName) =>
          connection.isolateCall<{ result?: unknown }>(
            "ext.flutter.inspector.getRootWidgetSummaryTree",
            // `objectGroup`, not `groupName`. Flutter registers this through
            // _registerObjectGroupServiceExtension, which reads
            // parameters['objectGroup']! — a missing key throws inside the
            // observed app rather than returning an error here.
            { objectGroup: groupName },
          ),
        );
        return json({ tree: simplifyNode(res?.result ?? res, maxDepth) });
      } catch (err) {
        return json({ error: errMsg(err), hint: "Widget Inspector is only available in debug builds." });
      }
    },
  );

  server.registerTool(
    "get_selected_widget",
    {
      annotations: ann("get_selected_widget"),
      title: "Get selected widget",
      description:
        "The widget currently selected in the Flutter Inspector (via 'select widget mode' in the app/DevTools). Returns null if nothing is selected.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      try {
        const res = await withInspectorGroup(isolateCall, (groupName) =>
          connection.isolateCall<{ result?: unknown }>(
            "ext.flutter.inspector.getSelectedSummaryWidget",
            // Same required key. The previous selection id, if one were passed,
            // would go in `arg` — this extension is registered through
            // _registerServiceExtensionWithArg, which asserts on `objectGroup`
            // and reads the id from `arg`. Omitting it means "no previous
            // selection", which is what we want.
            { objectGroup: groupName },
          ),
        );
        return json({ selected: simplifyNode(res?.result ?? res, 6) });
      } catch (err) {
        return json({ error: errMsg(err) });
      }
    },
  );

  // ── Phase 6 — Memory ────────────────────────────────────────────────────────
  server.registerTool(
    "get_memory",
    {
      annotations: ann("get_memory"),
      title: "Get memory usage",
      description:
        "Current Dart heap usage for the main isolate (Dart heap in use, capacity, and external/native memory), in MB. Also records a snapshot into runtime history.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      return json(await connection.sampleMemory());
    },
  );

  // ── Phase 5 — Timeline ────────────────────────────────────────────────────
  server.registerTool(
    "get_timeline",
    {
      annotations: ann("get_timeline"),
      title: "Get VM timeline events",
      description:
        "Recent VM timeline trace events (build/paint/layout/GC/etc.), most recent first. Requires timeline recording — enable with recordFrom=true (sets Dart, GC, Compiler & Embedder streams) then reproduce the activity. recordFrom=true is NOT read-only: it changes the VM's recording configuration. Check recorderLagMs/stalled in the result: the VM recorder can stall permanently once its buffer fills while still reporting its streams as recorded, so events may be historical rather than current.",
      inputSchema: {
        recordFrom: z.boolean().default(false).describe("Turn on timeline recording streams before reading."),
        limit: z.number().int().positive().max(200).default(50),
      },
    },
    async ({ recordFrom, limit }) => {
      connection.requireConnectedOrThrow();
      if (recordFrom) {
        await connection.vmCall("setVMTimelineFlags", {
          recordedStreams: ["Dart", "GC", "Compiler", "Embedder"],
        });
        return json({ recording: true, message: "Timeline recording enabled. Reproduce the activity, then call get_timeline again." });
      }
      const tl = await connection.vmCall<{ traceEvents?: any[] }>("getVMTimeline");
      const raw = tl.traceEvents ?? [];
      // The recorder can stall permanently while its flags still claim it is
      // recording (measured on-device; see vm/timelineStaleness.ts). Compare
      // against the VM's own timeline clock so stale events are labelled.
      const nowMicros = await connection
        .vmCall<{ timestamp?: number }>("getVMTimelineMicros")
        .then((r) => (typeof r.timestamp === "number" ? r.timestamp : null))
        .catch(() => null);
      const staleness = timelineStaleness(nowMicros, raw);
      const events = raw
        .filter((e) => e.ph === "X" || e.ph === "B" || e.ph === "i")
        .slice(-limit)
        .reverse()
        .map((e) => ({ name: e.name, phase: e.ph, category: e.cat, tsMicros: e.ts, durMicros: e.dur }));
      return json({ count: events.length, ...staleness, events });
    },
  );

  // ── Agent-facing summaries ────────────────────────────────────────────────
  server.registerTool(
    "runtime_health",
    {
      annotations: ann("runtime_health"),
      title: "Runtime health snapshot",
      description:
        "One compact answer to 'is this app healthy right now'. Returns a verdict (healthy/degraded/failing/no-data) plus exception, network, frame, log and memory summaries with citable event ids, the retention window, and notes about anything that qualifies the numbers. Call this FIRST instead of calling six get_* tools.",
      inputSchema: {},
    },
    async () => {
      const status = connection.status();
      return json(
        runtimeHealth(connection.store, status.connected, status.reconnecting, connection.collectorHealth()),
      );
    },
  );

  server.registerTool(
    "what_changed",
    {
      annotations: ann("what_changed"),
      title: "What changed before an incident",
      description:
        "Evidence from the window leading up to a failure, plus a baseline comparison: the incident window measured against the equal window before it, per dimension (exceptions, network volume/failures/latency p50/p95, jank ratio, log errors, memory) with directions new/spiked/increased/decreased and citable evidence. Anchors on the given eventId, or the most recent exception, or the current time. Network uses interval matching, so a request that started before the window but failed inside it still counts. When the baseline predates observation, directions are unknown rather than fabricated.",
      inputSchema: {
        eventId: z
          .string()
          .optional()
          .describe("Anchor on this event (e.g. 'exc_00142'). Defaults to the most recent exception."),
        windowMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .default(30_000)
          .describe("How far back to look, in milliseconds."),
      },
    },
    async ({ eventId, windowMs }) => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors();
      return json(whatChanged(connection.store, { eventId, windowMs }));
    },
  );

  server.registerTool(
    "get_navigation",
    {
      annotations: ann("get_navigation"),
      title: "Route history",
      description:
        "The current route and recent route transitions, each with how long it was on screen and the exceptions, failed requests and janky frames attributed to it. Use to answer 'which screen is broken' and to scope other evidence to a screen. Network is attributed by overlap, so a request spanning a route change counts for both.",
      inputSchema: {
        limit: z.number().int().positive().max(100).default(20).describe("How many recent visits to return."),
      },
    },
    async ({ limit }) => {
      connection.requireConnectedOrThrow();
      return json(routeHistory(connection.store, limit));
    },
  );

  server.registerTool(
    "get_rebuilds",
    {
      annotations: ann("get_rebuilds"),
      title: "Widget rebuild hotspots",
      description:
        "Which widgets are rebuilding and how often, resolved to widget name, file and line, with your own code ranked above package code. Use for 'why is this screen slow to build' and to find needless rebuilds. Requires a debug build with widget creation tracking; reports why it is empty otherwise.",
      inputSchema: {
        limit: z.number().int().positive().max(50).default(15).describe("How many hotspots to return."),
      },
    },
    async ({ limit }) => {
      connection.requireConnectedOrThrow();
      return json(rebuildReport(connection.store, limit));
    },
  );

  server.registerTool(
    "get_state_activity",
    {
      annotations: ann("get_state_activity"),
      title: "State-management activity",
      description:
        "How much state-management activity the app is doing and when, plus how often build-heavy frames coincide with it — use with get_rebuilds to answer 'is this rebuild storm driven by state churn'. Counts and timing only: Riverpod sends an app-side buffer offset and provider an element id, neither resolvable to a provider name or value. Counts are NOT transition counts — a provider event means dependents were notified, so one state change in a widget-heavy tree produces many events. Stock Bloc posts nothing itself; a flutter_bloc app appears here only as the provider activity its notifications cause.",
      inputSchema: {
        buckets: z
          .number()
          .int()
          .positive()
          .max(60)
          .default(5)
          .describe("How many of the busiest one-second buckets to return."),
      },
    },
    async ({ buckets }) => {
      connection.requireConnectedOrThrow();
      return json(stateActivity(connection.store, buckets));
    },
  );

  server.registerTool(
    "explain_diagnosis",
    {
      annotations: ann("explain_diagnosis"),
      title: "Explain a diagnosis",
      description:
        "Why diagnose_runtime reached its conclusion: the claim, every cited event resolved back to its full record, the timeline around the root cause, competing explanations, what evidence is missing, and the confidence breakdown. Use to answer 'why do you think that' without inventing reasoning.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors();
      const diagnosis = diagnose(connection.store);
      return json({
        claim: diagnosis.rootCause,
        status: diagnosis.status,
        confidence: diagnosis.confidence,
        confidenceBreakdown: diagnosis.confidenceBreakdown,
        // Resolved, not summarized: the full stored record behind every id the
        // diagnosis cited, so nothing has to be taken on trust.
        evidence: diagnosis.evidence.map((item) => ({
          ...item,
          event: connection.store.byEventId(item.eventId) ?? null,
        })),
        timeline: diagnosis.timeline,
        alternativeCauses: diagnosis.alternativeCauses,
        missingEvidence: missingEvidenceFor(diagnosis),
        limitations: diagnosis.limitations,
      });
    },
  );

  server.registerTool(
    "export_session",
    {
      annotations: ann("export_session"),
      title: "Export the debugging session",
      description:
        "The whole session as one versioned JSON artifact: metadata, per-collector health, retention, the captured events, and every diagnosis (runtime, performance, navigation, rebuilds). Use mode 'brief' for the smallest sufficient context — the diagnoses plus only the events their evidence cites — and 'full' to archive everything retained, for a bug report, offline analysis or a regression fixture. Credentials are already redacted at capture, so nothing here was ever stored raw.",
      inputSchema: {
        mode: z
          .enum(["full", "brief"])
          .default("brief")
          .describe("'brief': diagnoses plus only the cited events. 'full': everything retained."),
      },
    },
    async ({ mode }) => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors();
      const status = connection.status();
      return json(
        exportSession(
          connection.store,
          {
            connected: status.connected,
            sessionId: status.sessionId,
            wsUri: status.wsUri, // redacted inside exportSession
            clockOffsetMs: status.clockOffsetMs,
            collectors: connection.collectorHealth(),
          },
          { mode },
        ),
      );
    },
  );

  server.registerTool(
    "get_capabilities",
    {
      annotations: ann("get_capabilities"),
      title: "What this server can observe",
      description:
        "Machine-readable capability report: active collectors, every tool with its safety class, what can and cannot be observed on this target, and the current redaction, dashboard and retention configuration. Read this before attempting an operation that may not be supported.",
      inputSchema: {},
    },
    async () => {
      const status = connection.status();
      const dashboard = getDashboardInfo();
      return json({
        server: { name: "flutter-lamp", version: VERSION },
        connection: {
          connected: status.connected,
          sessionId: status.sessionId,
          reconnecting: status.reconnecting,
        },
        collectors: connection.collectorNames(),
        transports: await transportReport(),
        // Health per collector: "unavailable" here means the empty evidence an
        // agent sees is blindness on this target, not a quiet app.
        collectorHealth: connection.collectorHealth(),
        tools: Object.entries(TOOL_SAFETY).map(([name, safety]) => ({ name, safety })),
        canObserve: [
          "Dart VM Service streams: Stdout, Stderr, Logging, Extension, Debug",
          "Flutter framework errors with reconstructed stack traces",
          "Frame build/raster timings, jank, and percentile statistics",
          "Per-frame widget rebuild counts with widget name, file and line (debug builds with widget creation tracking)",
          "dart:io HTTP requests (covers Dio and package:http)",
          "Widget tree and selected widget (debug builds only)",
          "Route changes via Flutter.Navigation (debug and profile builds)",
          "Riverpod provider activity — timing and volume only, with no provider name or value",
          "Provider dependent-notification activity (provider:provider_changed). In a flutter_bloc app this fires when a Bloc change notifies its dependents, so such an app is not silent here — but the event count tracks how many widgets were notified, NOT how many Bloc transitions occurred",
          "Android device transports via adb, when adb is installed",
          "Dart heap and external memory",
          "VM timeline events (on demand)",
        ],
        cannotObserve: [
          "Release builds — the VM Service, Inspector and HTTP profiling do not exist there",
          "HTTP from platform (Kotlin/Swift) code or a WebView — only dart:io traffic is visible",
          "Anything before connect_vm was called",
          "Evidence older than the retention window",
          "Redacted credential values (headers, sensitive query parameters, tokens in text)",
          "CPU samples and GC events — a slow build can be traced to a widget, but not to a function",
          "Provider names and values — Riverpod sends an app-side buffer offset and provider an element id, with no service extension to resolve either",
          "Bloc transitions, events, states and errors — stock bloc posts nothing to the VM Service and registers no ext.bloc.* RPC (measured against 9.1.1). Its own observability runs through BlocObserver inside the app process. Bloc transition COUNTS cannot be derived from provider events: measured at 20 transitions against ~1,220 provider notifications, because the probe has 60 widgets watching. A flutter_bloc app that used no provider-backed lookup would be silent here entirely",
        ],
        configuration: {
          redaction: redactionEnabled() ? "on" : "off (FLUTTER_LAMP_REDACT=off)",
          dashboard: dashboard.running ? dashboard.url : "disabled",
          retention: connection.store.capacities(),
        },
      });
    },
  );
}

/** What extra evidence would raise confidence, stated concretely. */
function missingEvidenceFor(diagnosis: ReturnType<typeof diagnose>): string[] {
  const out: string[] = [];
  if (diagnosis.status === "unknown") {
    out.push("Reproduce the problem while connected — the strongest evidence is the failure itself.");
  }
  if (diagnosis.confidenceBreakdown.dataCompleteness < 0.8) {
    out.push("Some evidence categories are empty. Call get_network and get_memory, then diagnose again.");
  }
  if (diagnosis.alternativeCauses.length > 0) {
    out.push(
      `A competing explanation fits: "${diagnosis.alternativeCauses[0].rootCause}". Evidence that rules it in or out would sharpen this.`,
    );
  }
  if (!diagnosis.evidence.some((e) => e.category === "network")) {
    out.push("No network evidence supports this. If the failure follows a request, call get_network first.");
  }
  return out;
}

/** Collapse a verbose DiagnosticsNode tree to {type, description, children} with a depth cap. */
function simplifyNode(node: any, depth: number): unknown {
  if (node == null || typeof node !== "object") return node ?? null;
  const out: Record<string, unknown> = {
    type: node.widgetRuntimeType ?? node.type,
    description: node.description,
  };
  const children: any[] = node.children ?? [];
  if (children.length > 0) {
    out.childCount = children.length;
    out.children = depth > 0 ? children.map((c) => simplifyNode(c, depth - 1)) : "…(truncated)";
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
