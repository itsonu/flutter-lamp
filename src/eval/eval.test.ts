import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadIncident, replay } from "./replay.js";
import { report, score, scoreIncident } from "./score.js";

/**
 * Phase D: the diagnosis engine measured against recorded sessions instead of
 * against its own unit tests.
 *
 * Every other test in this repo builds a store by hand and asserts on what the
 * engine does with it. That checks the code against its author's expectations,
 * which is worth having and is not the same thing as checking it against an app
 * that actually misbehaved. These incidents are real captures from a device,
 * replayed byte for byte.
 *
 * The gate is deliberately asymmetric. Top-1 accuracy has a floor; **false
 * confidence has a ceiling of zero**. A wrong confident answer is not a
 * slightly worse right answer — it sends a developer somewhere the bug is not,
 * and it spends the trust that makes the correct answers worth reading. An
 * honest "unknown" costs them nothing they were not already paying.
 */

const DIR = "eval/incidents";

/** Every incident on disk, so adding a file adds coverage with no wiring. */
function incidents() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadIncident(join(DIR, f)));
}

test("there are incidents to evaluate", () => {
  // A green evaluation over zero incidents is the most misleading result
  // available: it looks like a passing gate and measures nothing.
  assert.ok(incidents().length >= 2, "at least one positive and one negative incident");
});

test("every incident replays without losing its evidence", () => {
  for (const incident of incidents()) {
    const result = replay(incident);
    assert.ok(result.restored > 0, `${incident.name}: nothing restored`);

    // Hydration must preserve ids. If it renumbered, a diagnosis could still
    // look plausible while citing events that no longer exist, and evidence
    // precision would be meaningless.
    const ids = new Set(incident.session.events.map((e) => e.eventId));
    for (const item of result.runtime.evidence) {
      assert.ok(
        ids.has(item.eventId),
        `${incident.name}: cites ${item.eventId}, which is not in the recorded session`,
      );
    }
  }
});

test("no incident produces a confident wrong answer", () => {
  const results = incidents().map(replay);
  const bad = results.map(scoreIncident).filter((s) => s.falseConfidence);

  assert.deepEqual(
    bad.map((s) => s.name),
    [],
    "committed to a cause the evidence does not support:\n" +
      bad.map((s) => `  ${s.name}: ${s.notes.join("; ")}`).join("\n"),
  );
});

test("the engine answers each recorded incident correctly", () => {
  const results = incidents().map(replay);
  const m = score(results);

  const failing = m.scores.filter(
    (s) => !s.causeCorrect || !s.statusCorrect || !s.confidenceInBand || s.danglingEvidence.length,
  );
  assert.deepEqual(failing.map((s) => s.name), [], "\n" + report(m));

  // Floors, not targets. Raise them when the incident set grows; never lower
  // one to make a run pass — a lowered floor is a regression with paperwork.
  assert.equal(m.falseConfidenceRate, 0, "false confidence must be zero");
  assert.ok(m.top1Accuracy >= 1, `top-1 accuracy ${m.top1Accuracy} below floor`);
  assert.equal(m.danglingEvidence, 0, "every cited event must resolve");
});

test("an incident expecting unknown is not answered with a guess", () => {
  const negatives = incidents().filter((i) => i.expect.cause === "unknown");
  assert.ok(negatives.length >= 1, "the set must include a case where 'unknown' is correct");

  for (const incident of negatives) {
    const { runtime } = replay(incident);
    assert.equal(
      runtime.status,
      "unknown",
      `${incident.name}: answered "${runtime.cause}" where the honest answer is unknown`,
    );
  }
});

test("required evidence is cited, so a claim can be checked", () => {
  for (const incident of incidents()) {
    const want = incident.expect.evidenceIncludes;
    if (!want?.length) continue;

    const s = scoreIncident(replay(incident));
    assert.equal(
      s.evidenceRecall,
      1,
      `${incident.name}: ${s.notes.join("; ")}`,
    );
  }
});
