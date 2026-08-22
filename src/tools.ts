import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "./core/connection.js";
import { diagnose } from "./diagnosis/engine.js";
import { getDashboardInfo } from "./dashboard/server.js";
import type { Severity } from "./core/events.js";

const SEVERITIES = ["debug", "info", "warning", "error", "critical"] as const;

/** Every tool returns JSON only (docs/Rules.md). */
function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "connect_vm",
    {
      title: "Connect to Flutter VM Service",
      description:
        "Connect to a running Flutter app's Dart VM Service and start collecting runtime data (logs, exceptions, frames, network). Pass the ws:// or http:// URI printed by `flutter run` (line: 'A Dart VM Service ... is available at:').",
      inputSchema: {
        uri: z.string().describe("VM Service URI, e.g. http://127.0.0.1:52719/abcdef=/ or ws://..."),
      },
    },
    async ({ uri }) => {
      try {
        const info = await connection.connect(uri);
        return json({ ok: true, ...info, message: "Connected. Collectors active." });
      } catch (err) {
        return json({ ok: false, error: errMsg(err) });
      }
    },
  );

  server.registerTool(
    "runtime_status",
    {
      title: "Runtime health check",
      description:
        "Report connection health, how many runtime events have been captured by category, and the retention window (per-category capacity, how many events were evicted, and the oldest event still held). Use to confirm the MCP is receiving live data and to know how far back the evidence goes.",
      inputSchema: {},
    },
    async () =>
      json({
        connected: connection.connected,
        eventsCaptured: connection.store.size(),
        byCategory: connection.store.counts(),
        // Retention is bounded; say so rather than letting an agent reason over
        // truncated history without knowing it is truncated.
        retention: connection.store.retention(),
        dashboard_url: getDashboardInfo().url,
      }),
  );

  server.registerTool(
    "get_dashboard_url",
    {
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
      title: "Diagnose runtime",
      description:
        "Correlate captured runtime evidence into a root-cause diagnosis: summary, root cause, evidence, confidence (0-1), and recommended fixes. States 'Unknown' when confidence is below 70%.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      await connection.refreshPullCollectors(); // ensure latest network is in evidence
      return json(diagnose(connection.store));
    },
  );

  // ── Phase 4 — Widget Inspector ────────────────────────────────────────────
  server.registerTool(
    "get_widget_tree",
    {
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
        const res = await connection.isolateCall<{ result?: unknown }>(
          "ext.flutter.inspector.getRootWidgetSummaryTree",
          { groupName: INSPECTOR_GROUP },
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
      title: "Get selected widget",
      description:
        "The widget currently selected in the Flutter Inspector (via 'select widget mode' in the app/DevTools). Returns null if nothing is selected.",
      inputSchema: {},
    },
    async () => {
      connection.requireConnectedOrThrow();
      try {
        const res = await connection.isolateCall<{ result?: unknown }>(
          "ext.flutter.inspector.getSelectedSummaryWidget",
          { previousSelectionId: null, groupName: INSPECTOR_GROUP },
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
      title: "Get VM timeline events",
      description:
        "Recent VM timeline trace events (build/paint/layout/GC/etc.), most recent first. Requires timeline recording — enable with recordFrom=true (sets Dart, GC, Compiler & Embedder streams) then reproduce the activity.",
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
      const events = (tl.traceEvents ?? [])
        .filter((e) => e.ph === "X" || e.ph === "B" || e.ph === "i")
        .slice(-limit)
        .reverse()
        .map((e) => ({ name: e.name, phase: e.ph, category: e.cat, tsMicros: e.ts, durMicros: e.dur }));
      return json({ count: events.length, events });
    },
  );
}

const INSPECTOR_GROUP = "flutter-lamp";

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
