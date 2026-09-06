import { test } from "node:test";
import assert from "node:assert/strict";
import { TimelineCollector } from "./timelineCollector.js";
import { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * The collector's whole job is placing a monotonic-microsecond event on the
 * store's epoch axis without guessing. These tests are mostly about the cases
 * where it must refuse.
 */

interface FakeOpts {
  flags?: unknown;
  timeline?: unknown;
  micros?: unknown;
  clockOffsetMs?: number | null;
  failOn?: string[];
}

function fakeVm(o: FakeOpts = {}) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const vm = {
    clockOffsetMs: o.clockOffsetMs === undefined ? 0 : o.clockOffsetMs,
    calls,
    async call(method: string, params?: unknown) {
      calls.push({ method, params });
      if (o.failOn?.includes(method)) throw new Error(`-32601 Unknown method: ${method}`);
      if (method === "getVMTimelineFlags") return o.flags ?? { recordedStreams: [] };
      if (method === "getVMTimeline") return o.timeline ?? { traceEvents: [] };
      if (method === "getVMTimelineMicros") return o.micros ?? { timestamp: 10_000_000 };
      return {};
    },
  };
  return vm as unknown as VmService & { calls: typeof calls };
}

/**
 * A GC pause as the VM actually emits it: a Begin/End pair, no duration field.
 *
 * The first version of these fixtures used `ph: "X"` with a `dur`, matching what
 * the implementation assumed. A physical device produced 32,313 timeline events
 * containing no `X` phase at all, so the fixtures were agreeing with the bug.
 */
const gcPair = (tsMicros: number, durMs: number, name = "CollectNewGeneration", tid = 1) => [
  { name, cat: "GC", ph: "B", ts: tsMicros, tid },
  { name, cat: "GC", ph: "E", ts: tsMicros + durMs * 1000, tid },
];

test("GC recording is added to the existing streams, never substituted for them", async () => {
  // get_timeline deliberately turns on Dart/Compiler/Embedder. A collector that
  // replaced the set would silently break that tool.
  const vm = fakeVm({ flags: { recordedStreams: ["Dart", "Embedder"] } });
  await new TimelineCollector().start(vm, new RuntimeStore(), "isolates/1");
  const set = vm.calls.find((c) => c.method === "setVMTimelineFlags");
  assert.ok(set, "should configure the recorder");
  assert.deepEqual((set!.params as { recordedStreams: string[] }).recordedStreams, [
    "Dart",
    "Embedder",
    "GC",
  ]);
});

test("already-recording GC is left alone", async () => {
  const vm = fakeVm({ flags: { recordedStreams: ["GC"] } });
  await new TimelineCollector().start(vm, new RuntimeStore(), "isolates/1");
  assert.equal(vm.calls.some((c) => c.method === "setVMTimelineFlags"), false);
});

test("a target with no VM timeline reports unavailable, and stores nothing", async () => {
  const c = new TimelineCollector();
  const store = new RuntimeStore();
  const vm = fakeVm({ failOn: ["getVMTimelineFlags", "getVMTimeline"] });
  await c.start(vm, store, "isolates/1");
  assert.equal(c.health().status, "unavailable");
  // The wording has to distinguish invisible from absent, or an empty GC list
  // reads as "no garbage collection happened".
  assert.match(c.health().detail ?? "", /invisible here, not that none happened|neither ruled in nor out/);
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 0);
});

test("an empty timeline is not an error and stores nothing", async () => {
  const c = new TimelineCollector();
  const store = new RuntimeStore();
  const vm = fakeVm({ timeline: { traceEvents: [] } });
  await c.start(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 0);
  assert.equal(c.health().status, "active");
});

