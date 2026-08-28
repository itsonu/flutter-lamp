import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { whatChanged } from "./health.js";

/**
 * Windows are sliced on the app's clock, not on ours.
 *
 * Collectors stamp events with the time the VM posted them, and the VM's clock
 * is not this process's. Measured against a phone over adb, it ran 839ms
 * behind — small, but the offset is whatever the device's clock says, and a
 * badly-set device is not exotic. A window anchored on `Date.now()` slides off
 * the timeline it is slicing by exactly that much, and the failure is silent:
 * empty windows read as "nothing changed", not as "I compared the wrong
 * interval".
 */

/** A session recorded by a device whose clock is `skewMs` away from ours. */
function sessionWithSkew(skewMs: number): RuntimeStore {
  const store = new RuntimeStore();
  const deviceNow = Date.now() + skewMs;
  // Inserted newest-first on purpose. That is how a DDS backlog arrives — drain
  // order, with each event keeping the time the app posted it — so insertion
  // order and app time disagree, which is the case that broke the first
  // attempt at this fix.
  for (let i = 0; i < 40; i++) {
    store.add({
      timestamp: deviceNow - i * 200, // the newest 8 seconds of app activity
      source: "Flutter.Frame",
      severity: i % 4 === 0 ? "warning" : "debug",
      category: "frame",
      message: `Frame #${i}`,
      data: { elapsedMs: i % 4 === 0 ? 40 : 8, buildMs: 5, rasterMs: 2, janky: i % 4 === 0 },
    });
  }
  return store;
}

test("a window with no anchor covers the app's activity, not our clock's", () => {
  // An hour behind: the shape of a device whose time is simply wrong. Anchored
  // on Date.now() the window would sit an hour after every event and contain
  // nothing at all.
  const store = sessionWithSkew(-60 * 60 * 1000);
  const changed = whatChanged(store, { windowMs: 30_000 });

  assert.equal(changed.anchor, null, "no exception, so this exercises the fallback");
  assert.ok(
    changed.frames.total > 0,
    `window [${changed.fromMs}, ${changed.toMs}] captured no frames from a session that has 40`,
  );
  assert.match(changed.notes.join(" "), /most recent captured event/);
});

test("the same holds when the device clock runs ahead", () => {
  const store = sessionWithSkew(90 * 60 * 1000);
  const changed = whatChanged(store, { windowMs: 30_000 });
  assert.ok(changed.frames.total > 0, "a device ahead of us must not empty the window either");
});

test("a small real-world skew does not shift the window off the events", () => {
  // The offset actually measured on the device, rather than a pathological one.
  const store = sessionWithSkew(-839);
  const changed = whatChanged(store, { windowMs: 30_000 });
  assert.equal(changed.frames.total, 40, "every frame in an 8s session belongs in a 30s window");
});

test("with nothing captured at all there is nothing to be wrong about", () => {
  const changed = whatChanged(new RuntimeStore(), { windowMs: 30_000 });
  assert.equal(changed.frames.total, 0);
  assert.match(changed.notes.join(" "), /nothing captured/);
});
