import type { RuntimeStore } from "../core/runtimeStore.js";

/**
 * Widget rebuild hotspots for direct querying.
 *
 * `diagnose_performance` folds rebuilds into a jank verdict; this answers the
 * narrower question "what is rebuilding, and where does it live" without
 * requiring that anything be wrong.
 */

export interface RebuildEntry {
  widget?: string;
  file: string;
  line?: number;
  /** Total rebuilds attributed to this location across the retained frames. */
  rebuilds: number;
  /** How many frames it appeared in. */
  frames: number;
  /** False for package and SDK code — see the heuristic in rebuildCollector. */
  appCode: boolean;
}

export interface RebuildReport {
  framesWithRebuilds: number;
  totalRebuilds: number;
  /** Mean rebuilds per frame that rebuilt anything. */
  meanPerFrame: number | null;
  hotspots: RebuildEntry[];
  notes: string[];
}

export function rebuildReport(store: RuntimeStore, limit = 15): RebuildReport {
  const events = store.query({ category: "rebuild", limit: 2_000 });
  const notes: string[] = [];

  if (events.length === 0) {
    const untracked = store
      .query({ category: "system", limit: 200 })
      .some((e) => e.message.includes("Widget creation is not tracked"));
    notes.push(
      untracked
        ? "Widget creation is not tracked in this build, so rebuilds cannot be attributed to widgets. Run a debug build."
        : "No rebuilds captured yet. Rebuild events are only emitted for frames that actually rebuild something — interact with the app, then try again.",
    );
    return { framesWithRebuilds: 0, totalRebuilds: 0, meanPerFrame: null, hotspots: [], notes };
  }

  const byLocation = new Map<string, RebuildEntry>();
  let totalRebuilds = 0;
  let truncatedFrames = 0;

  for (const event of events) {
    totalRebuilds += Number(event.data.totalRebuilds) || 0;
    if (event.data.truncated === true) truncatedFrames++;
    for (const entry of (event.data.top as any[]) ?? []) {
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

  const hotspots = [...byLocation.values()]
    // Rank by actual volume, not by ownership — see the note in performance.ts.
    .sort((a, b) => b.rebuilds - a.rebuilds || Number(b.appCode) - Number(a.appCode))
    .slice(0, limit);

  if (truncatedFrames > 0) {
    notes.push(
      `${truncatedFrames} frame(s) rebuilt more locations than are retained; totals cover the busiest locations per frame, not every rebuild.`,
    );
  }
  const unresolved = hotspots.find((h) => h.file === "unknown");
  if (unresolved) {
    notes.push(
      `${unresolved.rebuilds} rebuild(s) could not be resolved to a source location. These are widgets whose location the framework described before this session began.`,
    );
  }
  if (!hotspots.some((h) => h.appCode)) {
    notes.push(
      "No hotspot resolved to your own code. Everything listed is package or framework code, which usually means the rebuild originates from a parent you do own.",
    );
  }

  return {
    framesWithRebuilds: events.length,
    totalRebuilds,
    meanPerFrame: Math.round((totalRebuilds / events.length) * 10) / 10,
    hotspots,
    notes,
  };
}
