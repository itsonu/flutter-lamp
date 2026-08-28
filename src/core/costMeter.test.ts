import { test } from "node:test";
import assert from "node:assert/strict";
import { costMeter } from "./costMeter.js";

/**
 * The cost of using this server, measured rather than guessed.
 *
 * Bytes are counted; tokens are estimated at bytes/4 and labelled as such
 * everywhere they surface. A confident token count from the wrong tokenizer
 * would be worse than an honest estimate.
 */

test("cost accumulates per tool and ranks by bytes", () => {
  costMeter.reset();
  costMeter.record("get_frames", 20_000, 5, false);
  costMeter.record("get_frames", 20_000, 40, false);
  costMeter.record("diagnose_runtime", 8_000, 70, false);
  costMeter.record("get_network", 20, 1, true);

  const r = costMeter.report();
  assert.equal(r.calls, 4);
  assert.equal(r.responseBytes, 48_020);
  assert.equal(r.estimatedTokens, Math.round(48_020 / 4));
  assert.equal(r.errors, 1);

  // Largest first: the point of the report is to show what is expensive.
  assert.deepEqual(r.byTool.map((t) => t.tool), [
    "get_frames",
    "diagnose_runtime",
    "get_network",
  ]);
  assert.equal(r.byTool[0].calls, 2);
  assert.equal(r.byTool[0].slowestMs, 40, "keeps the slowest call, not the last");
});

test("cost resets per session", () => {
  costMeter.reset();
  costMeter.record("get_logs", 1_000, 1, false);
  assert.equal(costMeter.report().calls, 1);

  // A reconnect must not charge the new session for the old one's calls.
  costMeter.reset();
  const r = costMeter.report();
  assert.equal(r.calls, 0);
  assert.equal(r.responseBytes, 0);
  assert.equal(r.estimatedTokens, 0);
  assert.deepEqual(r.byTool, []);
});

test("recent calls are newest first and capped", () => {
  costMeter.reset();
  for (let i = 0; i < 300; i++) costMeter.record("t" + i, 10, i, false);
  const r = costMeter.report();
  assert.equal(r.recent[0].tool, "t299", "newest first");
  assert.ok(r.recent.length <= 200, "capped so the dashboard payload stays small");
  assert.equal(r.recent.length, 200, "keeps a window big enough that the activity stream is not silently truncated");
});

test("average duration is derivable, not just the slowest", () => {
  costMeter.reset();
  costMeter.record("get_frames", 100, 10, false);
  costMeter.record("get_frames", 100, 30, false);
  const t = costMeter.report().byTool[0];
  assert.equal(t.totalMs, 40);
  assert.equal(t.totalMs / t.calls, 20);
  assert.equal(t.slowestMs, 30);
  assert.ok(t.lastAt !== null && t.lastAt > 0, "a tool with calls has a last-called time");
});
