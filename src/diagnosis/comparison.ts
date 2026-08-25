import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import { percentile, round2 } from "./stats.js";

/**
 * Baseline-vs-incident comparison: the "what changed" question answered as a
 * comparison rather than a listing.
 *
 * The incident window is `[anchor − w, anchor]`; the baseline is the window of
 * the same width immediately before it. Comparing adjacent equal windows is a
 * deliberate simplicity: it needs no stored baselines, works on any session
 * old enough, and "the ten seconds before things went wrong versus the ten
 * seconds before that" is precisely the comparison a developer makes by eye.
 *
 * All arithmetic here is deterministic. The model consumes directions and
 * numbers; it never computes them.
 */

export type ChangeDirection = "new" | "spiked" | "increased" | "decreased" | "unknown";

/**
 * `spiked` means the incident value is at least this multiple of the baseline.
 * A policy threshold, like the diagnosis engine's 70% — not calibrated against
 * anything; chosen so that ordinary jitter reads as `increased`, not `spiked`.
 */
export const SPIKE_FACTOR = 3;

export interface DimensionChange {
  dimension: string;
  /** Null when the baseline window is not covered by observation. */
  baseline: number | null;
  incident: number;
  direction: ChangeDirection;
  /** Incident-window events backing this change, most relevant first. */
  evidence: string[];
}

export interface WindowComparison {
  baselineFromMs: number;
  baselineToMs: number;
  incidentFromMs: number;
  incidentToMs: number;
  /**
   * False when observation began after the baseline window opened — because
   * the session started later, or retention dropped it. An uncovered baseline
   * makes every count look "new", so directions become "unknown" instead.
   */
  baselineCovered: boolean;
  /** Dimensions that changed. Unchanged and doubly-empty dimensions are omitted. */
  changes: DimensionChange[];
}

