import { test } from "node:test";
import assert from "node:assert/strict";
import { STALL_THRESHOLD_MS, timelineStaleness } from "./timelineStaleness.js";

// The measured incident this guards: newest ring event 44,034,107,771 µs while
// the VM clock read 44,147,977,612 µs — a 113.9s gap with flags still claiming
// the streams were recorded.
const NOW = 44_147_977_612;

test("a recorder minutes behind the VM clock is reported as stalled", () => {
  const s = timelineStaleness(NOW, [{ ts: 44_034_107_771 }, { ts: 43_986_341_116 }]);
  assert.equal(s.stalled, true);
  assert.equal(s.recorderLagMs, Math.round((NOW - 44_034_107_771) / 1000));
  assert.match(String(s.warning), /stalled/);
  assert.match(String(s.warning), /historical, not current/);
});

test("a live recorder within the threshold is not flagged", () => {
  const s = timelineStaleness(NOW, [{ ts: NOW - 2_000_000 }]); // 2s behind
  assert.equal(s.stalled, false);
  assert.equal(s.recorderLagMs, 2_000);
  assert.equal(s.warning, undefined);
});

test("the threshold boundary itself is not a stall", () => {
  const s = timelineStaleness(NOW, [{ ts: NOW - STALL_THRESHOLD_MS * 1000 }]);
  assert.equal(s.stalled, false);
});

test("no clock or no events means no verdict, not a false one", () => {
  assert.deepEqual(timelineStaleness(null, [{ ts: 1 }]), { recorderLagMs: null, stalled: false });
  assert.deepEqual(timelineStaleness(NOW, []), { recorderLagMs: null, stalled: false });
  assert.deepEqual(timelineStaleness(NOW, [{}]), { recorderLagMs: null, stalled: false });
});

test("a clock slightly behind an event clamps to zero rather than going negative", () => {
  const s = timelineStaleness(NOW, [{ ts: NOW + 500 }]);
  assert.equal(s.recorderLagMs, 0);
  assert.equal(s.stalled, false);
});
