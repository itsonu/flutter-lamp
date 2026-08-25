import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { CollectorReport } from "../core/connection.js";
import { correlate, timelineAround, type TimelineEntry } from "./correlation.js";
import { routeHistory } from "./navigation.js";

/**
 * Compact runtime summaries for agents.
 *
 * The point is what is NOT here. An agent that has to call six tools and read
 * a thousand events to answer "is this app healthy" burns its context on
 * transport. These return the smallest sufficient answer, with event ids so the
 * agent can drill into anything that looks wrong.
 */

export type Verdict = "no-data" | "healthy" | "degraded" | "failing";

export interface HealthReport {
  verdict: Verdict;
  connected: boolean;
  sessionId: string | null;
  sessionDurationMs: number | null;
  exceptions: { total: number; latest: Array<{ eventId: string; message: string }> };
  network: { total: number; failed: number; latestFailure: { eventId: string; message: string } | null };
  frames: { total: number; janky: number; jankPercent: number; worstMs: number | null };
  logs: { total: number; errors: number; warnings: number };
  memory: { samples: number; latestHeapMB: number | null; capacityMB: number | null; growthPercent: number | null };
  /** The route the user is on, and how long they have been there. */
  currentRoute: { eventId: string; name: string | null; enteredMs: number; exceptions: number } | null;
  retention: ReturnType<RuntimeStore["retention"]>;
  /** Per-collector health — empty evidence from a non-active collector is blindness, not quiet. */
  collectors: CollectorReport[];
  /** Anything an agent should know before trusting the numbers above. */
  notes: string[];
}

export function runtimeHealth(
  store: RuntimeStore,
  connected: boolean,
  reconnecting = false,
  collectors: CollectorReport[] = [],
): HealthReport {
  const all = store.query({ limit: 5_000 });
  const exceptions = all.filter((e) => e.category === "exception");
  const network = all.filter((e) => e.category === "network");
  const failed = network.filter((e) => e.severity === "error" || e.severity === "warning");
  const frames = all.filter((e) => e.category === "frame");
  const janky = frames.filter((e) => e.data.janky === true);
  const logs = all.filter((e) => e.category === "log");
  const memory = all
    .filter((e) => e.source === "getMemoryUsage" && typeof e.data.heapUsageMB === "number")
    .sort((a, b) => a.timestamp - b.timestamp);

  const started = store.sessionStarted();
  const worst = janky.reduce<number | null>(
    (max, e) => Math.max(max ?? 0, Number(e.data.elapsedMs) || 0) || null,
    null,
  );
  const firstHeap = memory.length > 0 ? Number(memory[0].data.heapUsageMB) : null;
  const lastHeap = memory.length > 0 ? Number(memory[memory.length - 1].data.heapUsageMB) : null;

  const notes: string[] = [];
  if (reconnecting) notes.push("Reconnecting: the stream is interrupted, so recent evidence may be missing.");
  if (!connected) notes.push("Not connected. These figures describe the last session, not a live app.");
  if (network.length === 0) {
    notes.push("Network is pull-on-demand — call get_network to refresh it before trusting the count.");
  }
  if (Object.values(store.retention().evicted).some((n) => n > 0)) {
    notes.push("Retention limit reached: some older evidence has been dropped.");
  }
  for (const c of collectors) {
    if (c.status !== "active") {
      notes.push(`Collector "${c.name}" is ${c.status}${c.detail ? `: ${c.detail}` : "."}`);
    }
  }

  return {
    verdict: verdictFor(all.length, exceptions.length, failed.length, janky.length, frames.length),
    connected,
    sessionId: store.currentSession(),
    sessionDurationMs: started === null ? null : Math.max(0, Date.now() - started),
    exceptions: {
      total: exceptions.length,
      latest: exceptions.slice(0, 3).map((e) => ({ eventId: e.eventId, message: e.message })),
    },
    network: {
      total: network.length,
      failed: failed.length,
      latestFailure: failed[0] ? { eventId: failed[0].eventId, message: failed[0].message } : null,
    },
    frames: {
      total: frames.length,
      janky: janky.length,
      jankPercent: frames.length === 0 ? 0 : Math.round((janky.length / frames.length) * 100),
      worstMs: worst,
    },
    logs: {
      total: logs.length,
      errors: logs.filter((e) => e.severity === "error" || e.severity === "critical").length,
      warnings: logs.filter((e) => e.severity === "warning").length,
    },
    memory: {
      samples: memory.length,
      latestHeapMB: lastHeap,
      capacityMB: memory.length > 0 ? Number(memory[memory.length - 1].data.heapCapacityMB) : null,
      growthPercent:
        firstHeap && firstHeap > 0 && lastHeap !== null
          ? Math.round(((lastHeap - firstHeap) / firstHeap) * 100)
          : null,
    },
    currentRoute: currentRouteOf(store),
    retention: store.retention(),
    collectors,
    notes,
  };
}

