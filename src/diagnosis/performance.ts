import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import { intervalOf } from "./correlation.js";
import { routeAtIn } from "./navigation.js";

export interface RebuildHotspot {
  widget?: string;
  file: string;
  line?: number;
  rebuilds: number;
  frames: number;
  appCode: boolean;
}

/**
 * Performance diagnosis over captured frames.
 *
 * `get_frames` already returns raw timings; this answers the question the
 * timings do not: *why*. It correlates jank against the things that can be
 * observed — the build/raster split, requests in flight, route transitions,
 * heap growth — and reports each as a finding with its own evidence and
 * strength.
 *
 * When widget creation is tracked, it also names the widgets behind a
 * build-heavy profile, down to file and line.
 *
 * What it deliberately does not do is guess. There is no CPU sampling and no GC
 * event stream, so not every suspect can be ruled in or out from here. Every run
 * says so in `limitations` rather than presenting a partial picture as a
 * complete one.
 */

const FRAME_BUDGET_MS = 16.67;
/** Below this many frames, any percentage is noise rather than a signal. */
const MIN_FRAMES = 20;
/** A frame is "during" a request if it lands inside the request's span. */
const ROUTE_SETTLE_MS = 1_000;

export interface PerformanceFinding {
  claim: string;
  /** 0..1, how well the evidence supports this specific claim. */
  strength: number;
  evidence: string[];
  fix: string;
}

export interface FrameStats {
  total: number;
  janky: number;
  jankPercent: number;
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  worstMs: number | null;
  meanBuildMs: number | null;
  meanRasterMs: number | null;
}

export interface PerformanceDiagnosis {
  status: "healthy" | "diagnosed" | "unknown";
  summary: string;
  frames: FrameStats;
  /** Which phase dominates the janky frames, when one clearly does. */
  dominantPhase: "build" | "raster" | "mixed" | null;
  findings: PerformanceFinding[];
  /** Widgets that rebuilt most, resolved to source. Empty when untracked. */
  rebuildHotspots: RebuildHotspot[];
  recommendedFixes: string[];
  confidence: number;
  limitations: string[];
}

export function diagnosePerformance(store: RuntimeStore): PerformanceDiagnosis {
  const all = store.query({ limit: 5_000 });
  const frames = all.filter((e) => e.category === "frame");
  const janky = frames.filter((e) => e.data.janky === true);
  const stats = frameStats(frames, janky);
  const hotspots = rebuildHotspots(all);
  const limitations = describeLimitations(store, frames.length, hotspots.length > 0);

  if (frames.length < MIN_FRAMES) {
    return {
      status: "unknown",
      summary:
        frames.length === 0
          ? "No frame timings captured. Interact with the app while connected, then try again."
          : `Only ${frames.length} frames captured; too few to tell a pattern from noise (need ${MIN_FRAMES}).`,
      frames: stats,
      dominantPhase: null,
      findings: [],
      rebuildHotspots: hotspots,
      recommendedFixes: ["Exercise the janky interaction while connected, then run this again."],
      confidence: 0.3,
      limitations,
    };
  }

  if (stats.janky === 0 || stats.jankPercent < 5) {
    return {
      status: "healthy",
      summary: `${stats.janky}/${stats.total} frames (${stats.jankPercent}%) exceeded the ${FRAME_BUDGET_MS}ms budget — within normal range.`,
      frames: stats,
      dominantPhase: null,
      findings: [],
      rebuildHotspots: hotspots,
      recommendedFixes: [],
      confidence: sampleConfidence(frames.length),
      limitations,
    };
  }

  const findings = [
    rebuildFinding(hotspots, all, stats),
    phaseFinding(janky, stats),
    networkFinding(all, janky),
    routeFinding(all, janky),
    memoryFinding(all, stats),
  ].filter((f): f is PerformanceFinding => f !== null);

  const dominant = dominantPhase(stats);
  const confidence = Math.min(
    sampleConfidence(frames.length) + (findings.length > 1 ? 0.1 : 0),
    0.9,
  );

  return {
    status: "diagnosed",
    summary:
      `${stats.janky}/${stats.total} frames (${stats.jankPercent}%) exceeded the ${FRAME_BUDGET_MS}ms budget. ` +
      `Worst ${stats.worstMs}ms, p99 ${stats.p99Ms}ms.` +
      (dominant && dominant !== "mixed" ? ` Dominated by the ${dominant} phase.` : ""),
    frames: stats,
    dominantPhase: dominant,
    findings: findings.sort((a, b) => b.strength - a.strength),
    rebuildHotspots: hotspots,
    recommendedFixes: findings.sort((a, b) => b.strength - a.strength).map((f) => f.fix),
    confidence,
    limitations,
  };
}

