import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import { intervalOf } from "./correlation.js";

/**
 * Route history, and what went wrong on each route.
 *
 * "The checkout screen crashes" is how a bug gets reported; "an exception at
 * 14:32:01" is what the runtime records. This joins the two, so evidence can be
 * attributed to the screen the user was actually looking at.
 */

export interface RouteVisit {
  /** The navigation event that entered this route. */
  eventId: string;
  name: string | null;
  description?: string;
  enteredMs: number;
  /** When the next route was entered, or null while this one is still current. */
  leftMs: number | null;
  durationMs: number | null;
  current: boolean;
  exceptions: string[];
  networkFailures: string[];
  jankyFrames: number;
}

export interface NavigationReport {
  current: RouteVisit | null;
  visits: RouteVisit[];
  notes: string[];
}

/**
 * Newest visit first. A visit owns every event between entering it and entering
 * the next one; a network request is attributed by overlap, so a call that spans
 * a route change is counted against both screens it touched rather than being
 * silently assigned to one.
 */
export function routeHistory(store: RuntimeStore, limit = 20): NavigationReport {
  const all = store.query({ limit: 5_000 });
  const navigations = all
    .filter((e) => e.category === "navigation" && e.data.popped !== true)
    .sort((a, b) => a.timestamp - b.timestamp);

  const notes: string[] = [];
  if (navigations.length === 0) {
    notes.push(
      "No route changes captured. Navigator posts Flutter.Navigation on push/pop, so either nothing has navigated since connecting, or the app is a release build.",
    );
    return { current: null, visits: [], notes };
  }

  const exceptions = all.filter((e) => e.category === "exception");
  const failures = all.filter(
    (e) => e.category === "network" && (e.severity === "error" || e.severity === "warning"),
  );
  const janky = all.filter((e) => e.category === "frame" && e.data.janky === true);

  const visits: RouteVisit[] = navigations.map((nav, i) => {
    const next = navigations[i + 1];
    const enteredMs = nav.timestamp;
    const leftMs = next ? next.timestamp : null;
    const isCurrent = !next;

    return {
      eventId: nav.eventId,
      name: (nav.data.name as string | null) ?? null,
      description: nav.data.description as string | undefined,
      enteredMs,
      leftMs,
      durationMs: leftMs === null ? null : leftMs - enteredMs,
      current: isCurrent,
      exceptions: within(exceptions, enteredMs, leftMs).map((e) => e.eventId),
      networkFailures: overlapping(failures, enteredMs, leftMs).map((e) => e.eventId),
      jankyFrames: within(janky, enteredMs, leftMs).length,
    };
  });

  const ordered = visits.reverse().slice(0, limit);
  const current = visits.find((v) => v.current) ?? null;

  if (current && current.exceptions.length > 0) {
    notes.push(`The current route has ${current.exceptions.length} exception(s) attributed to it.`);
  }
  return { current, visits: ordered, notes };
}

/** The name of the route active at a given moment, if known. */
export function routeAt(store: RuntimeStore, timestamp: number): string | null {
  return routeAtIn(store.query({ category: "navigation", limit: 5_000 }), timestamp);
}

/** As `routeAt`, over an event list already in hand. Expects newest-first. */
export function routeAtIn(events: readonly RuntimeEvent[], timestamp: number): string | null {
  const active = events.find(
    (e) => e.category === "navigation" && e.data.popped !== true && e.timestamp <= timestamp,
  );
  if (!active) return null;
  return (active.data.name as string | null) ?? (active.data.description as string | undefined) ?? null;
}

/** The navigation event that put the app on the route active at `timestamp`. */
export function routeEventAt(
  events: readonly RuntimeEvent[],
  timestamp: number,
): RuntimeEvent | undefined {
  return events.find(
    (e) => e.category === "navigation" && e.data.popped !== true && e.timestamp <= timestamp,
  );
}

function within(events: RuntimeEvent[], from: number, to: number | null): RuntimeEvent[] {
  return events.filter((e) => e.timestamp >= from && (to === null || e.timestamp < to));
}

/** Attribute by interval overlap, so a request spanning a route change counts for both. */
function overlapping(events: RuntimeEvent[], from: number, to: number | null): RuntimeEvent[] {
  return events.filter((e) => {
    const span = intervalOf(e);
    return span.end >= from && (to === null || span.start < to);
  });
}