function currentRouteOf(store: RuntimeStore): HealthReport["currentRoute"] {
  const { current } = routeHistory(store, 1);
  if (!current) return null;
  return {
    eventId: current.eventId,
    name: current.name,
    enteredMs: current.enteredMs,
    exceptions: current.exceptions.length,
  };
}

function verdictFor(
  total: number,
  exceptions: number,
  networkFailures: number,
  janky: number,
  frames: number,
): Verdict {
  if (total === 0) return "no-data";
  if (exceptions > 0) return "failing";
  if (networkFailures > 0) return "degraded";
  if (frames > 0 && janky / frames >= 0.2 && janky >= 3) return "degraded";
  return "healthy";
}

export interface ChangeWindow {
  anchor: { eventId: string; timestamp: number; message: string } | null;
  windowMs: number;
  fromMs: number;
  toMs: number;
  exceptions: EventSummary[];
  network: EventSummary[];
  logs: EventSummary[];
  /** Route changes in the window — often the change that explains the rest. */
  navigation: EventSummary[];
  system: EventSummary[];
  frames: { total: number; janky: number; worstMs: number | null };
  memory: { from: number | null; to: number | null; deltaMB: number | null };
  timeline: TimelineEntry[];
  notes: string[];
}

export interface EventSummary {
  eventId: string;
  timestamp: number;
  severity: string;
  message: string;
}

/**
 * What happened in the window leading up to a point in time.
 *
 * Anchored on an event id when given one, otherwise on the most recent
 * exception, otherwise on now — because "what changed before the crash" is the
 * question being asked, and the crash is usually the newest exception.
 */
export function whatChanged(
  store: RuntimeStore,
  opts: { eventId?: string; windowMs?: number } = {},
): ChangeWindow {
  const windowMs = opts.windowMs ?? 30_000;
  const all = store.query({ limit: 5_000 });

  // Track whether the REQUESTED anchor resolved, separately from whichever
  // anchor we end up using. Falling back silently would answer a different
  // question than the one asked.
  const requested = opts.eventId ? store.byEventId(opts.eventId) : undefined;
  const anchorEvent = requested ?? all.find((e) => e.category === "exception");

  const toMs = anchorEvent?.timestamp ?? Date.now();
  const fromMs = toMs - windowMs;
  const notes: string[] = [];
  if (opts.eventId && !requested) {
    notes.push(
      `No event with id ${opts.eventId} is retained — it may have been evicted. ` +
        (anchorEvent
          ? "Anchored on the most recent exception instead."
          : "No exception to fall back to, so the window ends at the current time."),
    );
  }
  if (!anchorEvent) notes.push("No exception found; the window ends at the current time.");

  const inWindow = all.filter((e) => e.timestamp >= fromMs && e.timestamp <= toMs);
  const frames = inWindow.filter((e) => e.category === "frame");
  const janky = frames.filter((e) => e.data.janky === true);
  const memory = inWindow
    .filter((e) => e.source === "getMemoryUsage" && typeof e.data.heapUsageMB === "number")
    .sort((a, b) => a.timestamp - b.timestamp);
  const from = memory.length > 0 ? Number(memory[0].data.heapUsageMB) : null;
  const to = memory.length > 0 ? Number(memory[memory.length - 1].data.heapUsageMB) : null;

  return {
    anchor: anchorEvent
      ? { eventId: anchorEvent.eventId, timestamp: anchorEvent.timestamp, message: anchorEvent.message }
      : null,
    windowMs,
    fromMs,
    toMs,
    exceptions: summarize(inWindow.filter((e) => e.category === "exception" && e.id !== anchorEvent?.id)),
    // Network uses interval correlation, so a request that started before the
    // window but failed inside it still counts as a change.
    network: summarize(
      anchorEvent
        ? correlate(all, anchorEvent, windowMs)
            .filter((c) => c.event.category === "network")
            .map((c) => c.event)
        : inWindow.filter((e) => e.category === "network"),
    ),
    logs: summarize(
      inWindow.filter(
        (e) => e.category === "log" && ["warning", "error", "critical"].includes(e.severity),
      ),
    ),
    navigation: summarize(inWindow.filter((e) => e.category === "navigation")),
    system: summarize(inWindow.filter((e) => e.category === "system" && e.source === "system")),
    frames: {
      total: frames.length,
      janky: janky.length,
      worstMs: janky.reduce<number | null>(
        (max, e) => Math.max(max ?? 0, Number(e.data.elapsedMs) || 0) || null,
        null,
      ),
    },
    memory: { from, to, deltaMB: from !== null && to !== null ? round2(to - from) : null },
    timeline: anchorEvent ? timelineAround(all, anchorEvent, windowMs) : [],
    notes,
  };
}

function summarize(events: RuntimeEvent[]): EventSummary[] {
  return events.slice(0, 20).map((e) => ({
    eventId: e.eventId,
    timestamp: e.timestamp,
    severity: e.severity,
    message: e.message,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
