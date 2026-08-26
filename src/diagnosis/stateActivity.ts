import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import { round2 } from "./stats.js";

/**
 * How much state-management work the app is doing, and whether it lines up with
 * the frames that were expensive to build.
 *
 * This is the honest half of "Riverpod integration". Provider *values* are not
 * readable from the VM Service (see `src/collectors/stateCollector.ts`), so
 * this never claims which provider did anything. What it can do is count
 * activity, bucket it over time, and report where it coincides with
 * build-heavy frames — which answers "is this rebuild storm being driven by
 * state churn?" without naming a provider it cannot see.
 *
 * Co-occurrence is reported as co-occurrence. Provider churn and expensive
 * builds landing in the same second is consistent with the churn causing the
 * builds, and equally consistent with both being caused by the same user
 * action. Nothing here can separate those, so nothing here pretends to.
 */

/** A frame whose build phase overran this is "build-heavy". */
const BUILD_HEAVY_MS = 16.67;
/** Activity and frames within this of each other are treated as co-occurring. */
const COOCCURRENCE_WINDOW_MS = 1_000;

export interface StateActivityBucket {
  startMs: number;
  events: number;
}

export interface StateActivityReport {
  /** Frameworks that actually posted, e.g. ["riverpod"]. */
  frameworks: string[];
  totalEvents: number;
  /** Observed span of state events, epoch ms. Null when there are none. */
  firstEventMs: number | null;
  lastEventMs: number | null;
  eventsPerSecond: number | null;
  /** Per-second buckets over the observed span, for spotting bursts. */
  busiestBuckets: StateActivityBucket[];
  /**
   * Build-heavy frames that had state activity within a second of them, out of
   * all build-heavy frames. Co-occurrence, not causation.
   */
  coOccurrence: {
    buildHeavyFrames: number;
    withStateActivity: number;
    ratio: number | null;
    /** Event ids of the frames counted, for citation. */
    evidence: string[];
  };
  notes: string[];
  limitations: string[];
}

export function stateActivity(store: RuntimeStore, bucketLimit = 5): StateActivityReport {
  const events = store.query({ category: "state", limit: 5_000 }).reverse(); // oldest first
  const frames = store.query({ category: "frame", limit: 2_000 });

  const limitations = [
    "Provider and notifier names are not observable: Riverpod's VM Service event carries only an app-side buffer offset, and no ext.riverpod.* RPC exists to resolve it.",
    "Stock bloc posts nothing to the VM Service. A flutter_bloc app still appears here, because its notifications run through provider — but these counts are notifications to dependents, not Bloc transitions, and the two differ by however many widgets are watching (measured: 20 transitions, ~1,220 notifications, 60 watchers).",
    "Co-occurrence between state activity and expensive frames is not causation; both can follow the same user action.",
    "When state activity is continuous, essentially every frame falls inside a window and the ratio approaches 1 regardless of any relationship. Compare it against the same ratio for smooth frames before reading anything into it.",
  ];

  if (events.length === 0) {
    return {
      frameworks: [],
      totalEvents: 0,
      firstEventMs: null,
      lastEventMs: null,
      eventsPerSecond: null,
      busiestBuckets: [],
      coOccurrence: { buildHeavyFrames: 0, withStateActivity: 0, ratio: null, evidence: [] },
      notes: [
        "No state-management activity captured. Riverpod posts on the Extension stream, so this is either an app that does not use it or one where nothing has changed since connecting — call runtime_health to see which.",
      ],
      limitations,
    };
  }

  const frameworks = [...new Set(events.map((e) => String(e.data.framework)))].sort();
  const firstEventMs = events[0].timestamp;
  const lastEventMs = events[events.length - 1].timestamp;
  const spanMs = lastEventMs - firstEventMs;

  const buckets = new Map<number, number>();
  for (const event of events) {
    const bucket = Math.floor(event.timestamp / 1_000) * 1_000;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const busiestBuckets = [...buckets]
    .map(([startMs, count]) => ({ startMs, events: count }))
    .sort((a, b) => b.events - a.events || a.startMs - b.startMs)
    .slice(0, bucketLimit);

  const coOccurrence = correlateWithBuildHeavyFrames(events, frames);

  const notes: string[] = [];
  if (coOccurrence.ratio !== null && coOccurrence.buildHeavyFrames >= 5) {
    notes.push(
      coOccurrence.ratio >= 0.5
        ? `${coOccurrence.withStateActivity} of ${coOccurrence.buildHeavyFrames} build-heavy frames had state activity within ${COOCCURRENCE_WINDOW_MS}ms. Call get_rebuilds to see which widgets those frames rebuilt.`
        : `Most build-heavy frames (${coOccurrence.buildHeavyFrames - coOccurrence.withStateActivity} of ${coOccurrence.buildHeavyFrames}) had no state activity near them, so state churn is unlikely to be what makes them expensive.`,
    );
  } else if (frames.length === 0) {
    notes.push("No frames captured, so state activity cannot be compared against build cost.");
  }

  return {
    frameworks,
    totalEvents: events.length,
    firstEventMs,
    lastEventMs,
    eventsPerSecond: spanMs > 0 ? round2(events.length / (spanMs / 1_000)) : null,
    busiestBuckets,
    coOccurrence,
    notes,
    limitations,
  };
}

/**
 * How many build-heavy frames had state activity beside them. Both sequences
 * are time-ordered, so this walks them together rather than scanning the state
 * events once per frame.
 */
function correlateWithBuildHeavyFrames(
  stateEvents: readonly RuntimeEvent[],
  frames: readonly RuntimeEvent[],
): StateActivityReport["coOccurrence"] {
  const heavy = frames
    .filter((f) => (Number(f.data.buildMs) || 0) > BUILD_HEAVY_MS)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (heavy.length === 0) {
    return { buildHeavyFrames: 0, withStateActivity: 0, ratio: null, evidence: [] };
  }

  const evidence: string[] = [];
  let cursor = 0;
  for (const frame of heavy) {
    while (
      cursor < stateEvents.length &&
      stateEvents[cursor].timestamp < frame.timestamp - COOCCURRENCE_WINDOW_MS
    ) {
      cursor++;
    }
    const near = stateEvents[cursor];
    if (near && Math.abs(near.timestamp - frame.timestamp) <= COOCCURRENCE_WINDOW_MS) {
      evidence.push(frame.eventId);
    }
  }

  return {
    buildHeavyFrames: heavy.length,
    withStateActivity: evidence.length,
    ratio: round2(evidence.length / heavy.length),
    // Capped: an agent needs enough ids to spot-check the claim, not all of them.
    evidence: evidence.slice(0, 20),
  };
}
