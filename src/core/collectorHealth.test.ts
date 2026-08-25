import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "./runtimeStore.js";
import { NetworkCollector } from "../collectors/networkCollector.js";
import { RebuildCollector } from "../collectors/rebuildCollector.js";
import { runtimeHealth } from "../diagnosis/health.js";
import { diagnose } from "../diagnosis/engine.js";
import type { VmService } from "../vm/vmService.js";

/**
 * The honesty contract: an agent must be able to distinguish "no events" from
 * "events are invisible on this target". A collector that cannot see its
 * domain says so through health(), and that status reaches runtime_health.
 */

function vmWhere(behaviour: Record<string, () => any>): VmService {
  return {
    call: async (method: string) => {
      const fn = behaviour[method];
      if (!fn) return {};
      return fn();
    },
    streamListen: async () => {},
    on: () => {},
  } as unknown as VmService;
}

test("network collector reports unavailable when profiling is missing, and recovers on reset", async () => {
  const collector = new NetworkCollector();
  assert.deepEqual(collector.health(), { status: "active" });

  const noProfiling = vmWhere({
    "ext.dart.io.httpEnableTimelineLogging": () => {
      throw new Error("method not found");
    },
  });
  await collector.start(noProfiling, new RuntimeStore(), "iso-1");

  assert.equal(collector.health().status, "unavailable");
  assert.match(String(collector.health().detail), /requests are invisible here/);

  // A reconnect may land on a target where profiling works; stale blindness
  // must not carry over.
  collector.reset();
  assert.equal(collector.health().status, "active");
});

test("rebuild collector reports unavailable when widget creation is untracked", async () => {
  const collector = new RebuildCollector();
  const untracked = vmWhere({
    "ext.flutter.inspector.isWidgetCreationTracked": () => ({ result: false }),
  });
  await collector.start(untracked, new RuntimeStore(), "iso-1");

  assert.equal(collector.health().status, "unavailable");
  assert.match(String(collector.health().detail), /cannot be attributed/);
});

test("rebuild collector reports unavailable when the Inspector is absent", async () => {
  const collector = new RebuildCollector();
  const noInspector = vmWhere({
    "ext.flutter.inspector.isWidgetCreationTracked": () => {
      throw new Error("method not found");
    },
  });
  await collector.start(noInspector, new RuntimeStore(), "iso-1");

  assert.equal(collector.health().status, "unavailable");
  assert.match(String(collector.health().detail), /release build/);
});

test("runtime_health surfaces non-active collectors as notes, not just data", () => {
  const store = new RuntimeStore();
  const health = runtimeHealth(store, true, false, [
    { name: "network", status: "unavailable", detail: "profiling missing", eventsRetained: 0, lastEventMs: null },
    { name: "logs", status: "active", eventsRetained: 12, lastEventMs: 1_000 },
  ]);

  assert.equal(health.collectors.length, 2);
  assert.ok(
    health.notes.some((n) => n.includes('Collector "network" is unavailable')),
    "blindness must be called out where the agent reads first",
  );
  assert.ok(
    !health.notes.some((n) => n.includes('"logs"')),
    "active collectors are data, not noise",
  );
});

test("network events carry the runtime's own correlation id", async () => {
  const store = new RuntimeStore();
  const vm = vmWhere({
    "ext.dart.io.getHttpProfile": () => ({
      requests: [
        {
          id: "req-77",
          method: "GET",
          uri: "https://x/y",
          startTime: 1_700_000_000_000_000,
          endTime: 1_700_000_000_100_000,
          response: { statusCode: 200 },
        },
      ],
    }),
  });
  await new NetworkCollector().refresh(vm, store, "iso-1");

  const [event] = store.query({ category: "network" });
  assert.equal(event.correlationId, "req-77", "identity comes from the runtime, never invented");

  // No other collector has a real identity source, so nothing else sets one.
  const log = store.add({
    timestamp: Date.now(),
    source: "Stdout",
    severity: "info",
    category: "log",
    message: "hello",
    data: {},
  });
  assert.equal(log.correlationId, undefined);
});

test("diagnosis carries structured coverage of what it could and could not see", () => {
  const store = new RuntimeStore({ frame: 2 });
  store.add({
    timestamp: 1_000,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "boom",
    data: { stackTrace: "#0 ..." },
  });
  for (let i = 0; i < 5; i++) {
    store.add({
      timestamp: 2_000 + i,
      source: "Flutter.Frame",
      severity: "debug",
      category: "frame",
      message: `f${i}`,
      data: { janky: false, elapsedMs: 8 },
    });
  }

  const { coverage } = diagnose(store);
  assert.deepEqual(coverage.present.sort(), ["exception", "frame"]);
  assert.ok(coverage.empty.includes("network"));
  assert.ok(coverage.empty.includes("log"));
  assert.equal(coverage.evicted.frame, 3, "dropped evidence is declared, not hidden");
  assert.equal(coverage.oldestEventMs, 1_000);
  assert.equal(coverage.newestEventMs, 2_004);
});

test("an empty store still reports coverage instead of omitting it", () => {
  const { coverage, status } = diagnose(new RuntimeStore());
  assert.equal(status, "unknown");
  assert.deepEqual(coverage.present, []);
  assert.equal(coverage.empty.length, 7);
  assert.equal(coverage.oldestEventMs, null);
});
