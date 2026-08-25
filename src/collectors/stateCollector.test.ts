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

test("riverpod activity is recorded, with the offset it actually sent", async () => {
  const store = new RuntimeStore();
  await new StateCollector().start(
    backlogVm([{ extensionKind: "riverpod:new_event", extensionData: { offset: 42 } }]),
    store,
  );

  const [event] = store.query({ category: "state" });
  assert.equal(event.data.framework, "riverpod");
  assert.equal(event.data.providerRef, 42);
  assert.equal(event.data.valuesAvailable, false, "the value is never available and must say so");
  assert.equal(event.eventId.startsWith("stt_"), true);
});

test("a riverpod event with no usable offset still counts", async () => {
  const store = new RuntimeStore();
  await new StateCollector().start(
    backlogVm([{ extensionKind: "riverpod:new_event", extensionData: {} }]),
    store,
  );
  // The activity happened; only its pointer is missing.
  assert.equal(store.counts().state, 1);
  assert.equal(store.query({ category: "state" })[0].data.providerRef, undefined);
});

test("Bloc changes are captured, attributed to provider — the thing that emitted them", async () => {
  // Measured against probe/bloc_probe on flutter_bloc 9.1.1: 20 printed Bloc
  // transitions alongside 1,220 provider:provider_changed events, each burst
  // following a transition marker. bloc itself posts nothing, but flutter_bloc
  // depends transitively on provider, which does. Attributing these to "bloc"
  // would credit a package that sent no event.
  const store = new RuntimeStore();
  const collector = new StateCollector();
  await collector.start(
    backlogVm([
      { extensionKind: "provider:provider_changed", extensionData: { id: "0" } },
      { extensionKind: "provider:provider_changed", extensionData: { id: "1" } },
    ]),
    store,
  );

  assert.equal(store.counts().state, 2, "a Bloc app is not invisible");
  assert.equal(store.query({ category: "state" })[0].data.framework, "provider");
  assert.match(String(collector.health().detail), /Observing provider/);
});

test("nothing else on the Extension stream is treated as state activity", async () => {
  const store = new RuntimeStore();
  await new StateCollector().start(
    backlogVm([
      { extensionKind: "Flutter.Frame", extensionData: { elapsed: 8000 } },
      { extensionKind: "Flutter.Navigation", extensionData: { route: null } },
      { extensionKind: "HttpTimelineLoggingStateChange", extensionData: {} },
    ]),
    store,
  );
  assert.equal(store.counts().state, 0);
});

test("health explains an empty result instead of implying the app has no state", async () => {
  const collector = new StateCollector();
  const quiet = collector.health();
  assert.equal(quiet.status, "active", "the collector is working; the app is simply quiet");
  assert.match(String(quiet.detail), /look the same from here/);
  // The Bloc caveat matters most here: an empty list must never be read as
  // proof that an app has no blocs.
  assert.match(String(quiet.detail), /never proves an app has no blocs/);

  await collector.start(
    backlogVm([{ extensionKind: "riverpod:new_event", extensionData: { offset: 1 } }]),
    new RuntimeStore(),
  );
  assert.match(String(collector.health().detail), /Observing riverpod/);
  assert.match(String(collector.health().detail), /not a provider name or value/);

  collector.reset();
  assert.match(String(collector.health().detail), /look the same from here/);
});

const T = 1_700_000_000_000;

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

test("a state-change burst alongside rebuilds is reported as co-occurrence", () => {
  const store = new RuntimeStore();
  frames(store, 60, false, T);
  frames(store, 40, true, T + 10_000);
  rebuilds(store, 6, T + 10_000);
  stateChanges(store, 120, T + 10_000);

  const finding = diagnosePerformance(store).findings.find((f) => /state activity/.test(f.claim));
  assert.ok(finding, "a burst this size should be surfaced");
  // The claim is about janky frames near state activity, not raw volume — a
  // falsifiable statement rather than two counts side by side.
  assert.match(finding.claim, /janky frames .* fell within 1000ms of provider state activity/);
  assert.ok(finding.strength <= 0.5, "provider churn and expensive builds both follow the same tap");

  // The one thing it must never do is name a provider it cannot see.
  assert.match(finding.fix, /not observable from here/);
  assert.ok(!/UserProvider|CounterCubit|CounterBloc/.test(finding.claim));
});

test("a handful of state changes is not a story", () => {
  const store = new RuntimeStore();
  frames(store, 60, false, T);
  frames(store, 40, true, T + 10_000);
  rebuilds(store, 6, T + 10_000);
  stateChanges(store, 3, T - 600_000);

  // Three events an hour before the jank cannot be near it.
  assert.equal(
    diagnosePerformance(store).findings.find((f) => /state activity/.test(f.claim)),
    undefined,
    "state activity nowhere near the janky frames is not a finding",
  );
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