// ── Findings ────────────────────────────────────────────────────────────────

/**
 * Aggregate per-frame rebuild counts into hotspots, app code first.
 *
 * Each stored rebuild event keeps only its top locations, so these totals cover
 * the hotspots of each frame rather than every rebuild that occurred. That is
 * the right trade: the long tail of one-off rebuilds is noise, and keeping it
 * would cost a thousand entries per frame.
 */
function rebuildHotspots(all: RuntimeEvent[]): RebuildHotspot[] {
  const byLocation = new Map<string, RebuildHotspot>();
  for (const event of all) {
    if (event.category !== "rebuild") continue;
    const top = Array.isArray(event.data.top) ? (event.data.top as any[]) : [];
    for (const entry of top) {
      const key = `${entry.widget ?? "?"}|${entry.file}|${entry.line ?? "?"}`;
      const existing = byLocation.get(key);
      if (existing) {
        existing.rebuilds += Number(entry.count) || 0;
        existing.frames += 1;
      } else {
        byLocation.set(key, {
          widget: entry.widget,
          file: entry.file,
          line: entry.line,
          rebuilds: Number(entry.count) || 0,
          frames: 1,
          appCode: entry.appCode === true,
        });
      }
    }
  }
  return [...byLocation.values()]
    // Rank by actual volume. Sorting app code first looks helpful and is not:
    // it buries a package location with 40 rebuilds beneath fifty app entries
    // that rebuilt once, so "busiest" stops meaning busiest.
    .sort((a, b) => b.rebuilds - a.rebuilds || Number(b.appCode) - Number(a.appCode))
    .slice(0, 12);
}

function describe(h: RebuildHotspot): string {
  return [h.widget, h.line ? `${h.file}:${h.line}` : h.file].filter(Boolean).join(" at ");
}

/** Name the widget behind a build-heavy profile, with its source location. */
function rebuildFinding(
  hotspots: RebuildHotspot[],
  all: RuntimeEvent[],
  stats: FrameStats,
): PerformanceFinding | null {
  if (hotspots.length === 0) return null;
  // An unresolved location is still counted, but naming it as the busiest tells
  // the developer nothing they can act on.
  const headline = hotspots.find((h) => h.file !== "unknown") ?? hotspots[0];
  // The busiest location is often framework code rebuilt by something you own,
  // so name the nearest thing the developer can actually edit as well.
  const mine = hotspots.find((h) => h.appCode);
  const rebuildEvents = all.filter((e) => e.category === "rebuild");
  const totalRebuilds = rebuildEvents.reduce(
    (sum, e) => sum + (Number(e.data.totalRebuilds) || 0),
    0,
  );
  const buildBound = dominantPhase(stats) === "build";

  const where = describe(headline);
  const inYourCode = mine && mine !== headline ? describe(mine) : null;

  return {
    claim:
      `${totalRebuilds} widget rebuild(s) across ${rebuildEvents.length} frame(s). ` +
      `Busiest: ${where} — ${headline.rebuilds} rebuild(s) over ${headline.frames} frame(s).` +
      (inYourCode && mine
        ? ` Busiest in your own code: ${inYourCode} — ${mine.rebuilds} rebuild(s).`
        : headline.appCode
          ? ""
          : " No hotspot resolved to your own code."),
    // Only a strong claim about the CAUSE of jank when the profile is
    // build-bound; otherwise it is context, since raster jank is unrelated to
    // how often widgets rebuilt.
    strength: buildBound ? 0.85 : 0.6,
    evidence: rebuildEvents.slice(0, 5).map((e) => e.eventId),
    fix: buildBound
      ? `Narrow the rebuild scope around ${inYourCode ?? where}. Split the widget so only the part that depends on changing state rebuilds, add const constructors, and move computation out of build().`
      : `Rebuild counts are recorded for context — this profile is not build-bound, so ${where} is unlikely to be the cause of the jank.`,
  };
}

