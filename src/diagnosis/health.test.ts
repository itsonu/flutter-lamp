import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { runtimeHealth, whatChanged } from "./health.js";

const T = 1_700_000_000_000;

function exception(store: RuntimeStore, at: number, message = "Null check operator used on a null value") {
  return store.add({
    timestamp: at,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message,
    data: { stackTrace: "#0 ..." },
  });
}

function request(store: RuntimeStore, start: number, end: number, severity: "info" | "error" = "error") {
  return store.add({
    timestamp: start,
    source: "HttpProfile",
    severity,
    category: "network",
    message: `GET /api/user → ${severity === "error" ? 500 : 200}`,
    data: { startTimeMs: start, endTimeMs: end, uri: "/api/user" },
  });
}

function frames(store: RuntimeStore, total: number, jankyCount: number, at = T) {
  for (let i = 0; i < total; i++) {
    const janky = i < jankyCount;
    store.add({
      timestamp: at + i,
      source: "Flutter.Frame",
      severity: janky ? "error" : "debug",
      category: "frame",
      message: `Frame #${i}`,
      data: { janky, elapsedMs: janky ? 40 : 8, buildMs: 5, rasterMs: 3 },
    });
  }
}

test("an empty session reports no-data rather than health", () => {
  const health = runtimeHealth(new RuntimeStore(), true);
  assert.equal(health.verdict, "no-data");
  assert.equal(health.exceptions.total, 0);
  assert.equal(health.sessionDurationMs, null);
});

test("verdict escalates with the worst signal present", () => {
  const healthy = new RuntimeStore();
  frames(healthy, 20, 0);
  assert.equal(runtimeHealth(healthy, true).verdict, "healthy");

  const janky = new RuntimeStore();
  frames(janky, 20, 8);
  assert.equal(runtimeHealth(janky, true).verdict, "degraded");

  const failingNetwork = new RuntimeStore();
  frames(failingNetwork, 20, 0);
  request(failingNetwork, T, T + 100);
  assert.equal(runtimeHealth(failingNetwork, true).verdict, "degraded");

  const broken = new RuntimeStore();
  frames(broken, 20, 0);
  exception(broken, T);
  assert.equal(runtimeHealth(broken, true).verdict, "failing", "an exception outranks everything else");
});

test("health is compact but every problem it names is citable", () => {
  const store = new RuntimeStore();
  const boom = exception(store, T);
  const failure = request(store, T - 500, T - 100);
  frames(store, 20, 8);

  const health = runtimeHealth(store, true);
  assert.equal(health.exceptions.latest[0].eventId, boom.eventId);
  assert.equal(health.network.latestFailure?.eventId, failure.eventId);
  assert.equal(health.frames.janky, 8);
  assert.equal(health.frames.jankPercent, 40);
  assert.equal(health.frames.worstMs, 40);
  assert.ok(health.exceptions.latest.length <= 3, "health must stay a summary, not a dump");
});

test("health flags the conditions that qualify its own numbers", () => {
  const store = new RuntimeStore({ frame: 2 });
  frames(store, 10, 10);

  const disconnected = runtimeHealth(store, false, false);
  assert.ok(disconnected.notes.some((n) => n.includes("Not connected")));
  assert.ok(disconnected.notes.some((n) => n.includes("Retention limit reached")));
  assert.ok(disconnected.notes.some((n) => n.includes("pull-on-demand")));

  const reconnecting = runtimeHealth(store, false, true);
  assert.ok(reconnecting.notes.some((n) => n.includes("Reconnecting")));
});

test("memory growth is summarized as a percentage", () => {
  const store = new RuntimeStore();
  [100, 150, 200].forEach((mb, i) =>
    store.add({
      timestamp: T + i * 1_000,
      source: "getMemoryUsage",
      severity: "info",
      category: "system",
      message: `Heap ${mb}MB`,
      data: { heapUsageMB: mb, heapCapacityMB: 512 },
    }),
  );

  const health = runtimeHealth(store, true);
  assert.equal(health.memory.samples, 3);
  assert.equal(health.memory.latestHeapMB, 200);
  assert.equal(health.memory.growthPercent, 100);
});

test("what_changed anchors on the most recent exception by default", () => {
  const store = new RuntimeStore();
  request(store, T - 40_000, T - 39_000); // outside the window
  const recent = request(store, T - 1_000, T - 500);
  const boom = exception(store, T);

  const changed = whatChanged(store);
  assert.equal(changed.anchor?.eventId, boom.eventId);
  assert.equal(changed.toMs, T);
  assert.equal(changed.fromMs, T - 30_000);
  assert.deepEqual(
    changed.network.map((n) => n.eventId),
    [recent.eventId],
    "only requests near the failure are a change",
  );
});

test("what_changed catches a request that began before the window and failed inside it", () => {
  // The interval rule again: a request hanging for a minute and failing right
  // before the crash is the most important thing that changed.
  const store = new RuntimeStore();
  const hanging = request(store, T - 60_000, T - 200);
  exception(store, T);

  const changed = whatChanged(store, { windowMs: 30_000 });
  assert.deepEqual(
    changed.network.map((n) => n.eventId),
    [hanging.eventId],
  );
});

test("what_changed accepts an explicit anchor and reports an unknown one", () => {
  const store = new RuntimeStore();
  const first = exception(store, T, "first failure");
  exception(store, T + 10_000, "second failure");

  assert.equal(whatChanged(store, { eventId: first.eventId }).anchor?.message, "first failure");

  const fallback = whatChanged(store, { eventId: "exc_99999" });
  assert.equal(fallback.anchor?.message, "second failure", "falls back to the latest exception");
  assert.ok(fallback.notes.some((n) => n.includes("exc_99999")), "and says why");
});

test("what_changed reports connection events, so an outage is visible as a change", () => {
  const store = new RuntimeStore();
  store.add({
    timestamp: T - 5_000,
    source: "system",
    severity: "warning",
    category: "system",
    message: "VM Service connection closed",
    data: {},
  });
  exception(store, T);

  const changed = whatChanged(store);
  assert.ok(changed.system.some((e) => e.message.includes("connection closed")));
});

test("what_changed with no exception anywhere still answers, and says so", () => {
  const store = new RuntimeStore();
  store.add({
    timestamp: Date.now(),
    source: "Stdout",
    severity: "info",
    category: "log",
    message: "tick",
    data: {},
  });

  const changed = whatChanged(store);
  assert.equal(changed.anchor, null);
  assert.deepEqual(changed.timeline, []);
  assert.ok(changed.notes.some((n) => n.includes("No exception found")));
});
