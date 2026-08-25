import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RuntimeStore } from "../core/runtimeStore.js";
import { StateCollector } from "./stateCollector.js";
import { diagnosePerformance } from "../diagnosis/performance.js";
import type { VmService } from "../vm/vmService.js";

/** Emits its backlog on subscribe, as the real VM Service does. */
function backlogVm(events: unknown[]): VmService {
  const emitter = new EventEmitter() as EventEmitter & VmService;
  (emitter as any).streamListen = async () => {
    for (const e of events) emitter.emit("stream:Extension", e);
  };
  (emitter as any).call = async () => ({});
  return emitter;
}

test("state changes are captured from every framework that announces them", async () => {
  const store = new RuntimeStore();
  const collector = new StateCollector();
  await collector.start(
    backlogVm([
      // The exact payloads measured on real apps: a pointer, never a value.
      { extensionKind: "riverpod:new_event", extensionData: { offset: 42 } },
      { extensionKind: "provider:provider_changed", extensionData: { id: "0" } },
      { extensionKind: "bloc:transition", extensionData: {} },
      { extensionKind: "Flutter.Frame", extensionData: { elapsed: 8000 } },
    ]),
    store,
  );

  const events = store.query({ category: "state" });
  assert.equal(events.length, 3, "frames are not state changes");
  assert.deepEqual(
    events.map((e) => e.data.framework).sort(),
    ["bloc", "provider", "riverpod"],
  );
  assert.equal(
    events.every((e) => e.data.valuesAvailable === false),
    true,
    "every event must state that the value is not readable",
  );
  assert.equal(store.query({ category: "state" })[0].eventId.startsWith("stt_"), true);
});

test("the opaque pointer is kept, since it distinguishes one provider from another", async () => {
  const store = new RuntimeStore();
  await new StateCollector().start(
    backlogVm([
      { extensionKind: "provider:provider_changed", extensionData: { id: "7" } },
      { extensionKind: "riverpod:new_event", extensionData: { offset: 99 } },
    ]),
    store,
  );
  // Newest-first: the riverpod offset, then the provider id. Both kept as the
  // runtime gave them — a numeric offset and a string id.
  const refs = store.query({ category: "state" }).map((e) => e.data.providerRef);
  assert.deepEqual(refs, [99, "7"], "ids and offsets both survive, untouched");
});

test("health names the frameworks actually observed, and resets with the session", async () => {
  const collector = new StateCollector();
  // Before anything arrives, silence is ambiguous and must be described as such.
  assert.match(String(collector.health().detail), /looks identical here/);

  await collector.start(
    backlogVm([{ extensionKind: "provider:provider_changed", extensionData: { id: "0" } }]),
    new RuntimeStore(),
  );
  assert.match(String(collector.health().detail), /Observing provider/);

  collector.reset();
  assert.match(String(collector.health().detail), /looks identical here/);
});

function frames(store: RuntimeStore, count: number, janky: boolean, at: number) {
  for (let i = 0; i < count; i++) {
    store.add({
      timestamp: at + i * 16,
      source: "Flutter.Frame",
      severity: janky ? "error" : "debug",
      category: "frame",
      message: "f",
      data: { janky, elapsedMs: janky ? 44 : 7, buildMs: janky ? 30 : 4, rasterMs: 4 },
    });
  }
}

function stateChanges(store: RuntimeStore, count: number, at: number) {
  for (let i = 0; i < count; i++) {
    store.add({
      timestamp: at + i,
      source: "provider:provider_changed",
      severity: "debug",
      category: "state",
      message: "provider state changed",
      data: { framework: "provider", providerRef: "0", valuesAvailable: false },
    });
  }
}

function rebuilds(store: RuntimeStore, frameCount: number, at: number) {
  for (let i = 0; i < frameCount; i++) {
    store.add({
      timestamp: at + i * 16,
      source: "Flutter.RebuiltWidgets",
      severity: "debug",
      category: "rebuild",
      message: "r",
      data: {
        frameNumber: i,
        totalRebuilds: 40,
        top: [{ widget: "Counter", file: "lib/counter.dart", line: 12, count: 40, appCode: true }],
        truncated: false,
      },
    });
  }
}

const T = 1_700_000_000_000;

test("a state-change burst alongside rebuilds is reported as co-occurrence", () => {
  const store = new RuntimeStore();
  frames(store, 60, false, T);
  frames(store, 40, true, T + 10_000);
  rebuilds(store, 6, T + 10_000);
  stateChanges(store, 120, T + 10_000);

  const finding = diagnosePerformance(store).findings.find((f) => /state change/.test(f.claim));
  assert.ok(finding, "a burst this size should be surfaced");
  assert.match(finding.claim, /120 provider state change\(s\)/);
  assert.match(finding.claim, /state changes per rebuilding frame/);
  assert.ok(finding.strength <= 0.7, "co-occurrence is a lead, never proof");

  // The one thing it must never do is name a provider it cannot see.
  assert.match(finding.fix, /not visible from the runtime/);
  assert.ok(!/UserProvider|CounterCubit|CounterBloc/.test(finding.claim));
});

test("a handful of state changes is not a story", () => {
  const store = new RuntimeStore();
  frames(store, 60, false, T);
  frames(store, 40, true, T + 10_000);
  rebuilds(store, 6, T + 10_000);
  stateChanges(store, 3, T + 10_000);

  const finding = diagnosePerformance(store).findings.find((f) => /state change/.test(f.claim));
  assert.equal(finding, undefined, "three changes is noise, not a burst");
});

test("limitations distinguish 'no state framework' from 'values unreadable'", () => {
  const quiet = new RuntimeStore();
  frames(quiet, 60, false, T);
  frames(quiet, 40, true, T + 10_000);
  assert.ok(
    diagnosePerformance(quiet).limitations.some((l) => l.includes("No state-management activity observed")),
    "silence must be explained, not left blank",
  );

  const active = new RuntimeStore();
  frames(active, 60, false, T);
  frames(active, 40, true, T + 10_000);
  stateChanges(active, 20, T + 10_000);
  assert.ok(
    diagnosePerformance(active).limitations.some((l) => l.includes("counted, never read")),
    "when observed, the ceiling on what is known must be stated",
  );
});
