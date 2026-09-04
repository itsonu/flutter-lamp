import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMED_BUDGET_MS,
  cadenceEvidence,
  frameBudget,
  frameBudgetUs,
  resetFrameBudget,
} from "./frameBudget.js";

/**
 * The budget is an assumption, and the point of this module is that it says so.
 *
 * The tests that matter are not "is it 16.67" — they are "does it ever present
 * itself as a measurement", and "does it refuse to infer a refresh rate from
 * evidence that cannot carry one".
 */

function withEnv(value: string | undefined, fn: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(process.env, "FLUTTER_LAMP_FRAME_BUDGET_MS");
  const prev = process.env.FLUTTER_LAMP_FRAME_BUDGET_MS;
  if (value === undefined) delete process.env.FLUTTER_LAMP_FRAME_BUDGET_MS;
  else process.env.FLUTTER_LAMP_FRAME_BUDGET_MS = value;
  resetFrameBudget();
  try {
    fn();
  } finally {
    if (had) process.env.FLUTTER_LAMP_FRAME_BUDGET_MS = prev;
    else delete process.env.FLUTTER_LAMP_FRAME_BUDGET_MS;
    resetFrameBudget();
  }
}

test("the default is 60fps and is labelled an assumption, not a reading", () => {
  withEnv(undefined, () => {
    const b = frameBudget();
    assert.equal(b.ms, ASSUMED_BUDGET_MS);
    assert.equal(b.source, "assumed");
    // The provenance has to name why it is assumed, or a caller will quote the
    // number as if the runtime reported it.
    assert.match(b.detail, /does not report the display refresh rate/);
    assert.equal(frameBudgetUs(), ASSUMED_BUDGET_MS * 1000);
  });
});

test("a known refresh rate can be supplied, and is marked configured", () => {
  withEnv("8.33", () => {
    const b = frameBudget();
    assert.equal(b.ms, 8.33);
    assert.equal(b.source, "configured");
    assert.match(b.detail, /FLUTTER_LAMP_FRAME_BUDGET_MS/);
    // 120fps, so the jank threshold really moves.
    assert.equal(frameBudgetUs(), 8330);
  });
});

test("a nonsense override falls back to the assumption rather than to nonsense", () => {
  for (const bad of ["", "abc", "0", "-5", "1000", "NaN"]) {
    withEnv(bad, () => {
      const b = frameBudget();
      assert.equal(b.ms, ASSUMED_BUDGET_MS, `override "${bad}" should not be honoured`);
      assert.equal(b.source, "assumed");
    });
  }
});

test("cadence is reported undecidable when frames carry no start time", () => {
  // This is the shape the collector actually produced until now, and the reason
  // the budget cannot be derived: number only, no per-frame clock.
  const frames = Array.from({ length: 200 }, (_, i) => ({ data: { number: 1000 + i } }));
  const ev = cadenceEvidence(frames);
  assert.equal(ev.derivable, false);
  assert.equal(ev.samples, 0);
  assert.match(ev.detail, /cannot be measured/);
  // It must not smuggle a rate out anyway.
  assert.ok(!("ms" in ev) && !("hz" in ev), "cadenceEvidence answers derivability, never a rate");
});

test("consecutive start times are counted, and only consecutive ones", () => {
  const frames = [
    { data: { number: 1, startTimeUs: 0 } },
    { data: { number: 2, startTimeUs: 8_333 } },
    { data: { number: 3, startTimeUs: 16_666 } },
    // A gap in frame numbers: the interval spans skipped frames, so it is not
    // a vsync period and must not be counted as one.
    { data: { number: 9, startTimeUs: 100_000 } },
    { data: { number: 10, startTimeUs: 108_333 } },
  ];
  const ev = cadenceEvidence(frames);
  assert.equal(ev.derivable, true);
  assert.equal(ev.samples, 3, "1->2, 2->3 and 9->10; not 3->9");
  assert.match(ev.detail, /consecutive-frame start-time intervals/);
});

test("a target reporting start times on only some frames is not treated as derivable-by-default", () => {
  const frames = [
    { data: { number: 1 } },
    { data: { number: 2 } },
    { data: { number: 3 } },
  ];
  assert.equal(cadenceEvidence(frames).derivable, false);
});