test("events are placed on the VM's epoch clock, not the host's", async () => {
  // The whole point. With a -839ms offset (the value measured on a real device)
  // an event 1s old must land 1s before the VM's now, which is 839ms before the
  // host's now — anchoring on Date.now() would put it in the wrong second.
  const store = new RuntimeStore();
  const c = new TimelineCollector();
  const nowMicros = 10_000_000;
  const vm = fakeVm({
    clockOffsetMs: -839,
    micros: { timestamp: nowMicros },
    timeline: { traceEvents: gcPair(nowMicros - 1_000_000, 4.5) },
  });
  await c.start(vm, store, "isolates/1");
  const before = Date.now();
  await c.refresh(vm, store, "isolates/1");
  const after = Date.now();

  const [e] = store.query({ category: "timeline" });
  assert.ok(e, "the GC event should be stored");
  const expectedLow = before - 839 - 1000;
  const expectedHigh = after - 839 - 1000;
  assert.ok(
    e.timestamp >= expectedLow && e.timestamp <= expectedHigh,
    `timestamp ${e.timestamp} should sit in [${expectedLow}, ${expectedHigh}] — VM epoch minus the event's age`,
  );
  assert.equal(e.data.durMs, 4.5);
  assert.equal(e.data.tsMicros, nowMicros - 1_000_000);
  assert.equal(e.category, "timeline");
  assert.equal(e.severity, "debug", "a GC pause is not a warning on its own");
  assert.match(e.eventId, /^tml_/);
});

test("without a clock offset nothing is stored, and health says why", async () => {
  // A GC pause with a guessed timestamp is worse than no GC pause: it would be
  // correlated against frames as if it were evidence.
  const store = new RuntimeStore();
  const c = new TimelineCollector();
  const vm = fakeVm({
    clockOffsetMs: null,
    timeline: { traceEvents: gcPair(9_000_000, 3) },
  });
  await c.start(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 0, "must not invent a timestamp");
  assert.equal(c.health().status, "degraded");
  assert.match(c.health().detail ?? "", /clock offset has not been observed/);
});

test("without the VM's timeline clock nothing is stored, and health says why", async () => {
  const store = new RuntimeStore();
  const c = new TimelineCollector();
  const vm = fakeVm({
    micros: { timestamp: "nope" },
    timeline: { traceEvents: gcPair(9_000_000, 3) },
  });
  await c.start(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 0);
  assert.equal(c.health().status, "degraded");
  assert.match(c.health().detail ?? "", /will not report its timeline clock/);
});

test("only outermost stop-the-world collections are kept", async () => {
  const store = new RuntimeStore();
  const c = new TimelineCollector();
  const vm = fakeVm({
    timeline: {
      traceEvents: [
        ...gcPair(9_000_000, 3),
        // Not GC at all.
        { name: "Frame", cat: "Dart", ph: "B", ts: 9_100_000, tid: 1 },
        { name: "Frame", cat: "Dart", ph: "E", ts: 9_105_000, tid: 1 },
        // GC, but concurrent rather than stop-the-world. Measured at up to 63ms
        // on device; counting it would attribute a stall that never happened.
        ...gcPair(9_200_000, 40, "ConcurrentMark"),
        // GC, but a phase nested inside a collection — counting it as well as
        // its parent double-counts the same pause.
        ...gcPair(9_300_000, 1.5, "Scavenge"),
        // An End whose Begin was evicted from the ring buffer: no duration.
        { name: "CollectOldGeneration", cat: "GC", ph: "E", ts: 9_400_000, tid: 1 },
        // A collection still running: Begin with no End yet.
        { name: "CollectOldGeneration", cat: "GC", ph: "B", ts: 9_500_000, tid: 2 },
      ],
    },
  });
  await c.start(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 1);
  assert.equal(store.query({ category: "timeline" })[0].data.name, "CollectNewGeneration");
});

test("refresh is idempotent — the VM returns its whole buffer every read", async () => {
  const store = new RuntimeStore();
  const c = new TimelineCollector();
  const vm = fakeVm({ timeline: { traceEvents: [...gcPair(9_000_000, 3), ...gcPair(9_500_000, 2)] } });
  await c.start(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 2, "the same events must not be stored three times");
});

test("reset clears the dedup set, because monotonic timestamps restart", async () => {
  const store = new RuntimeStore();
  const c = new TimelineCollector();
  const vm = fakeVm({ timeline: { traceEvents: gcPair(1_000, 3) } });
  await c.start(vm, store, "isolates/1");
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 1);
  // A new app run starts its monotonic clock at zero again; without the reset
  // the new session's first GC looks like a duplicate of the old session's.
  c.reset();
  await c.refresh(vm, store, "isolates/1");
  assert.equal(store.counts().timeline, 2);
});
