import type { RuntimeEvent } from "../core/events.js";

/**
 * Temporal correlation over runtime evidence.
 *
 * Deterministic analysis runs before the model reasons: narrowing "what
 * happened around this failure" is an interval problem, not a judgement call,
 * and an LLM asked to reconstruct chronology from a flat event list will get it
 * wrong in ways nobody can audit.
 *
 * Events are treated as intervals rather than instants. A network request
 * occupies the span between its start and its end, and that distinction is the
 * whole point: a request that begins 30 seconds before an exception and returns
 * 500 immediately before it is *adjacent* to the failure, even though its
 * timestamp is far away. Comparing start times alone drops exactly the slow and
 * hanging requests most likely to have caused the thing being diagnosed.
 */

export interface Interval {
  start: number;
  end: number;
}

/** How an event sits relative to the anchor. */
export type Relation = "preceded" | "overlapped" | "followed" | "anchor";

export interface Correlated {
  event: RuntimeEvent;
  relation: Relation;
  /**
   * Gap to the anchor in ms: negative when the event finished before the anchor
   * began, positive when it began after the anchor ended, 0 when they overlap.
   */
  deltaMs: number;
}

/**
 * The span an event occupies. Only network requests have real duration; every
 * other event is a point in time.
 */
export function intervalOf(event: RuntimeEvent): Interval {
  if (event.category === "network") {
    const start = numeric(event.data.startTimeMs) ?? event.timestamp;
    const end = numeric(event.data.endTimeMs) ?? start;
    // A malformed profile must not produce a backwards interval.
    return end >= start ? { start, end } : { start: end, end: start };
  }
  return { start: event.timestamp, end: event.timestamp };
}

/** Signed gap between two intervals; 0 when they overlap. */
export function gapMs(a: Interval, b: Interval): number {
  if (a.end < b.start) return a.end - b.start; // a finished before b began
  if (b.end < a.start) return a.start - b.end; // a began after b ended
  return 0;
}

export function relationOf(gap: number): Relation {
  if (gap < 0) return "preceded";
  if (gap > 0) return "followed";
  return "overlapped";
}

/**
 * Events whose span comes within `windowMs` of the anchor's span, nearest
 * first. The anchor itself is excluded.
 */
export function correlate(
  events: readonly RuntimeEvent[],
  anchor: RuntimeEvent,
  windowMs: number,
): Correlated[] {
  const anchorSpan = intervalOf(anchor);
  const out: Correlated[] = [];
  for (const event of events) {
    if (event.id === anchor.id) continue;
    const delta = gapMs(intervalOf(event), anchorSpan);
    if (Math.abs(delta) > windowMs) continue;
    out.push({ event, relation: relationOf(delta), deltaMs: delta });
  }
  return out.sort((x, y) => Math.abs(x.deltaMs) - Math.abs(y.deltaMs));
}

/** Correlated events that finished before the anchor started, nearest first. */
export function precededBy(
  events: readonly RuntimeEvent[],
  anchor: RuntimeEvent,
  windowMs: number,
): Correlated[] {
  return correlate(events, anchor, windowMs).filter((c) => c.relation !== "followed");
}

export interface TimelineEntry {
  eventId: string;
  timestamp: number;
  deltaMs: number;
  relation: Relation;
  category: string;
  severity: string;
  message: string;
}

/**
 * Chronological view around an anchor, oldest first. This is the "what happened
 * around the failure" answer, computed rather than narrated.
 */
export function timelineAround(
  events: readonly RuntimeEvent[],
  anchor: RuntimeEvent,
  windowMs: number,
  limit = 20,
): TimelineEntry[] {
  const entries = correlate(events, anchor, windowMs)
    .slice(0, Math.max(0, limit - 1))
    .concat({ event: anchor, relation: "anchor", deltaMs: 0 })
    .map(({ event, relation, deltaMs }) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      deltaMs,
      relation,
      category: event.category,
      severity: event.severity,
      message: event.message,
    }));
  return entries.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
