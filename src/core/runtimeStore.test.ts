import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore, DEFAULT_CAPACITIES } from "./runtimeStore.js";
import type { Category, Severity } from "./events.js";

function push(
  store: RuntimeStore,
  category: Category,
  message: string,
  opts: { severity?: Severity; timestamp?: number } = {},
) {
  return store.add({
    timestamp: opts.timestamp ?? Date.now(),
    source: "test",
    severity: opts.severity ?? "info",
    category,
    message,
    data: {},
  });
}

test("a frame flood cannot evict exceptions, network or logs", () => {
  const store = new RuntimeStore();
  push(store, "exception", "the exception we care about");
  push(store, "network", "GET /api/user 500");
  push(store, "log", "something worth keeping");

  // Two minutes of 60fps — the old shared 5,000-event buffer lost everything
  // older than roughly the last 83 seconds.
  for (let i = 0; i < 7_200; i++) push(store, "frame", `frame ${i}`);

  assert.equal(store.query({ category: "exception" }).length, 1);
  assert.equal(store.query({ category: "network" }).length, 1);
  assert.equal(store.query({ category: "log" }).length, 1);
  assert.equal(
    store.query({ category: "exception" })[0].message,
    "the exception we care about",
  );
});

test("each category is capped independently and eviction is reported", () => {
  const store = new RuntimeStore({ frame: 10, exception: 5 });
  for (let i = 0; i < 25; i++) push(store, "frame", `frame ${i}`);
  for (let i = 0; i < 7; i++) push(store, "exception", `exception ${i}`);

  const retention = store.retention();
  assert.equal(retention.capacity.frame, 10);
  assert.equal(retention.retained.frame, 10);
  assert.equal(retention.evicted.frame, 15);
  assert.equal(retention.retained.exception, 5);
  assert.equal(retention.evicted.exception, 2);
  assert.equal(retention.evicted.log, 0);

  // Oldest survivors, newest first.
  assert.equal(store.query({ category: "frame" })[0].message, "frame 24");
  assert.equal(store.query({ category: "frame" }).at(-1)?.message, "frame 15");
  assert.equal(store.counts().frame, 10);
  assert.equal(store.size(), 15);
});

test("retention reports capacity and the oldest event still held", () => {
  const store = new RuntimeStore();
  assert.equal(store.retention().oldestEventMs, null, "empty store has no history");
  assert.deepEqual(store.retention().capacity, DEFAULT_CAPACITIES);

  push(store, "log", "first", { timestamp: 1_000 });
  push(store, "exception", "second", { timestamp: 2_000 });
  assert.equal(store.retention().oldestEventMs, 1_000);
});

test("an unfiltered query merges categories newest-first in arrival order", () => {
  const store = new RuntimeStore();
  push(store, "log", "a");
  push(store, "frame", "b");
  push(store, "exception", "c");
  push(store, "network", "d");
  push(store, "log", "e");

  assert.deepEqual(
    store.query().map((e) => e.message),
    ["e", "d", "c", "b", "a"],
  );
  // Early exit must respect the merged order, not per-category order.
  assert.deepEqual(
    store.query({ limit: 2 }).map((e) => e.message),
    ["e", "d"],
  );
});

test("merged order survives eviction in one category", () => {
  const store = new RuntimeStore({ frame: 2 });
  push(store, "exception", "boom");
  for (let i = 0; i < 5; i++) push(store, "frame", `frame ${i}`);

  assert.deepEqual(
    store.query().map((e) => e.message),
    ["frame 4", "frame 3", "boom"],
  );
});

test("clear resets contents, counts and eviction tallies", () => {
  const store = new RuntimeStore({ frame: 2 });
  for (let i = 0; i < 5; i++) push(store, "frame", `frame ${i}`);
  let cleared = false;
  store.on("clear", () => (cleared = true));

  store.clear();

  assert.equal(cleared, true);
  assert.equal(store.size(), 0);
  assert.deepEqual(store.query(), []);
  assert.equal(store.retention().evicted.frame, 0);
  assert.equal(store.retention().oldestEventMs, null);
});

test("ingestion stays linear under sustained load", () => {
  // Guards the O(1) circular buffer. The previous implementation spliced the
  // front off a 5,000-element array on every insert past capacity; this loop
  // took seconds rather than milliseconds. The bound is deliberately loose so
  // it fails on a regression to O(n), not on a slow CI runner.
  const store = new RuntimeStore();
  const started = process.hrtime.bigint();
  for (let i = 0; i < 200_000; i++) push(store, "frame", `frame ${i}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(store.counts().frame, DEFAULT_CAPACITIES.frame);
  assert.ok(elapsedMs < 5_000, `200k inserts took ${elapsedMs.toFixed(0)}ms; expected well under 5s`);
});
