import { readFileSync } from "node:fs";
import { RuntimeStore } from "../core/runtimeStore.js";
import type { RuntimeEvent } from "../core/events.js";
import { diagnose, type CauseKind, type Diagnosis } from "../diagnosis/engine.js";
import { diagnosePerformance, type PerformanceDiagnosis } from "../diagnosis/performance.js";
import { SCHEMA_VERSION, type SessionExport } from "../export/session.js";

/**
 * Replays a recorded session and re-runs the diagnosis over it.
 *
 * This is the half of Phase D that makes the other half possible. A diagnosis
 * engine that is only ever exercised against synthetic stores built inside its
 * own tests is measured against its author's imagination; replaying a real
 * captured session measures it against an app that actually misbehaved.
 *
 * `export_session` was already the right artifact for this — versioned, with
 * every event and every diagnosis, and the schema pinned by a test. Nothing new
 * had to be invented to record an incident: attach the export.
 *
 * What this deliberately does NOT do is re-run collectors or touch a device. A
 * golden incident is a fixed input, so a change in the diagnosis is a change in
 * the diagnosis rather than in the weather.
 */

/** An incident: a recorded session, and what the right answer actually is. */
export interface GoldenIncident {
  name: string;
  /** Where this came from. A golden with no provenance cannot be re-derived. */
  capturedFrom: string;
  /**
   * Why this is the correct answer, in prose, argued from the events.
   *
   * Required, and the most important field in the file. A golden written by
   * pasting what the tool currently says is a test that can never fail — it
   * pins today's behaviour and calls it truth. Having to argue the answer in
   * sentences is what makes that obvious: a copied golden has nothing to write
   * here.
   */
  why: string;
  session: SessionExport;
  expect: Expectation;
}

export interface Expectation {
  /**
   * The cause the evidence supports. `"unknown"` is a real expected answer,
   * not an absent one: a session where the honest response is "I cannot tell"
   * is exactly the case a confident guess would fail, so those incidents carry
   * the most weight.
   */
  cause: CauseKind;
  /** Whether the engine should be confident enough to commit to it. */
  status: "diagnosed" | "unknown";
  /**
   * Inclusive confidence band. A band rather than a number: the score is a
   * heuristic, so pinning it to two decimals would make every tuning change
   * look like a regression.
   */
  confidence: [number, number];
  /**
   * Event ids the diagnosis must cite. A subset, not the whole list — the
   * requirement is that the engine points at the events that actually matter,
   * not that it cites exactly these and nothing else.
   */
  evidenceIncludes?: string[];
  /** Performance findings expected by category, if this incident covers them. */
  performanceFindings?: string[];
}

export interface ReplayResult {
  incident: GoldenIncident;
  runtime: Diagnosis;
  performance: PerformanceDiagnosis;
  /** Events actually restored, after this store's retention. */
  restored: number;
}

/** Load an incident from disk, failing loudly on anything malformed. */
export function loadIncident(path: string): GoldenIncident {
  const raw = JSON.parse(readFileSync(path, "utf8")) as GoldenIncident;

  for (const field of ["name", "capturedFrom", "why", "session", "expect"] as const) {
    if (raw[field] === undefined) throw new Error(`${path}: missing "${field}"`);
  }
  if (raw.session.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${path}: session schemaVersion ${raw.session.schemaVersion}, this build reads ${SCHEMA_VERSION}. ` +
        "Re-record the incident rather than editing it by hand.",
    );
  }
  if (raw.session.mode !== "full") {
    throw new Error(
      `${path}: recorded in "${raw.session.mode}" mode. A golden needs "full" — ` +
        "brief carries only the events the old diagnosis happened to cite, which biases the replay " +
        "towards agreeing with it.",
    );
  }
  if (raw.why.trim().length < 40) {
    throw new Error(
      `${path}: "why" is ${raw.why.trim().length} chars. Argue the answer from the events — ` +
        "a golden nobody can justify is a golden nobody can trust.",
    );
  }
  return raw;
}

/** Rebuild the session and re-diagnose it. */
export function replay(incident: GoldenIncident): ReplayResult {
  const store = new RuntimeStore();
  const events = incident.session.events as RuntimeEvent[];
  store.hydrate(events, incident.session.session.startedAt);

  return {
    incident,
    runtime: diagnose(store),
    performance: diagnosePerformance(store),
    restored: store.size(),
  };
}
