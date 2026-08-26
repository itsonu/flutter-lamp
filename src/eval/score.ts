import type { ReplayResult } from "./replay.js";

/**
 * Scores replayed incidents.
 *
 * The metric that matters most here is not accuracy. It is the **false
 * confidence rate**: how often the engine commits to a cause and is wrong.
 *
 * A tool that says "unknown" when it cannot tell costs a developer nothing —
 * they go and look themselves, which is what they were doing anyway. A tool
 * that says "the network call caused your jank" with 85% confidence when it did
 * not sends them somewhere else entirely, and it spends the credibility that
 * makes every correct answer worth reading. So a wrong confident answer is
 * scored as strictly worse than an honest abstention, and the gate below
 * refuses any of them rather than allowing a percentage.
 *
 * Everything is computed against `expect`, which is authored from the events —
 * never from what the engine currently says. See `GoldenIncident.why`.
 */

export interface IncidentScore {
  name: string;
  causeCorrect: boolean;
  statusCorrect: boolean;
  confidenceInBand: boolean;
  /** Of the ids the incident requires, the fraction actually cited. */
  evidenceRecall: number | null;
  /** Cited an id that resolves to no restored event. */
  danglingEvidence: string[];
  /** Committed to a cause, and it was the wrong one. The expensive failure. */
  falseConfidence: boolean;
  /** Correctly declined to answer. */
  honestUnknown: boolean;
  notes: string[];
}

export interface Metrics {
  incidents: number;
  /** Fraction whose top cause matched. */
  top1Accuracy: number;
  /** Mean recall over incidents that name required evidence. */
  evidencePrecision: number | null;
  /** Fraction that committed to a wrong cause. Must be zero. */
  falseConfidenceRate: number;
  /** Of incidents whose right answer was "unknown", fraction answered so. */
  unknownPrecision: number | null;
  /** Confidence values that fell outside the expected band. */
  outOfBand: number;
  danglingEvidence: number;
  scores: IncidentScore[];
}

export function scoreIncident(result: ReplayResult): IncidentScore {
  const { incident, runtime } = result;
  const want = incident.expect;
  const notes: string[] = [];

  const causeCorrect = runtime.cause === want.cause;
  if (!causeCorrect) notes.push(`cause: expected ${want.cause}, got ${runtime.cause}`);

  const statusCorrect = runtime.status === want.status;
  if (!statusCorrect) notes.push(`status: expected ${want.status}, got ${runtime.status}`);

  const [lo, hi] = want.confidence;
  const confidenceInBand = runtime.confidence >= lo && runtime.confidence <= hi;
  if (!confidenceInBand) {
    notes.push(`confidence ${runtime.confidence} outside [${lo}, ${hi}]`);
  }

  const cited = new Set(runtime.evidence.map((e) => e.eventId));
  let evidenceRecall: number | null = null;
  if (want.evidenceIncludes && want.evidenceIncludes.length > 0) {
    const found = want.evidenceIncludes.filter((id) => cited.has(id));
    evidenceRecall = found.length / want.evidenceIncludes.length;
    const missed = want.evidenceIncludes.filter((id) => !cited.has(id));
    if (missed.length > 0) notes.push(`evidence not cited: ${missed.join(", ")}`);
  }

  // A citation that resolves to nothing is worse than a missing one: the claim
  // reads as checkable and is not. Scored separately so it can never be
  // averaged away.
  const restored = new Set(
    (result.incident.session.events ?? []).map((e) => e.eventId),
  );
  const danglingEvidence = [...cited].filter((id) => !restored.has(id));
  if (danglingEvidence.length > 0) {
    notes.push(`cites events not in the session: ${danglingEvidence.join(", ")}`);
  }

  // Committed to an answer, and the answer was wrong. Note that expecting
  // "unknown" and getting a confident cause counts here too — that is the
  // guess this tool exists not to make.
  const falseConfidence = runtime.status === "diagnosed" && !causeCorrect;
  const honestUnknown = want.cause === "unknown" && runtime.status === "unknown";

  return {
    name: incident.name,
    causeCorrect,
    statusCorrect,
    confidenceInBand,
    evidenceRecall,
    danglingEvidence,
    falseConfidence,
    honestUnknown,
    notes,
  };
}

export function score(results: ReplayResult[]): Metrics {
  const scores = results.map(scoreIncident);
  const n = scores.length;
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

  const wantUnknown = results.filter((r) => r.incident.expect.cause === "unknown");
  const recalls = scores.map((s) => s.evidenceRecall).filter((r): r is number => r !== null);

  return {
    incidents: n,
    top1Accuracy: n === 0 ? 0 : scores.filter((s) => s.causeCorrect).length / n,
    evidencePrecision: mean(recalls),
    falseConfidenceRate: n === 0 ? 0 : scores.filter((s) => s.falseConfidence).length / n,
    unknownPrecision:
      wantUnknown.length === 0
        ? null
        : scores.filter((s) => s.honestUnknown).length / wantUnknown.length,
    outOfBand: scores.filter((s) => !s.confidenceInBand).length,
    danglingEvidence: scores.filter((s) => s.danglingEvidence.length > 0).length,
    scores,
  };
}

/** Human-readable report, for a CI log or a terminal. */
export function report(m: Metrics): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  const lines = [
    `incidents            ${m.incidents}`,
    `top-1 accuracy       ${pct(m.top1Accuracy)}`,
    `evidence recall      ${pct(m.evidencePrecision)}`,
    `false confidence     ${pct(m.falseConfidenceRate)}   (must be 0%)`,
    `unknown precision    ${pct(m.unknownPrecision)}`,
    `confidence out of band ${m.outOfBand}`,
    `dangling evidence    ${m.danglingEvidence}`,
    "",
  ];
  for (const s of m.scores) {
    const ok = s.causeCorrect && s.statusCorrect && s.confidenceInBand && s.danglingEvidence.length === 0;
    lines.push(`${ok ? "ok  " : "FAIL"} ${s.name}`);
    for (const note of s.notes) lines.push(`       ${note}`);
  }
  return lines.join("\n");
}
