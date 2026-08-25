import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RuntimeStore } from "../core/runtimeStore.js";
import { FrameCollector } from "./frameCollector.js";
import { NavigationCollector } from "./navigationCollector.js";
import { ExceptionCollector } from "./exceptionCollector.js";
import { LogCollector } from "./logCollector.js";
import { RebuildCollector } from "./rebuildCollector.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Regression guard for subscription ordering.
 *
 * The VM Service, through DDS, delivers a backlog of buffered stream events the
 * instant a subscription is accepted. A collector that registers its handler
 * *after* awaiting `streamListen` misses that burst entirely — which is the
 * whole history of an app that was already running when the session connected,
 * the normal case for this tool. Measured on a real device as 622 events
 * against 0.
 *
 * This VM stand-in reproduces that behaviour: `streamListen` flushes the
 * backlog before it resolves, so a collector only sees those events if it
 * subscribed last.
 */
function backlogVm(backlog: Record<string, unknown[]>): VmService {
  const emitter = new EventEmitter() as EventEmitter & VmService;
  (emitter as any).streamListen = async (streamId: string) => {
    for (const event of backlog[streamId] ?? []) emitter.emit(`stream:${streamId}`, event);
  };
  (emitter as any).call = async (method: string) => {
    if (method === "ext.flutter.inspector.isWidgetCreationTracked") return { result: true };
    if (method === "ext.flutter.inspector.widgetLocationIdMap") {
      return {
        result: {
          "file:///app/lib/home.dart": { ids: [7], lines: [42], columns: [3], names: ["HomeScreen"] },
        },
      };
    }
    return {};
  };
  return emitter;
}

test("FrameCollector captures the backlog delivered on subscribe", async () => {
  const store = new RuntimeStore();
  const vm = backlogVm({
    Extension: [
      { extensionKind: "Flutter.Frame", extensionData: { number: 1, elapsed: 40_000, build: 30_000, raster: 8_000 } },
      { extensionKind: "Flutter.Frame", extensionData: { number: 2, elapsed: 8_000, build: 4_000, raster: 3_000 } },
    ],
  });

  await new FrameCollector().start(vm, store);

  assert.equal(store.counts().frame, 2, "frames buffered before connecting must not be lost");
  assert.equal(store.query({ category: "frame" })[0].data.janky, false);
});

test("NavigationCollector captures route history that predates the connection", async () => {
  const store = new RuntimeStore();
  const vm = backlogVm({
    Extension: [
      {
        extensionKind: "Flutter.Navigation",
        extensionData: { route: { description: "MaterialPageRoute(/home)", settings: { name: "/home" } } },
      },
    ],
  });

  await new NavigationCollector().start(vm, store);

  assert.equal(store.counts().navigation, 1, "the route the user is already on must be captured");
  assert.equal(store.query({ category: "navigation" })[0].data.name, "/home");
});

test("ExceptionCollector captures exceptions thrown before the session began", async () => {
  const store = new RuntimeStore();
  const vm = backlogVm({
    Extension: [
      {
        extensionKind: "Flutter.Error",
        extensionData: {
          type: "FlutterErrorDetails",
          properties: [{ description: "Null check operator used on a null value", level: "summary", type: "ErrorSummary" }],
        },
      },
    ],
    Debug: [],
  });

  await new ExceptionCollector().start(vm, store);

  assert.equal(store.counts().exception, 1, "an exception is the evidence most worth not losing");
});

test("LogCollector captures buffered console output", async () => {
  const store = new RuntimeStore();
  const vm = backlogVm({
    Stdout: [{ kind: "WriteEvent", bytes: Buffer.from("already running\n").toString("base64") }],
    Stderr: [],
    Logging: [],
  });

  await new LogCollector().start(vm, store);

  assert.equal(store.counts().log, 1);
  assert.equal(store.query({ category: "log" })[0].message, "already running");
});

test("RebuildCollector captures buffered rebuild events after its setup RPCs", async () => {
  // This one subscribes only after several awaited RPCs, so it is the most
  // exposed to the ordering bug.
  const store = new RuntimeStore();
  const vm = backlogVm({
    Extension: [
      {
        extensionKind: "Flutter.RebuiltWidgets",
        extensionData: { frameNumber: 9, events: [7, 12], locations: {}, newLocations: {} },
      },
    ],
  });

  await new RebuildCollector().start(vm, store, "iso-1");

  assert.equal(store.counts().rebuild, 1);
  const [event] = store.query({ category: "rebuild" });
  assert.equal(event.data.totalRebuilds, 12);
  // And the seeded location table resolved the id, rather than "unknown".
  assert.equal((event.data.top as any[])[0].widget, "HomeScreen");
});
