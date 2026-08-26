import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { diagnosePerformance } from "./performance.js";

/**
 * Adversarial matrix for the state/jank correlation heuristic.
 *
 * The failure mode worth guarding is not "misses a real signal" — it is
 * "reports a confident-looking percentage for a relationship that is not
 * there". Dense state activity makes every frame fall inside a window, so the
 * raw ratio saturates at 100% whether or not jank has anything to do with
 * state. Each scenario below pins one way that can go wrong.
 */

const T = 1_700_000_000_000;
const FRAME_MS = 16;

function frame(store: RuntimeStore, at: number, janky: boolean) {
  return store.add({
    timestamp: at,
    source: "Flutter.Frame",
    severity: janky ? "error" : "debug",
    category: "frame",
    message: "f",
    data: { janky, elapsedMs: janky ? 44 : 7, buildMs: janky ? 30 : 4, rasterMs: 4 },
  });
}

function frameRun(store: RuntimeStore, count: number, janky: boolean, at: number) {
  for (let i = 0; i < count; i++) frame(store, at + i * FRAME_MS, janky);
}

function stateRun(store: RuntimeStore, count: number, at: number, stepMs = 1) {
  for (let i = 0; i < count; i++) {
    store.add({
      timestamp: at + i * stepMs,
      source: "provider:provider_changed",
      severity: "debug",
      category: "state",
      message: "provider state changed",
      data: { framework: "provider", providerRef: "0", valuesAvailable: false },
    });
  }
}

const stateClaim = (store: RuntimeStore) =>
  diagnosePerformance(store).findings.find((f) => /state activity/.test(f.claim));

// ── A. tightly aligned ───────────────────────────────────────────────────────
test("A: jank clustered on state activity, with quiet frames elsewhere, is reported", () => {
  const store = new RuntimeStore();
  // Smooth frames far away, so the control group is genuinely un-saturated.
  frameRun(store, 80, false, T);
  frameRun(store, 30, true, T + 600_000);
  stateRun(store, 50, T + 600_000);

  const finding = stateClaim(store);
  assert.ok(finding, "a real, discriminating signal must survive");
  assert.match(finding.claim, /30 of 30 janky frames \(100%\)/);
  assert.match(finding.claim, /0% of the 80 smooth frames were also inside a window/);
  assert.equal(finding.strength, 0.5, "still only co-occurrence");
});

// ── B. state activity, no jank ───────────────────────────────────────────────
test("B: state activity without jank produces no finding", () => {
  const store = new RuntimeStore();
  frameRun(store, 100, false, T);
  stateRun(store, 500, T);

  assert.equal(stateClaim(store), undefined, "no janky frames means nothing to correlate");
});

// ── C. jank, no state activity ───────────────────────────────────────────────
test("C: jank without any state activity produces no finding", () => {
  const store = new RuntimeStore();
  frameRun(store, 60, false, T);
  frameRun(store, 40, true, T + 10_000);

  assert.equal(stateClaim(store), undefined);
});

// ── D. both frequent, independent — the dangerous one ────────────────────────
test("D: continuous state activity is withheld, not reported as 100% co-occurrence", () => {
  // Provider churn running the whole time, jank scattered through it. Every
  // frame — janky or smooth — sits inside a window. The raw ratio is 100% and
  // means nothing; the base rate is also 100%, so there is no lift.
  const store = new RuntimeStore();
  frameRun(store, 60, false, T);
  frameRun(store, 40, true, T + 60 * FRAME_MS);
  stateRun(store, 2_000, T, 1); // ~2s of dense activity blanketing everything

  const finding = stateClaim(store);
  assert.equal(
    finding,
    undefined,
    "saturated activity must not be dressed up as a discovered relationship",
  );
});

// ── E. one long burst overlapping many frames ────────────────────────────────
test("E: a single long burst still needs the smooth frames to differ", () => {
  const store = new RuntimeStore();
  // Burst covers the janky frames and nothing else; smooth frames sit outside.
  frameRun(store, 80, false, T);
  frameRun(store, 25, true, T + 300_000);
  stateRun(store, 300, T + 299_500, 3); // ~900ms burst around the jank only

  const finding = stateClaim(store);
  assert.ok(finding, "a burst confined to the janky window is a real difference");
  assert.match(finding.claim, /0% of the 80 smooth frames/);
});

// ── F. one janky frame inside many state windows ─────────────────────────────
test("F: overlapping windows count a frame once, not once per state event", () => {
  const store = new RuntimeStore();
  frameRun(store, 80, false, T);
  frameRun(store, 5, true, T + 400_000);
  // 400 events all within a second of those five frames.
  stateRun(store, 400, T + 400_000, 2);

  const finding = stateClaim(store);
  assert.ok(finding);
  // Five janky frames, not 2,000 frame-window pairs.
  assert.match(finding.claim, /5 of 5 janky frames/);
  assert.match(finding.claim, /\(400 events\)/, "event volume is reported separately from frame count");
});

// ── Contract guards ──────────────────────────────────────────────────────────
test("the finding never asserts causation, and says the window is symmetric", () => {
  const store = new RuntimeStore();
  frameRun(store, 80, false, T);
  frameRun(store, 30, true, T + 600_000);
  stateRun(store, 50, T + 600_000);

  const finding = stateClaim(store);
  assert.ok(finding);
  assert.match(finding.fix, /Correlation only/);
  assert.match(finding.fix, /does not show the state change came first/);
  assert.ok(!/caused|because of|due to/i.test(finding.claim), "the claim states co-occurrence, nothing more");
  // It must never outrank a causal finding.
  assert.ok(finding.strength <= 0.5);
});

test("sparse activity below the floor is not a finding", () => {
  const store = new RuntimeStore();
  frameRun(store, 80, false, T);
  frameRun(store, 30, true, T + 600_000);
  // Two events near the jank: under the three-frame floor once matched.
  stateRun(store, 2, T + 600_000 - 5_000);

  assert.equal(stateClaim(store), undefined, "two distant events is not evidence");
});

test("it appears at most once in a diagnosis", () => {
  const store = new RuntimeStore();
  frameRun(store, 80, false, T);
  frameRun(store, 30, true, T + 600_000);
  stateRun(store, 50, T + 600_000);

  const matches = diagnosePerformance(store).findings.filter((f) => /state activity/.test(f.claim));
  assert.equal(matches.length, 1, "the merge briefly invoked this twice; it must stay singular");
});