function phaseFinding(janky: RuntimeEvent[], stats: FrameStats): PerformanceFinding | null {
  const phase = dominantPhase(stats);
  if (!phase || phase === "mixed" || stats.meanBuildMs === null || stats.meanRasterMs === null) {
    return null;
  }
  const build = phase === "build";
  return {
    claim: build
      ? `Janky frames spend most of their time building: mean build ${stats.meanBuildMs}ms vs raster ${stats.meanRasterMs}ms.`
      : `Janky frames spend most of their time rasterizing: mean raster ${stats.meanRasterMs}ms vs build ${stats.meanBuildMs}ms.`,
    strength: 0.8,
    evidence: janky.slice(0, 5).map((e) => e.eventId),
    fix: build
      ? "Build-phase heavy: move expensive work out of build(), use const widgets, cache computed values, and narrow the rebuild scope with smaller widgets or selectors."
      : "Raster-phase heavy: reduce overdraw, clips and shadows, avoid saveLayer, and simplify custom painting. Check for large unscaled images.",
  };
}

/**
 * Jank while a request is in flight. On mobile the response is decoded on the
 * main isolate unless the app moved it off, so this is a common and very
 * fixable cause.
 */
function networkFinding(all: RuntimeEvent[], janky: RuntimeEvent[]): PerformanceFinding | null {
  const requests = all.filter((e) => e.category === "network");
  if (requests.length === 0) return null;

  const spans = requests.map((r) => ({ event: r, span: intervalOf(r) }));
  const during = janky.filter((frame) =>
    spans.some(({ span }) => frame.timestamp >= span.start && frame.timestamp <= span.end),
  );
  const ratio = during.length / janky.length;
  if (during.length < 3 || ratio < 0.4) return null;

  const overlapping = spans
    .filter(({ span }) => during.some((f) => f.timestamp >= span.start && f.timestamp <= span.end))
    .slice(0, 3)
    .map(({ event }) => event.eventId);

  return {
    claim: `${during.length} of ${janky.length} janky frames (${Math.round(ratio * 100)}%) occurred while an HTTP request was in flight.`,
    strength: ratio >= 0.7 ? 0.8 : 0.7,
    evidence: [...during.slice(0, 5).map((e) => e.eventId), ...overlapping],
    fix: "Jank tracks in-flight requests. Decode large responses off the main isolate with compute()/Isolate.run, and avoid rebuilding wide subtrees on every chunk of a streamed response.",
  };
}

/** Jank clustered right after a route change is the new screen's first build. */
function routeFinding(all: RuntimeEvent[], janky: RuntimeEvent[]): PerformanceFinding | null {
  const navigations = all.filter((e) => e.category === "navigation" && e.data.popped !== true);
  if (navigations.length === 0) return null;

  const nearTransition = janky.filter((frame) =>
    navigations.some(
      (nav) => frame.timestamp >= nav.timestamp && frame.timestamp - nav.timestamp <= ROUTE_SETTLE_MS,
    ),
  );
  const ratio = nearTransition.length / janky.length;
  if (nearTransition.length < 3 || ratio < 0.4) return null;

  const route = routeAtIn(all, nearTransition[0].timestamp);
  return {
    claim:
      `${nearTransition.length} of ${janky.length} janky frames (${Math.round(ratio * 100)}%) landed within ` +
      `${ROUTE_SETTLE_MS}ms of a route change${route ? ` (most recently ${route})` : ""}.`,
    strength: 0.75,
    evidence: [
      ...nearTransition.slice(0, 5).map((e) => e.eventId),
      ...navigations.slice(0, 2).map((e) => e.eventId),
    ],
    fix: "The cost is in building a new screen, not in steady-state rendering. Defer heavy work past the first frame with addPostFrameCallback, precache images, and keep the initial subtree small.",
  };
}

