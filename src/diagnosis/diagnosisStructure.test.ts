import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { diagnose } from "./engine.js";

const T = 1_700_000_000_000;

function jankyFrames(store: RuntimeStore, count: number, at = T) {
  for (let i = 0; i < count; i++) {
    store.add({
      timestamp: at + i,
      source: "Flutter.Frame",
      severity: "error",
      category: "frame",
      message: `Frame #${i} 40.0ms (jank)`,
      data: { janky: true, elapsedMs: 40, buildMs: 30, rasterMs: 10 },
    });
  }
}

function memorySamples(store: RuntimeStore, values: number[], at = T) {
  values.forEach((mb, i) =>
    store.add({
      timestamp: at + i * 2_000,
      source: "getMemoryUsage",
      severity: "info",
      category: "system",
      message: `Heap ${mb}MB`,
      data: { heapUsageMB: mb, heapCapacityMB: 512, externalUsageMB: 0 },
    }),
  );
}

test("a slow failing request reaches the diagnosis as evidence for the exception", () => {
  // End to end for the interval fix: this request starts far outside the
  // correlation window and returns just inside it.
  const store = new RuntimeStore();
  const slow = store.add({
    timestamp: T - 30_000,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/user → 500",
    data: { startTimeMs: T - 30_000, endTimeMs: T - 200, uri: "/api/user", statusCode: 500 },
  });
  store.add({
    timestamp: T,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: { stackTrace: "#0 ...", library: "widgets library" },
  });

  const d = diagnose(store);
  assert.equal(d.status, "diagnosed");
  assert.ok(
    d.evidence.some((e) => e.eventId === slow.eventId),
    "the request that failed just before the exception must be cited",
  );
  assert.ok(
    d.recommendedFixes.some((f) => f.includes("/api/user")),
    "and it must inform the recommended fix",
  );
});

test("confidence is broken down, and says what it is not", () => {
  const store = new RuntimeStore();
  jankyFrames(store, 12);

  const { confidenceBreakdown: c, confidence } = diagnose(store);
  assert.equal(c.evidenceStrength, confidence);
  assert.ok(c.dataCompleteness > 0 && c.dataCompleteness <= 1);
  assert.equal(c.alternativeStrength, 0, "nothing else explains this");
  assert.match(c.basis, /not a calibrated probability/);
});

test("competing explanations are reported instead of being silently dropped", () => {
  const store = new RuntimeStore();
  jankyFrames(store, 12);
  store.add({
    timestamp: T + 100,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "RenderFlex overflowed by 42 pixels",
    data: { stackTrace: "#0 ..." },
  });

  const d = diagnose(store);
  assert.equal(d.rootCause, "RenderFlex overflowed by 42 pixels", "an exception outranks a jank pattern");
  assert.equal(d.alternativeCauses.length, 1);
  assert.match(d.alternativeCauses[0].rootCause, /Dropped frames/);
  assert.ok(d.alternativeCauses[0].strength > 0);
  assert.ok(d.alternativeCauses[0].evidence.every((id) => id.startsWith("frm_")));
  assert.equal(d.confidenceBreakdown.alternativeStrength, d.alternativeCauses[0].strength);
});

test("sustained heap growth is offered as an alternative, never as the headline", () => {
  const store = new RuntimeStore();
  memorySamples(store, [100, 160, 240]);
  store.add({
    timestamp: T + 10_000,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Out of memory",
    data: {},
  });

  const d = diagnose(store);
  assert.equal(d.rootCause, "Out of memory");
  assert.ok(
    d.alternativeCauses.some((a) => /heap growth/i.test(a.rootCause)),
    "memory growth should be raised as a competing explanation",
  );
});

test("heap growth alone is reported cautiously, with the caveat attached", () => {
  const store = new RuntimeStore();
  memorySamples(store, [100, 180, 260]);

  const d = diagnose(store);
  assert.match(d.rootCause, /heap growth/i);
  assert.ok(
    d.recommendedFixes.some((f) => f.includes("not proof of a leak")),
    "growth is not a leak and the output must say so",
  );
});

test("the timeline puts the cited evidence in order around the root cause", () => {
  const store = new RuntimeStore();
  store.add({
    timestamp: T - 1_000,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/user → 500",
    data: { startTimeMs: T - 1_000, endTimeMs: T - 900, uri: "/api/user" },
  });
  store.add({
    timestamp: T,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: {},
  });

  const { timeline } = diagnose(store);
  assert.deepEqual(timeline.map((e) => e.relation), ["preceded", "anchor"]);
  assert.ok(timeline[0].timestamp < timeline[1].timestamp);
});

test("limitations name what the diagnosis could not see", () => {
  const store = new RuntimeStore({ frame: 2 });
  jankyFrames(store, 12); // forces eviction

  const { limitations } = diagnose(store);
  assert.ok(limitations.some((l) => l.includes("Retention limit reached")), "dropped evidence must be declared");
  assert.ok(limitations.some((l) => l.includes("No network evidence")));
  assert.ok(limitations.some((l) => l.includes("No memory samples")));
  assert.ok(limitations.some((l) => l.includes("VM timeline events")));
  assert.ok(limitations.some((l) => l.includes("platform (Kotlin/Swift) code")));
});

test("an empty store reports unknown, with limitations still populated", () => {
  const d = diagnose(new RuntimeStore());
  assert.equal(d.status, "unknown");
  assert.equal(d.confidence, 0.3);
  assert.deepEqual(d.evidence, []);
  assert.deepEqual(d.timeline, []);
  assert.deepEqual(d.alternativeCauses, []);
  assert.ok(d.limitations.length > 0);
  assert.equal(d.confidenceBreakdown.dataCompleteness, 0);
});

test("activity with no problem in it is reported as unknown, not as a cause", () => {
  const store = new RuntimeStore();
  for (let i = 0; i < 5; i++) {
    store.add({
      timestamp: T + i,
      source: "Stdout",
      severity: "info",
      category: "log",
      message: `tick ${i}`,
      data: {},
    });
  }

  const d = diagnose(store);
  assert.equal(d.status, "unknown");
  assert.match(d.summary, /no exceptions, jank pattern, or network errors/);
});
