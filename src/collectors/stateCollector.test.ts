import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RuntimeStore } from "../core/runtimeStore.js";
import { StateCollector } from "./stateCollector.js";
import { stateActivity } from "../diagnosis/stateActivity.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Payloads here are copied from a real measurement, not invented: they are the
 * exact shapes `probe/measure.mjs` recorded from `probe/riverpod_probe`
 * (flutter_riverpod 3.4.2) and `probe/bloc_probe` (flutter_bloc 9.1.1).
 */

/** A VmService stand-in that records subscriptions and replays events. */
function fakeVm(): VmService & { emitExtension(kind: string, data: unknown): void; streams: string[] } {
  const emitter = new EventEmitter() as any;
  emitter.streams = [];
  emitter.streamListen = async (streamId: string) => {
    emitter.streams.push(streamId);
  };
  emitter.emitExtension = (extensionKind: string, extensionData: unknown) =>
    emitter.emit("stream:Extension", { extensionKind, extensionData });
  return emitter;
}

async function collectorWithStore() {
  const vm = fakeVm();
  const store = new RuntimeStore();
  store.beginSession();
  const collector = new StateCollector();
  await collector.start(vm, store);
  return { vm, store, collector };
}

test("riverpod activity is recorded as state events", async () => {
  const { vm, store, collector } = await collectorWithStore();

  vm.emitExtension("riverpod:new_event", { offset: 27 });
  vm.emitExtension("riverpod:new_event", { offset: 28 });

  const events = store.query({ category: "state" });
  assert.equal(events.length, 2);
  assert.equal(events[0].source, "riverpod:new_event");
  assert.equal(events[0].category, "state");
  assert.equal(events[0].severity, "debug");
  assert.equal(events[0].data.framework, "riverpod");
  assert.equal(events[0].data.offset, 28);
  assert.match(events[0].eventId, /^stt_/);
  assert.equal(collector.health().status, "degraded");
});

test("a riverpod event with no usable offset still counts, with a null offset", async () => {
  const { vm, store } = await collectorWithStore();
  vm.emitExtension("riverpod:new_event", {});
  const [event] = store.query({ category: "state" });
  // The activity happened; only its (meaningless anyway) identity is missing.
  assert.equal(event.data.offset, null);
});

test("nothing else on the Extension stream is treated as state activity", async () => {
  const { vm, store } = await collectorWithStore();

  vm.emitExtension("Flutter.Frame", { number: 122, elapsed: 37095, build: 34281 });
  vm.emitExtension("Flutter.Navigation", { route: { settings: { name: "/detail" } } });

  assert.equal(store.query({ category: "state" }).length, 0);
});

test("with no activity, health says state is unobservable rather than absent", async () => {
  const { collector } = await collectorWithStore();
  const health = collector.health();
  assert.equal(health.status, "unavailable");
  // The bloc half of the answer must be in the detail: an agent reading zero
  // state events for a Bloc app would otherwise conclude the app has no state.
  assert.match(String(health.detail), /Bloc/);
});

test("reset drops the framework seen in the previous session", async () => {
  const { vm, collector } = await collectorWithStore();
  vm.emitExtension("riverpod:new_event", { offset: 1 });
  assert.equal(collector.health().status, "degraded");

  collector.reset();
  assert.equal(collector.health().status, "unavailable");
});

test("bloc transitions produce nothing, because bloc posts nothing", async () => {
  const { vm, store } = await collectorWithStore();

  // There is no bloc extensionKind to emit — this is the measured finding.
  // The closest thing a Bloc app produces is a debugPrint from a BlocObserver,
  // which arrives on Stdout as an ordinary log line and must not be mistaken
  // for state evidence.
  vm.emitExtension("bloc:transition", { bloc: "CounterBloc", from: 0, to: 1 });

  assert.equal(store.query({ category: "state" }).length, 0);
});

test("state activity co-occurring with build-heavy frames is reported as co-occurrence", async () => {
  const { vm, store } = await collectorWithStore();
  const base = Date.now();

  // Two build-heavy frames; only the first has provider activity beside it.
  store.add({
    timestamp: base,
    source: "Flutter.Frame",
    severity: "warning",
    category: "frame",
    message: "janky",
    data: { buildMs: 34.2, rasterMs: 1.9, janky: true },
  });
  vm.emitExtension("riverpod:new_event", { offset: 1 });

  store.add({
    timestamp: base + 60_000,
    source: "Flutter.Frame",
    severity: "warning",
    category: "frame",
    message: "janky",
    data: { buildMs: 40.0, rasterMs: 2.0, janky: true },
  });

  const report = stateActivity(store);
  assert.deepEqual(report.frameworks, ["riverpod"]);
  assert.equal(report.totalEvents, 1);
  assert.equal(report.coOccurrence.buildHeavyFrames, 2);
  assert.equal(report.coOccurrence.withStateActivity, 1);
  assert.equal(report.coOccurrence.ratio, 0.5);
  assert.equal(report.coOccurrence.evidence.length, 1);
  assert.ok(report.limitations.some((l) => l.includes("not causation")));
});

test("an empty store explains the emptiness instead of implying quiet", () => {
  const store = new RuntimeStore();
  store.beginSession();
  const report = stateActivity(store);
  assert.equal(report.totalEvents, 0);
  assert.deepEqual(report.frameworks, []);
  assert.equal(report.coOccurrence.ratio, null);
  assert.ok(report.notes.some((n) => n.includes("runtime_health")));
});