function memoryFinding(all: RuntimeEvent[], stats: FrameStats): PerformanceFinding | null {
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
    claim: `The heap grew ${Math.round(growth * 100)}% (${first}MB → ${last}MB) over the same period as ${stats.janky} janky frames.`,
    // Deliberately the weakest finding: this is co-occurrence, and GC events
    // are not observable from here, so the link cannot be established.
    strength: 0.55,
    evidence: samples.slice(-3).map((e) => e.eventId),
    fix: "Allocation pressure can cause GC pauses that show up as jank, but GC events are not visible here — confirm in the DevTools memory view before acting on this.",
  };
}

// ── Statistics ──────────────────────────────────────────────────────────────

function frameStats(frames: RuntimeEvent[], janky: RuntimeEvent[]): FrameStats {
  const elapsed = frames.map((e) => Number(e.data.elapsedMs) || 0).sort((a, b) => a - b);
  return {
    total: frames.length,
    janky: janky.length,
    jankPercent: frames.length === 0 ? 0 : Math.round((janky.length / frames.length) * 100),
    p50Ms: percentile(elapsed, 0.5),
    p90Ms: percentile(elapsed, 0.9),
    p99Ms: percentile(elapsed, 0.99),
    worstMs: elapsed.length === 0 ? null : round2(elapsed[elapsed.length - 1]),
    meanBuildMs: mean(janky.map((e) => Number(e.data.buildMs) || 0)),
    meanRasterMs: mean(janky.map((e) => Number(e.data.rasterMs) || 0)),
  };
}

function dominantPhase(stats: FrameStats): "build" | "raster" | "mixed" | null {
  const { meanBuildMs: build, meanRasterMs: raster } = stats;
  if (build === null || raster === null || build + raster === 0) return null;
  if (build >= raster * 1.5) return "build";
  if (raster >= build * 1.5) return "raster";
  return "mixed";
}

/** Confidence from sample size alone: more frames, less chance the pattern is noise. */
function sampleConfidence(frameCount: number): number {
  if (frameCount >= 300) return 0.8;
  if (frameCount >= 100) return 0.75;
  return 0.7;
}

function describeLimitations(
  store: RuntimeStore,
  frameCount: number,
  haveRebuilds: boolean,
): string[] {
  const out = [
    "No CPU sampling. A slow build can be attributed to a widget, but not to a specific function — use the DevTools CPU profiler for that.",
    "GC events are not observable: the VM timeline is fetched on demand and not stored, so garbage-collection pauses cannot be ruled in or out.",
    "Frames are only captured while connected, and older ones roll out of the retention window.",
  ];
  if (haveRebuilds) {
    out.push(
      "Rebuild totals cover the busiest locations in each frame, not every rebuild — the long tail is counted but not itemised.",
    );
    out.push(
      "App-versus-package attribution is a path heuristic: getPubRootDirectories is empty until a DevTools client sets it, so there is no authoritative project root.",
    );
  } else {
    out.push(
      "No widget rebuild data in this session. Rebuild tracking needs a debug build with widget creation tracking; without it a build-heavy frame cannot be traced to a widget.",
    );
  }
  if (store.retention().evicted.frame > 0) {
    out.unshift(
      `${store.retention().evicted.frame} frame(s) have been dropped by retention, so these percentages describe the recent window, not the whole session.`,
    );
  }
  if (frameCount > 0 && frameCount < 100) {
    out.push(`Only ${frameCount} frames in the sample — treat the percentiles as indicative.`);
  }
  return out;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return round2(sorted[index]);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((a, b) => a + b, 0) / values.length);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
