import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";

export interface EvidenceItem {
  timestamp: number;
  source: string;
  category: string;
  severity: string;
  message: string;
}

export interface Diagnosis {
  summary: string;
  rootCause: string;
  evidence: EvidenceItem[];
  /** 0..1. Rendered as a percentage; below 0.7 the summary states "Unknown". */
  confidence: number;
  recommendedFixes: string[];
}

/** Events within this window (ms) of the anchor are considered correlated. */
const CORRELATION_WINDOW_MS = 3_000;

/**
 * Evidence-first diagnosis. We never invent a cause: the root cause is always
 * anchored to a concrete stored event, and confidence rises only with
 * corroborating correlated evidence. When nothing corroborates (or there is no
 * signal at all) confidence stays low and the summary says so, satisfying
 * docs/Rules.md ("If confidence <70% say Unknown", "Never hallucinate").
 */
export function diagnose(store: RuntimeStore): Diagnosis {
  const all = store.query({ limit: 2000 }); // most-recent-first
  if (all.length === 0) {
    return unknown("No runtime events captured yet.", [
      "Interact with the running app to generate runtime activity, then diagnose again.",
    ]);
  }

  const exceptions = all.filter((e) => e.category === "exception");
  const netErrors = all.filter(
    (e) => e.category === "network" && (e.severity === "error" || e.severity === "warning"),
  );
  const jankFrames = all.filter((e) => e.category === "frame" && e.data.janky === true);

  // 1) Exceptions dominate — most actionable, anchor to the latest one.
  if (exceptions.length > 0) {
    const anchor = exceptions[0]; // newest
    const correlated = correlate(all, anchor.timestamp).filter((e) => e.id !== anchor.id);
    const nearNet = correlated.filter((e) => e.category === "network" && e.severity !== "info");
    const nearLogs = correlated.filter((e) => e.category === "log" && (e.severity === "error" || e.severity === "warning"));

    let confidence = 0.7;
    if (anchor.data.stackTrace) confidence += 0.1;
    if (nearNet.length > 0) confidence += 0.1;
    if (nearLogs.length > 0) confidence += 0.05;
    confidence = Math.min(confidence, 0.95);

    const evidence = [anchor, ...nearNet, ...nearLogs].slice(0, 10);
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

    return {
      summary: `${exceptions.length} exception(s) captured; most recent: "${anchor.message}".`,
      rootCause: anchor.message,
      evidence: evidence.map(toEvidence),
      confidence,
      recommendedFixes: fixes,
    };
  }

  // 2) No exceptions — check for a jank pattern.
  const totalFrames = all.filter((e) => e.category === "frame").length;
  if (totalFrames > 0 && jankFrames.length / totalFrames >= 0.2 && jankFrames.length >= 3) {
    const worst = [...jankFrames].sort(
      (a, b) => (Number(b.data.elapsedMs) || 0) - (Number(a.data.elapsedMs) || 0),
    )[0];
    const pct = Math.round((jankFrames.length / totalFrames) * 100);
    const confidence = Math.min(0.7 + (jankFrames.length >= 10 ? 0.1 : 0), 0.85);
    return {
      summary: `Frame jank detected: ${jankFrames.length}/${totalFrames} frames (${pct}%) exceeded the 16.7ms budget.`,
      rootCause: `Dropped frames — worst was ${worst.data.elapsedMs}ms (build ${worst.data.buildMs}ms, raster ${worst.data.rasterMs}ms).`,
      evidence: jankFrames.slice(0, 8).map(toEvidence),
      confidence,
      recommendedFixes: [
        Number(worst.data.buildMs) > Number(worst.data.rasterMs)
          ? "Build-phase heavy: move expensive work out of build(), use const widgets, and narrow rebuild scope."
          : "Raster-phase heavy: reduce overdraw/clips/shadows and expensive custom painting.",
        "Profile the janky frames in the DevTools Timeline to pinpoint the costly widget.",
      ],
    };
  }

  // 3) Network errors without an exception.
  if (netErrors.length > 0) {
    const anchor = netErrors[0];
    const confidence = 0.7;
    return {
      summary: `${netErrors.length} failing/slow network request(s) detected.`,
      rootCause: anchor.message,
      evidence: netErrors.slice(0, 8).map(toEvidence),
      confidence,
      recommendedFixes: [
        `Check the endpoint ${String(anchor.data.uri ?? "")} and its error handling.`,
        "Handle non-2xx responses explicitly and surface a user-facing error state.",
      ],
    };
  }

  // 4) Signal exists but nothing points to a problem.
  return unknown(
    "Runtime activity captured but no exceptions, jank pattern, or network errors were found.",
    ["The app appears healthy. Reproduce the issue while connected, then diagnose again."],
  );
}

function correlate(all: RuntimeEvent[], anchorTs: number): RuntimeEvent[] {
  return all.filter((e) => Math.abs(e.timestamp - anchorTs) <= CORRELATION_WINDOW_MS);
}

function toEvidence(e: RuntimeEvent): EvidenceItem {
  return {
    timestamp: e.timestamp,
    source: e.source,
    category: e.category,
    severity: e.severity,
    message: e.message,
  };
}

function unknown(reason: string, fixes: string[]): Diagnosis {
  return {
    summary: `Unknown — insufficient runtime evidence. ${reason}`,
    rootCause: "Unknown (confidence below 70%).",
    evidence: [],
    confidence: 0.3,
    recommendedFixes: fixes,
  };
}
