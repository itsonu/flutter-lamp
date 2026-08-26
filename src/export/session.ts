import { redactVmServiceUri } from "../core/redaction.js";
import { CATEGORIES, type Category, type RuntimeEvent } from "../core/events.js";
import type { CollectorReport } from "../core/connection.js";
import type { RetentionReport, RuntimeStore } from "../core/runtimeStore.js";
import { diagnose, type Diagnosis } from "../diagnosis/engine.js";
import { diagnosePerformance, type PerformanceDiagnosis } from "../diagnosis/performance.js";
import { routeHistory, type NavigationReport } from "../diagnosis/navigation.js";
import { rebuildReport, type RebuildReport } from "../diagnosis/rebuilds.js";
import { VERSION } from "../version.js";

/**
 * A whole debugging session as one versioned, machine-readable artifact
 * (docs/Improvement-Plan.md, P3): metadata, collector health, retention, the
 * events themselves, and every diagnosis computed over them. Suitable for a bug
 * report, for offline analysis, and as a regression fixture.
 *
 * Two modes, because the two consumers want opposite things:
 *
 * - `full` is the archive. Everything retained, for a human or a later replay.
 * - `brief` is the AI-facing artifact. The diagnoses plus *only* the events
 *   their own evidence cites — the smallest sufficient context. An agent that
 *   is handed the whole buffer spends its window re-deriving what the diagnosis
 *   already concluded; one that is handed the conclusion with no evidence
 *   cannot check it. `brief` is both: every claim, and exactly the events
 *   behind it.
 *
 * Nothing is redacted here, because there is nothing left to redact: redaction
 * happens at capture (`src/core/redaction.ts`), so credentials never enter the
 * store and an exporter cannot leak what was never written.
 *
 * `schemaVersion` is pinned by a test over the top-level key set. A consumer
 * parsing this should refuse a version it does not know rather than guess.
 */

export const SCHEMA_VERSION = 1;

export type ExportMode = "full" | "brief";

export interface SessionExport {
  schemaVersion: number;
  tool: { name: string; version: string };
  mode: ExportMode;
  session: {
    id: string | null;
    startedAt: number | null;
    exportedAt: number;
    connected: boolean;
    wsUri: string | null;
  };
  collectors: CollectorReport[];
  counts: Record<Category, number>;
  retention: RetentionReport;
  /** In `brief`, only the events cited by the diagnoses below. Oldest first. */
  events: RuntimeEvent[];
  /** True when `events` is the cited subset rather than everything retained. */
  eventsAreCitedSubset: boolean;
  diagnoses: {
    runtime: Diagnosis;
    performance: PerformanceDiagnosis;
    navigation: NavigationReport;
    rebuilds: RebuildReport;
  };
}

export interface ExportMeta {
  connected: boolean;
  sessionId: string | null;
  wsUri: string | null;
  /** Per-collector health, so a reader can tell empty from blind. */
  collectors: CollectorReport[];
}

export interface ExportOptions {
  mode?: ExportMode;
  /** Cap per category in `full` mode. Retention caps it again anyway. */
  limitPerCategory?: number;
  /** Injectable for tests; production passes nothing. */
  now?: () => number;
}

export function exportSession(
  store: RuntimeStore,
  meta: ExportMeta,
  opts: ExportOptions = {},
): SessionExport {
  const mode = opts.mode ?? "full";
  const now = opts.now ?? Date.now;

  const diagnoses = {
    runtime: diagnose(store),
    performance: diagnosePerformance(store),
    navigation: routeHistory(store),
    rebuilds: rebuildReport(store),
  };

  const events =
    mode === "brief" ? citedEvents(store, diagnoses) : allEvents(store, opts.limitPerCategory ?? 5_000);

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "flutter-lamp", version: VERSION },
    mode,
    session: {
      id: meta.sessionId,
      startedAt: store.sessionStarted(),
      exportedAt: now(),
      connected: meta.connected,
      // The path segment of a VM Service URI is an auth token granting
      // evaluate — arbitrary Dart execution in the app. Redacted here, in
      // the exporter, so the artifact is safe no matter who builds it.
      wsUri: redactVmServiceUri(meta.wsUri),
    },
    collectors: meta.collectors,
    counts: store.counts(),
    retention: store.retention(),
    events,
    eventsAreCitedSubset: mode === "brief",
    diagnoses,
  };
}

/** Everything retained in the current session, oldest first. */
function allEvents(store: RuntimeStore, limitPerCategory: number): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (const category of CATEGORIES) {
    out.push(...store.query({ category, limit: limitPerCategory }));
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Only the events the diagnoses actually cite, resolved back to their full
 * stored record. An id that no longer resolves — evicted since the diagnosis
 * ran — is dropped rather than emitted as a dangling reference.
 */
function citedEvents(
  store: RuntimeStore,
  diagnoses: SessionExport["diagnoses"],
): RuntimeEvent[] {
  const ids = new Set<string>();
  for (const id of citedIds(diagnoses)) ids.add(id);

  const out: RuntimeEvent[] = [];
  for (const id of ids) {
    const event = store.byEventId(id);
    if (event) out.push(event);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Every event id referenced anywhere in the diagnoses. */
function* citedIds(diagnoses: SessionExport["diagnoses"]): Generator<string> {
  const { runtime, performance, navigation } = diagnoses;

  for (const item of runtime.evidence) yield item.eventId;
  for (const entry of runtime.timeline) yield entry.eventId;
  for (const alternative of runtime.alternativeCauses) yield* alternative.evidence;

  for (const finding of performance.findings) yield* finding.evidence;

  for (const visit of navigation.visits) {
    yield visit.eventId;
    yield* visit.exceptions;
    yield* visit.networkFailures;
  }

  // `rebuilds` is aggregated by source location and cites no event ids, so
  // there is nothing to resolve for it.
}
