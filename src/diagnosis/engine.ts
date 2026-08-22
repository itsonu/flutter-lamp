import { CATEGORIES, type RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import { correlate, timelineAround, type Correlated, type TimelineEntry } from "./correlation.js";
import { routeAtIn, routeEventAt } from "./navigation.js";

export interface EvidenceItem {
  /** Stable id of the captured event this rests on, e.g. `exc_00142`. */
  eventId: string;
  timestamp: number;
  source: string;
  category: string;
  severity: string;
  message: string;
}

/**
 * What the confidence number is made of.
 *
 * Reported separately because collapsing these into one figure hides which one
 * is weak. A strong hypothesis over thin data and a weak hypothesis over
 * complete data can land on the same number and mean entirely different things.
 */
export interface ConfidenceBreakdown {
  /** How much corroboration the chosen root cause has, 0..1. */
  evidenceStrength: number;
  /** How much of the possible evidence was actually captured, 0..1. */
  dataCompleteness: number;
  /** Strength of the best competing explanation, 0..1. Higher means less certain. */
  alternativeStrength: number;
  /** Plain statement of what these numbers are, and are not. */
  basis: string;
}

export interface AlternativeCause {
  rootCause: string;
  strength: number;
  evidence: string[];
}

export interface Diagnosis {
  /** "diagnosed" when confidence clears the threshold, otherwise "unknown". */
  status: "diagnosed" | "unknown";
  summary: string;
  rootCause: string;
  evidence: EvidenceItem[];
  /** Chronological events around the root cause, oldest first. */
  timeline: TimelineEntry[];
  /** Explanations that also fit the evidence, strongest first. */
  alternativeCauses: AlternativeCause[];
  /** What this diagnosis could not see. */
  limitations: string[];
  /** 0..1. Rendered as a percentage; below 0.7 the status is "unknown". */
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  recommendedFixes: string[];
}

/** Events within this window (ms) of the anchor are considered correlated. */
const CORRELATION_WINDOW_MS = 3_000;

/**
 * Below this, the diagnosis reports "Unknown" instead of a cause.
 *
 * This is a conservative product policy, NOT a calibrated probability. Nothing
 * here has been measured against ground truth; the number expresses how much
 * corroborating evidence was found, on a scale chosen so that a bare hypothesis
 * with no support sits under the bar. Treat it as "how much should you trust
 * this without checking", not as "how often this is right".
 */
const CONFIDENCE_THRESHOLD = 0.7;

const BASIS =
  "Conservative heuristic scored from corroborating evidence, not a calibrated probability. " +
  `Below ${CONFIDENCE_THRESHOLD} the status is "unknown" rather than a guess.`;

/**
 * A candidate explanation. Every hypothesis anchors to a real captured event —
 * there is no path here that invents a cause the evidence does not contain.
 */
interface Hypothesis {
  /** Decides ties: an actionable exception beats a performance pattern. */
  priority: number;
  anchor: RuntimeEvent;
  summary: string;
  rootCause: string;
  strength: number;
  evidence: RuntimeEvent[];
  fixes: string[];
}

/**
 * Evidence-first diagnosis. The root cause is always a concrete stored event,
 * and confidence rises only with corroborating correlated evidence. When
 * nothing corroborates, confidence stays low and the status says so, satisfying
 * docs/Rules.md ("If confidence <70% say Unknown", "Never hallucinate").
 */
export function diagnose(store: RuntimeStore): Diagnosis {
  const all = store.query({ limit: 2_000 }); // most-recent-first, current session
  const limitations = describeLimitations(store, all);

  if (all.length === 0) {
    return unknown(
      "No runtime events captured yet.",
      ["Interact with the running app to generate runtime activity, then diagnose again."],
      limitations,
      0,
    );
  }

  const completeness = dataCompleteness(store, all);
  const hypotheses = [
    exceptionHypothesis(all),
    jankHypothesis(all),
    networkHypothesis(all),
    memoryHypothesis(all),
  ]
    .filter((h): h is Hypothesis => h !== null)
    .sort((a, b) => b.priority - a.priority || b.strength - a.strength);

  if (hypotheses.length === 0) {
    return unknown(
      "Runtime activity captured but no exceptions, jank pattern, or network errors were found.",
      ["The app appears healthy. Reproduce the issue while connected, then diagnose again."],
      limitations,
      completeness,
    );
  }

  const [primary, ...rest] = hypotheses;
  const alternativeStrength = rest.length > 0 ? Math.max(...rest.map((h) => h.strength)) : 0;

  return {
    status: primary.strength >= CONFIDENCE_THRESHOLD ? "diagnosed" : "unknown",
    summary: primary.summary,
    rootCause: primary.rootCause,
    evidence: primary.evidence.slice(0, 10).map(toEvidence),
    timeline: timelineAround(all, primary.anchor, CORRELATION_WINDOW_MS),
    alternativeCauses: rest.map((h) => ({
      rootCause: h.rootCause,
      strength: round2(h.strength),
      evidence: h.evidence.slice(0, 5).map((e) => e.eventId),
    })),
    limitations,
    confidence: round2(primary.strength),
    confidenceBreakdown: {
      evidenceStrength: round2(primary.strength),
      dataCompleteness: round2(completeness),
      alternativeStrength: round2(alternativeStrength),
      basis: BASIS,
    },
    recommendedFixes: primary.fixes,
  };
}

// ── Hypotheses ──────────────────────────────────────────────────────────────

/** Exceptions dominate: most actionable, and anchored to the newest one. */
function exceptionHypothesis(all: RuntimeEvent[]): Hypothesis | null {
  const exceptions = all.filter((e) => e.category === "exception");
  if (exceptions.length === 0) return null;

  const anchor = exceptions[0];
  const correlated = correlate(all, anchor, CORRELATION_WINDOW_MS);
  const nearNet = pick(correlated, (e) => e.category === "network" && e.severity !== "info");
  const nearLogs = pick(
    correlated,
    (e) => e.category === "log" && (e.severity === "error" || e.severity === "warning"),
  );

  let strength = 0.7;
  if (anchor.data.stackTrace) strength += 0.1;
  if (nearNet.length > 0) strength += 0.1;
  if (nearLogs.length > 0) strength += 0.05;

  const fixes: string[] = [];
  if (nearNet.length > 0) {
    fixes.push(
      `A network call (${nearNet[0].message}) occurred just before the exception — verify the response shape/null-handling for that request.`,
    );
  }
  if (anchor.data.library) {
    fixes.push(`Inspect the widget/library reported by the framework error: ${String(anchor.data.library)}.`);
  }
  fixes.push("Add a null/bounds guard or try/catch at the failing call site shown in the stack trace.");

  // Attribute the failure to the screen the user was actually looking at.
  // "the checkout screen crashes" is how the bug will be reported.
  const route = routeAtIn(all, anchor.timestamp);
  const routeEvent = routeEventAt(all, anchor.timestamp);
  const onRoute = route ? ` on route ${route}` : "";

  return {
    priority: 3,
    anchor,
    summary: `${exceptions.length} exception(s) captured; most recent${onRoute}: "${anchor.message}".`,
    rootCause: anchor.message,
    strength: Math.min(strength, 0.95),
    evidence: [anchor, ...nearNet, ...nearLogs, ...(routeEvent ? [routeEvent] : [])],
    fixes,
  };
}

function jankHypothesis(all: RuntimeEvent[]): Hypothesis | null {
  const frames = all.filter((e) => e.category === "frame");
  const janky = frames.filter((e) => e.data.janky === true);
  if (frames.length === 0 || janky.length < 3 || janky.length / frames.length < 0.2) return null;

  const worst = [...janky].sort(
    (a, b) => (Number(b.data.elapsedMs) || 0) - (Number(a.data.elapsedMs) || 0),
  )[0];
  const pct = Math.round((janky.length / frames.length) * 100);

  return {
    priority: 2,
    anchor: worst,
    summary: `Frame jank detected: ${janky.length}/${frames.length} frames (${pct}%) exceeded the 16.7ms budget.`,
    rootCause: `Dropped frames — worst was ${worst.data.elapsedMs}ms (build ${worst.data.buildMs}ms, raster ${worst.data.rasterMs}ms).`,
    strength: Math.min(0.7 + (janky.length >= 10 ? 0.1 : 0), 0.85),
    evidence: janky.slice(0, 8),
    fixes: [
      Number(worst.data.buildMs) > Number(worst.data.rasterMs)
        ? "Build-phase heavy: move expensive work out of build(), use const widgets, and narrow rebuild scope."
        : "Raster-phase heavy: reduce overdraw/clips/shadows and expensive custom painting.",
      "Profile the janky frames in the DevTools Timeline to pinpoint the costly widget.",
    ],
  };
}

function networkHypothesis(all: RuntimeEvent[]): Hypothesis | null {
  const failures = all.filter(
    (e) => e.category === "network" && (e.severity === "error" || e.severity === "warning"),
  );
  if (failures.length === 0) return null;

  const anchor = failures[0];
  return {
    priority: 1,
    anchor,
    summary: `${failures.length} failing/slow network request(s) detected.`,
    rootCause: anchor.message,
    strength: 0.7,
    evidence: failures.slice(0, 8),
    fixes: [
      `Check the endpoint ${String(anchor.data.uri ?? "")} and its error handling.`,
      "Handle non-2xx responses explicitly and surface a user-facing error state.",
    ],
  };
}

/**
 * Sustained heap growth across the session's memory snapshots.
 *
 * Deliberately weak and lowest priority: growth is not a leak, and Dart's heap
 * grows normally before a GC. It is offered as a competing explanation rather
 * than asserted as a cause.
 */
function memoryHypothesis(all: RuntimeEvent[]): Hypothesis | null {
  const samples = all
    .filter((e) => e.source === "getMemoryUsage" && typeof e.data.heapUsageMB === "number")
    .sort((a, b) => a.timestamp - b.timestamp);
  if (samples.length < 3) return null;

  const first = Number(samples[0].data.heapUsageMB);
  const last = Number(samples[samples.length - 1].data.heapUsageMB);
  if (first <= 0) return null;

  const growth = (last - first) / first;
  if (growth < 0.5) return null;

  return {
    priority: 0,
    anchor: samples[samples.length - 1],
    summary: `Dart heap grew from ${first}MB to ${last}MB (${Math.round(growth * 100)}%) across ${samples.length} samples.`,
    rootCause: `Sustained heap growth: ${first}MB → ${last}MB over the session.`,
    strength: growth >= 1 ? 0.75 : 0.7,
    evidence: samples.slice(-5).reverse(),
    fixes: [
      "Growth is not proof of a leak — Dart's heap grows between collections. Compare against heap capacity and re-sample after activity settles.",
      "If growth does not plateau, look for retained listeners, controllers, or images that are never disposed.",
    ],
  };
}

// ── Confidence inputs ───────────────────────────────────────────────────────

/**
 * How much of the evidence that *could* exist actually does. Low completeness
 * does not lower confidence on its own — it says the diagnosis was made looking
 * at part of the picture, which is a different warning.
 */
function dataCompleteness(store: RuntimeStore, all: RuntimeEvent[]): number {
  const present = new Set(all.map((e) => e.category)).size;
  const retention = store.retention();
  const anyEvicted = Object.values(retention.evicted).some((n) => n > 0);
  return Math.max(0, present / CATEGORIES.length - (anyEvicted ? 0.1 : 0));
}

function describeLimitations(store: RuntimeStore, all: RuntimeEvent[]): string[] {
  const out: string[] = [];
  const retention = store.retention();
  const evicted = Object.entries(retention.evicted).filter(([, n]) => n > 0);
  if (evicted.length > 0) {
    out.push(
      `Retention limit reached: ${evicted
        .map(([category, n]) => `${n} ${category}`)
        .join(", ")} event(s) were dropped, so older evidence is gone.`,
    );
  }
  if (!all.some((e) => e.category === "network")) {
    out.push(
      "No network evidence in this session. HTTP capture is pull-on-demand and Dart-side only — platform-code and WebView traffic is never visible.",
    );
  }
  if (!all.some((e) => e.source === "getMemoryUsage")) {
    out.push("No memory samples captured. Call get_memory, or open the dashboard, to include memory in future diagnoses.");
  }
  out.push(
    "VM timeline events are fetched on demand and not stored, so they take no part in correlation.",
  );
  out.push(
    "Only Dart-side runtime state is observed. A cause in platform (Kotlin/Swift) code or in a WebView cannot appear here.",
  );
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pick(correlated: Correlated[], match: (e: RuntimeEvent) => boolean): RuntimeEvent[] {
  return correlated.filter((c) => match(c.event)).map((c) => c.event);
}

function toEvidence(e: RuntimeEvent): EvidenceItem {
  return {
    eventId: e.eventId,
    timestamp: e.timestamp,
    source: e.source,
    category: e.category,
    severity: e.severity,
    message: e.message,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function unknown(
  reason: string,
  fixes: string[],
  limitations: string[],
  completeness: number,
): Diagnosis {
  return {
    status: "unknown",
    summary: `Unknown — insufficient runtime evidence. ${reason}`,
    rootCause: "Unknown (confidence below 70%).",
    evidence: [],
    timeline: [],
    alternativeCauses: [],
    limitations,
    confidence: 0.3,
    confidenceBreakdown: {
      evidenceStrength: 0.3,
      dataCompleteness: round2(completeness),
      alternativeStrength: 0,
      basis: BASIS,
    },
    recommendedFixes: fixes,
  };
}
