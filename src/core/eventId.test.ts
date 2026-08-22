import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "./runtimeStore.js";
import type { Category } from "./events.js";

function push(store: RuntimeStore, category: Category, message: string) {
  return store.add({
    timestamp: 1_000,
    source: "test",
    severity: "info",
    category,
    message,
    data: {},
  });
}

test("event ids are readable, typed by category, and zero-padded", () => {
  const store = new RuntimeStore();
  assert.equal(push(store, "exception", "boom").eventId, "exc_00001");
  assert.equal(push(store, "network", "GET /x").eventId, "net_00002");
  assert.equal(push(store, "log", "hello").eventId, "log_00003");
  assert.equal(push(store, "frame", "frame 1").eventId, "frm_00004");
  assert.equal(push(store, "system", "connected").eventId, "sys_00005");
});

test("event ids stay unique across categories and sessions", () => {
  const store = new RuntimeStore();
  const seen = new Set<string>();

  store.beginSession();
  for (let i = 0; i < 50; i++) seen.add(push(store, "log", `a${i}`).eventId);
  store.beginSession();
  for (let i = 0; i < 50; i++) seen.add(push(store, "exception", `b${i}`).eventId);

  assert.equal(seen.size, 100, "a diagnosis citing an id must not be ambiguous");
});

test("an id resolves back to its event, across sessions and after eviction", () => {
  const store = new RuntimeStore({ frame: 2 });
  store.beginSession();
  const old = push(store, "exception", "from the previous run");

  store.beginSession();
  const current = push(store, "exception", "from this run");

  // byEventId ignores session scoping: an id cited in an earlier diagnosis
  // must still resolve, otherwise the citation is decorative.
  assert.equal(store.byEventId(old.eventId)?.message, "from the previous run");
  assert.equal(store.byEventId(current.eventId)?.message, "from this run");

  // Evicted evidence resolves to nothing rather than to the wrong event.
  const dropped = push(store, "frame", "frame 1");
  push(store, "frame", "frame 2");
  push(store, "frame", "frame 3");
  assert.equal(store.byEventId(dropped.eventId), undefined);
  assert.equal(store.byEventId("exc_99999"), undefined);
});

test("diagnosis evidence cites the event id", async () => {
  const { diagnose } = await import("../diagnosis/engine.js");
  const store = new RuntimeStore();
  const network = store.add({
    timestamp: 1_000_000,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/user → 500",
    data: { uri: "/api/user", statusCode: 500 },
  });
  const exception = store.add({
    timestamp: 1_000_500,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: { stackTrace: "#0 ..." },
  });

  const ids = diagnose(store).evidence.map((e) => e.eventId);
  assert.ok(ids.includes(exception.eventId), "the anchor must be citable");
  assert.ok(ids.includes(network.eventId), "correlated evidence must be citable");
  for (const id of ids) assert.ok(store.byEventId(id), `${id} must resolve back to an event`);
});
