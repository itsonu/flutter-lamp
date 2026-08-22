import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RuntimeStore } from "../core/runtimeStore.js";
import { NavigationCollector } from "../collectors/navigationCollector.js";
import { routeHistory, routeAt } from "./navigation.js";
import { runtimeHealth } from "./health.js";
import type { VmService } from "../vm/vmService.js";

const T = 1_700_000_000_000;

/** A VmService stand-in that lets a test push stream events. */
function fakeVm() {
  const emitter = new EventEmitter() as EventEmitter & VmService;
  (emitter as any).streamListen = async () => {};
  return emitter;
}

/**
 * The exact payload Flutter's Navigator posts, from
 * packages/flutter/lib/src/widgets/navigator.dart `_afterNavigation`.
 */
function navigationEvent(name: string | null, args?: string) {
  return {
    extensionKind: "Flutter.Navigation",
    extensionData: {
      route: {
        description: `MaterialPageRoute<dynamic>(${name})`,
        settings: { name, ...(args === undefined ? {} : { arguments: args }) },
      },
    },
  };
}

function push(store: RuntimeStore, category: any, at: number, message: string, data: any = {}) {
  return store.add({ timestamp: at, source: "test", severity: "error", category, message, data });
}

function navigateTo(store: RuntimeStore, name: string, at: number) {
  return store.add({
    timestamp: at,
    source: "Flutter.Navigation",
    severity: "info",
    category: "navigation",
    message: `Navigated to ${name}`,
    data: { name },
  });
}

test("the collector reads Flutter's real Navigation payload", async () => {
  const store = new RuntimeStore();
  const vm = fakeVm();
  await new NavigationCollector().start(vm, store);

  vm.emit("stream:Extension", navigationEvent("/checkout"));
  const [event] = store.query({ category: "navigation" });

  assert.equal(event.data.name, "/checkout");
  assert.equal(event.message, "Navigated to /checkout");
  assert.match(String(event.data.description), /MaterialPageRoute/);
  assert.equal(event.eventId.startsWith("nav_"), true);
});

test("a popped-past-last-route event is recorded, not dropped", async () => {
  const store = new RuntimeStore();
  const vm = fakeVm();
  await new NavigationCollector().start(vm, store);

  vm.emit("stream:Extension", { extensionKind: "Flutter.Navigation", extensionData: { route: null } });
  const [event] = store.query({ category: "navigation" });
  assert.equal(event.data.popped, true);
  assert.equal(event.data.name, null);
});

test("route arguments are redacted — they carry ids and tokens", async () => {
  const store = new RuntimeStore();
  const vm = fakeVm();
  await new NavigationCollector().start(vm, store);

  vm.emit(
    "stream:Extension",
    navigationEvent("/profile", "{token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aBcDeFgHiJkL}"),
  );
  const [event] = store.query({ category: "navigation" });
  assert.match(String(event.data.arguments), /\[REDACTED\]/);
  assert.ok(!String(event.data.arguments).includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("an unnamed route still produces a usable label", async () => {
  const store = new RuntimeStore();
  const vm = fakeVm();
  await new NavigationCollector().start(vm, store);

  vm.emit("stream:Extension", navigationEvent(null));
  const [event] = store.query({ category: "navigation" });
  assert.match(event.message, /MaterialPageRoute/);
});

test("evidence is attributed to the route that was on screen", () => {
  const store = new RuntimeStore();
  navigateTo(store, "/home", T);
  const homeCrash = push(store, "exception", T + 1_000, "home blew up");
  navigateTo(store, "/checkout", T + 5_000);
  const checkoutCrash = push(store, "exception", T + 6_000, "checkout blew up");
  push(store, "frame", T + 6_500, "janky", { janky: true, elapsedMs: 40 });

  const { visits, current } = routeHistory(store);
  assert.deepEqual(visits.map((v) => v.name), ["/checkout", "/home"], "newest visit first");

  const [checkout, home] = visits;
  assert.deepEqual(home.exceptions, [homeCrash.eventId]);
  assert.equal(home.durationMs, 5_000);
  assert.equal(home.current, false);

  assert.deepEqual(checkout.exceptions, [checkoutCrash.eventId]);
  assert.equal(checkout.jankyFrames, 1);
  assert.equal(checkout.durationMs, null, "the current route has no end yet");
  assert.equal(current?.name, "/checkout");
});

test("a request spanning a route change is attributed to both screens", () => {
  // Assigning it to one screen would hide it from whichever screen the user
  // actually saw fail.
  const store = new RuntimeStore();
  navigateTo(store, "/home", T);
  const spanning = store.add({
    timestamp: T + 1_000,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/cart → 500",
    data: { startTimeMs: T + 1_000, endTimeMs: T + 9_000 },
  });
  navigateTo(store, "/checkout", T + 5_000);

  const { visits } = routeHistory(store);
  for (const visit of visits) {
    assert.deepEqual(visit.networkFailures, [spanning.eventId], `${visit.name} should see the request`);
  }
});

test("routeAt answers which screen was active at a moment", () => {
  const store = new RuntimeStore();
  navigateTo(store, "/home", T);
  navigateTo(store, "/checkout", T + 5_000);

  assert.equal(routeAt(store, T - 1), null, "nothing was navigated to yet");
  assert.equal(routeAt(store, T + 100), "/home");
  assert.equal(routeAt(store, T + 6_000), "/checkout");
});

test("no navigation evidence is explained rather than left blank", () => {
  const report = routeHistory(new RuntimeStore());
  assert.equal(report.current, null);
  assert.deepEqual(report.visits, []);
  assert.ok(report.notes.some((n) => n.includes("release build")), "say why it might be empty");
});

test("runtime_health surfaces the current route", () => {
  const store = new RuntimeStore();
  navigateTo(store, "/checkout", T);
  push(store, "exception", T + 100, "boom");

  const health = runtimeHealth(store, true);
  assert.equal(health.currentRoute?.name, "/checkout");
  assert.equal(health.currentRoute?.exceptions, 1);
});

test("a diagnosis names the screen the exception happened on", async () => {
  const { diagnose } = await import("./engine.js");
  const store = new RuntimeStore();
  const nav = navigateTo(store, "/checkout", T);
  push(store, "exception", T + 1_000, "Null check operator used on a null value", {
    stackTrace: "#0 ...",
  });

  const d = diagnose(store);
  assert.match(d.summary, /on route \/checkout/, "the bug will be reported by screen, not by timestamp");
  assert.ok(
    d.evidence.some((e) => e.eventId === nav.eventId),
    "the route change is part of the cited evidence",
  );
});

test("a diagnosis without navigation evidence reads normally", () => {
  const store = new RuntimeStore();
  push(store, "exception", T, "boom", { stackTrace: "#0 ..." });
  return import("./engine.js").then(({ diagnose }) => {
    const d = diagnose(store);
    assert.ok(!d.summary.includes("on route"), "no route means no empty route phrase");
  });
});
