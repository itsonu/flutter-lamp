import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { compareWindows } from "./comparison.js";
import { whatChanged } from "./health.js";

const T = 1_700_000_000_000;
const W = 10_000; // window width

/** A store observing since well before the baseline window. */
function observedStore() {
  const store = new RuntimeStore();
  store.beginSession(T - 10 * W);
  return store;
}

function request(store: RuntimeStore, at: number, durationMs: number, status = 200) {
  return store.add({
    timestamp: at,
    source: "HttpProfile",
    severity: status >= 400 ? "error" : "info",
    category: "network",
    message: `GET /api/x → ${status}`,
    data: { startTimeMs: at, endTimeMs: at + durationMs, durationMs, statusCode: status },
  });
}

function exception(store: RuntimeStore, at: number) {
  return store.add({
    timestamp: at,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "boom",
    data: { stackTrace: "#0 ..." },
  });
}

function change(result: ReturnType<typeof compareWindows>, dimension: string) {
  return result.changes.find((c) => c.dimension === dimension);
}

test("a latency spike is detected and cites the slowest incident request", () => {
  const store = observedStore();
  // Baseline: three quick requests. Incident: three slow ones.
  for (let i = 0; i < 3; i++) request(store, T - 2 * W + 1_000 + i * 1_000, 100);
  for (let i = 0; i < 2; i++) request(store, T - W + 1_000 + i * 1_000, 900);
  const slowest = request(store, T - W + 4_000, 1_800);

  const result = compareWindows(store, store.query({ limit: 5_000 }), T, W);
  assert.equal(result.baselineCovered, true);

  const p95 = change(result, "networkLatencyP95Ms");
  assert.ok(p95, "latency change should be reported");
  assert.equal(p95.baseline, 100);
  assert.equal(p95.incident, 1_800);
  assert.equal(p95.direction, "spiked", "18x is a spike, not a mere increase");
  assert.deepEqual(p95.evidence, [slowest.eventId], "the concrete offender is citable");
});

test("failures appearing where there were none read as new", () => {
  const store = observedStore();
  request(store, T - 2 * W + 1_000, 100, 200); // healthy baseline traffic
  const f1 = request(store, T - W + 1_000, 100, 500);
  const f2 = request(store, T - W + 2_000, 100, 500);

  const failures = change(compareWindows(store, store.query({ limit: 5_000 }), T, W), "networkFailures");
  assert.ok(failures);
  assert.equal(failures.baseline, 0);
  assert.equal(failures.incident, 2);
  assert.equal(failures.direction, "new");
  assert.deepEqual(failures.evidence.sort(), [f1.eventId, f2.eventId].sort());
});

test("an uncovered baseline yields unknown directions, never fabricated 'new'", () => {
  const store = new RuntimeStore();
  // Observation began INSIDE the incident window: there is no baseline to
  // compare against, only silence that was never observed.
  store.beginSession(T - W + 500);
  exception(store, T - W + 1_000);

  const result = compareWindows(store, store.query({ limit: 5_000 }), T, W);
  assert.equal(result.baselineCovered, false);
  const exc = change(result, "exceptions");
  assert.ok(exc);
  assert.equal(exc.baseline, null, "an unobserved baseline is null, not zero");
  assert.equal(exc.direction, "unknown");
});

test("unchanged and doubly-empty dimensions stay out of the change list", () => {
  const store = observedStore();
  // Same count in both windows → unchanged → omitted.
  exception(store, T - 2 * W + 1_000);
  exception(store, T - W + 1_000);

  const result = compareWindows(store, store.query({ limit: 5_000 }), T, W);
  assert.equal(change(result, "exceptions"), undefined, "1 → 1 is not a change");
  assert.equal(change(result, "logErrors"), undefined, "0 → 0 is not a change");
  assert.equal(change(result, "jankPercent"), undefined, "no frames at all is not a change");
});

test("increases below the spike factor are increases", () => {
  const store = observedStore();
  exception(store, T - 2 * W + 1_000);
  exception(store, T - W + 1_000);
  exception(store, T - W + 2_000);

  const exc = change(compareWindows(store, store.query({ limit: 5_000 }), T, W), "exceptions");
  assert.ok(exc);
  assert.equal(exc.direction, "increased", "2x is below the 3x spike threshold");
});

test("every cited evidence id resolves back to a stored event", () => {
  const store = observedStore();
  request(store, T - 2 * W + 1_000, 100);
  request(store, T - W + 1_000, 2_000, 500);
  exception(store, T - W + 2_000);
  store.add({
    timestamp: T - W + 3_000,
    source: "Stderr",
    severity: "error",
    category: "log",
    message: "state was null",
    data: {},
  });

  const result = compareWindows(store, store.query({ limit: 5_000 }), T, W);
  assert.ok(result.changes.length >= 3);
  for (const c of result.changes) {
    for (const id of c.evidence) {
      assert.ok(store.byEventId(id), `${c.dimension} cites ${id}, which must resolve`);
    }
  }
});

test("what_changed carries the comparison and flags an uncovered baseline", () => {
  const store = new RuntimeStore();
  store.beginSession(T - 2_000); // observation began just before the anchor
  const boom = exception(store, T);

  const result = whatChanged(store, { eventId: boom.eventId, windowMs: W });
  assert.equal(result.comparison.baselineCovered, false);
  assert.ok(
    result.notes.some((n) => n.includes("baseline window predates observation")),
    "the agent is told the comparison has no ground to stand on",
  );

  // And a covered baseline compares for real, through the same tool surface.
  const covered = new RuntimeStore();
  covered.beginSession(T - 10 * W);
  request(covered, T - 2 * W + 1_000, 100);
  request(covered, T - W + 1_000, 1_500, 500);
  const anchor = exception(covered, T);
  const changed = whatChanged(covered, { eventId: anchor.eventId, windowMs: W });
  assert.equal(changed.comparison.baselineCovered, true);
  assert.ok(changed.comparison.changes.some((c) => c.dimension === "networkFailures"));
});
