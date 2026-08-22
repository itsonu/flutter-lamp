import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { correlate, gapMs, intervalOf, timelineAround } from "./correlation.js";
import type { RuntimeEvent } from "../core/events.js";

const T = 1_700_000_000_000;

function store() {
  return new RuntimeStore();
}

function exception(s: RuntimeStore, at: number, message = "Null check operator used on a null value") {
  return s.add({
    timestamp: at,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message,
    data: { stackTrace: "#0 ..." },
  });
}

function request(s: RuntimeStore, startMs: number, endMs: number, message = "GET /api/user → 500") {
  return s.add({
    timestamp: startMs,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message,
    data: { startTimeMs: startMs, endTimeMs: endMs, uri: "/api/user", statusCode: 500 },
  });
}

test("a network event's interval spans its request, not just its start", () => {
  const s = store();
  const slow = request(s, T, T + 30_000);
  assert.deepEqual(intervalOf(slow), { start: T, end: T + 30_000 });

  const point = exception(s, T);
  assert.deepEqual(intervalOf(point), { start: T, end: T });
});

test("gap is signed, and zero when the spans overlap", () => {
  assert.equal(gapMs({ start: 0, end: 10 }, { start: 20, end: 30 }), -10, "finished before");
  assert.equal(gapMs({ start: 40, end: 50 }, { start: 20, end: 30 }), 10, "began after");
  assert.equal(gapMs({ start: 0, end: 25 }, { start: 20, end: 30 }), 0, "overlapping");
});

test("a slow request that fails just before an exception IS correlated", () => {
  // The bug this fixes: the request STARTS 30s before the exception, far outside
  // the 3s window, but RETURNS 200ms before it. A hanging request is exactly
  // the kind that causes the failure being diagnosed.
  const s = store();
  const slow = request(s, T - 30_000, T - 200);
  const boom = exception(s, T);

  const near = correlate(s.query(), boom, 3_000);
  assert.deepEqual(
    near.map((c) => c.event.eventId),
    [slow.eventId],
  );
  assert.equal(near[0].relation, "preceded");
  assert.equal(near[0].deltaMs, -200, "distance is measured from when the request finished");
});

test("a request that finished long before the exception is not correlated", () => {
  const s = store();
  request(s, T - 60_000, T - 40_000);
  const boom = exception(s, T);

  assert.deepEqual(correlate(s.query(), boom, 3_000), []);
});

test("a request still in flight when the exception fires overlaps it", () => {
  const s = store();
  const inFlight = request(s, T - 5_000, T + 5_000);
  const boom = exception(s, T);

  const [near] = correlate(s.query(), boom, 3_000);
  assert.equal(near.event.eventId, inFlight.eventId);
  assert.equal(near.relation, "overlapped");
  assert.equal(near.deltaMs, 0);
});

test("correlated events come back nearest-first", () => {
  const s = store();
  const far = request(s, T - 2_500, T - 2_500, "GET /far → 500");
  const near = request(s, T - 100, T - 100, "GET /near → 500");
  const boom = exception(s, T);

  assert.deepEqual(
    correlate(s.query(), boom, 3_000).map((c) => c.event.eventId),
    [near.eventId, far.eventId],
  );
});

test("the anchor is excluded from its own correlations", () => {
  const s = store();
  const boom = exception(s, T);
  assert.deepEqual(correlate(s.query(), boom, 3_000), []);
});

test("the timeline is chronological and marks the anchor", () => {
  const s = store();
  request(s, T - 1_000, T - 900, "GET /first → 500");
  s.add({
    timestamp: T - 500,
    source: "Stderr",
    severity: "error",
    category: "log",
    message: "state was null",
    data: {},
  });
  const boom = exception(s, T);

  const entries = timelineAround(s.query(), boom, 3_000);
  assert.deepEqual(
    entries.map((e) => e.message),
    ["GET /first → 500", "state was null", "Null check operator used on a null value"],
  );
  assert.equal(entries.at(-1)?.relation, "anchor");
  assert.equal(entries.at(-1)?.deltaMs, 0);
  assert.equal(entries[0].relation, "preceded");
  assert.ok(entries.every((e) => e.eventId.length > 0), "every entry is citable");
});

test("a backwards interval from a malformed profile is normalized", () => {
  const s = store();
  const broken: RuntimeEvent = s.add({
    timestamp: T,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /x → 500",
    data: { startTimeMs: T + 500, endTimeMs: T },
  });
  const span = intervalOf(broken);
  assert.ok(span.start <= span.end, "an interval must never run backwards");
});