export function compareWindows(
  store: RuntimeStore,
  all: RuntimeEvent[],
  anchorMs: number,
  windowMs: number,
): WindowComparison {
  const incidentFrom = anchorMs - windowMs;
  const baselineFrom = anchorMs - 2 * windowMs;

  // When did observation actually begin? The session start when known,
  // otherwise the oldest retained event. Anything before that is unobserved,
  // not quiet.
  const observedSince = store.sessionStarted() ?? store.retention().oldestEventMs;
  const baselineCovered = observedSince !== null && observedSince <= baselineFrom;

  const inWindow = (from: number, to: number) =>
    all.filter((e) => e.timestamp >= from && e.timestamp < to);
  const baseline = inWindow(baselineFrom, incidentFrom);
  const incident = inWindow(incidentFrom, anchorMs + 1);

  const changes: DimensionChange[] = [];
  const add = (
    dimension: string,
    baselineValue: number | null,
    incidentValue: number | null,
    evidence: string[],
  ) => {
    if (incidentValue === null) return;
    const b = baselineCovered ? baselineValue : null;
    if ((b ?? 0) === 0 && incidentValue === 0) return; // doubly quiet — omit
    const direction = directionOf(b, incidentValue);
    if (direction === null) return; // unchanged — this is a list of changes
    changes.push({
      dimension,
      baseline: b,
      incident: round2(incidentValue),
      direction,
      evidence: evidence.slice(0, 3),
    });
  };

  const count = (events: RuntimeEvent[], match: (e: RuntimeEvent) => boolean) =>
    events.filter(match);

  // Exceptions
  const bExc = count(baseline, (e) => e.category === "exception");
  const iExc = count(incident, (e) => e.category === "exception");
  add("exceptions", bExc.length, iExc.length, iExc.map((e) => e.eventId));

  // Network volume and failures
  const isNet = (e: RuntimeEvent) => e.category === "network";
  const isFail = (e: RuntimeEvent) =>
    isNet(e) && (e.severity === "error" || e.severity === "warning");
  const bNet = count(baseline, isNet);
  const iNet = count(incident, isNet);
  add("networkRequests", bNet.length, iNet.length, iNet.map((e) => e.eventId));
  const bFail = count(baseline, isFail);
  const iFail = count(incident, isFail);
  add("networkFailures", bFail.length, iFail.length, iFail.map((e) => e.eventId));

  // Network latency. Small windows mean small samples; the numbers are
  // indicative, and the evidence cites the slowest incident request so the
  // agent can look at the concrete offender rather than trusting a percentile.
  const durations = (events: RuntimeEvent[]) =>
    events
      .filter((e) => isNet(e) && typeof e.data.durationMs === "number")
      .map((e) => ({ id: e.eventId, ms: Number(e.data.durationMs) }));
  const bDur = durations(baseline);
  const iDur = durations(incident);
  if (iDur.length > 0) {
    const slowest = [...iDur].sort((a, b) => b.ms - a.ms)[0];
    for (const [name, q] of [
      ["networkLatencyP50Ms", 0.5],
      ["networkLatencyP95Ms", 0.95],
    ] as const) {
      add(
        name,
        percentile(bDur.map((d) => d.ms).sort((a, b) => a - b), q),
        percentile(iDur.map((d) => d.ms).sort((a, b) => a - b), q),
        [slowest.id],
      );
    }
  }

  // Frames: jank ratio as a percentage.
  const frames = (events: RuntimeEvent[]) => count(events, (e) => e.category === "frame");
  const janky = (events: RuntimeEvent[]) => frames(events).filter((e) => e.data.janky === true);
  const ratio = (events: RuntimeEvent[]) => {
    const f = frames(events);
    return f.length === 0 ? null : (janky(events).length / f.length) * 100;
  };
  const iJank = janky(incident).sort(
    (a, b) => (Number(b.data.elapsedMs) || 0) - (Number(a.data.elapsedMs) || 0),
  );
  add("jankPercent", ratio(baseline), ratio(incident), iJank.map((e) => e.eventId));

  // State-management activity. Volume only: the frameworks broadcast that a
  // change happened, never what changed.
  const isState = (e: RuntimeEvent) => e.category === "state";
  const iState = count(incident, isState);
  add("stateChanges", count(baseline, isState).length, iState.length, iState.map((e) => e.eventId));

  // Logs by severity
  const logsAt = (events: RuntimeEvent[], severities: string[]) =>
    count(events, (e) => e.category === "log" && severities.includes(e.severity));
  const iLogErr = logsAt(incident, ["error", "critical"]);
  add("logErrors", logsAt(baseline, ["error", "critical"]).length, iLogErr.length, iLogErr.map((e) => e.eventId));
  const iLogWarn = logsAt(incident, ["warning"]);
  add("logWarnings", logsAt(baseline, ["warning"]).length, iLogWarn.length, iLogWarn.map((e) => e.eventId));

  // Memory: the latest heap sample in each window. Sampling is on-demand, so
  // either window may simply have none — omitted rather than guessed.
  const heap = (events: RuntimeEvent[]) => {
    const samples = events
      .filter((e) => e.source === "getMemoryUsage" && typeof e.data.heapUsageMB === "number")
      .sort((a, b) => a.timestamp - b.timestamp);
    const last = samples[samples.length - 1];
    return last ? { value: Number(last.data.heapUsageMB), id: last.eventId } : null;
  };
  const bHeap = heap(baseline);
  const iHeap = heap(incident);
  if (iHeap) add("memoryHeapMB", bHeap?.value ?? null, iHeap.value, [iHeap.id]);

  return {
    baselineFromMs: baselineFrom,
    baselineToMs: incidentFrom,
    incidentFromMs: incidentFrom,
    incidentToMs: anchorMs,
    baselineCovered,
    changes,
  };
}

/** Null means unchanged — the caller omits it. */
function directionOf(baseline: number | null, incident: number): ChangeDirection | null {
  if (baseline === null) return "unknown";
  if (baseline === 0) return incident > 0 ? "new" : null;
  if (incident === baseline) return null;
  if (incident >= baseline * SPIKE_FACTOR) return "spiked";
  return incident > baseline ? "increased" : "decreased";
}
