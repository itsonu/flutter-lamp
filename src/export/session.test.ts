import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { exportSession, SCHEMA_VERSION } from "./session.js";

/**
 * The export is a contract with consumers that are not in this repo — a bug
 * report attached to an issue, an offline analysis script, a regression
 * fixture. So the shape is pinned here: a silent rename breaks this test
 * instead of a downstream parser.
 */

const META = { connected: true, sessionId: "s1", wsUri: "ws://127.0.0.1:1/ws", collectors: [] };

function storeWithAnException(): RuntimeStore {
  const store = new RuntimeStore();
  store.beginSession();
  const now = Date.now();
  // Far outside the correlation window, so the diagnosis has no reason to cite
  // it. Anything *near* the exception is legitimately pulled into the timeline
  // as context, which is the point of the timeline — so the noise has to be old
  // for "cited subset" to mean anything.
  store.add({
    timestamp: now - 600_000,
    source: "Stdout",
    severity: "info",
    category: "log",
    message: "chatter nobody cites",
    data: {},
  });
  store.add({
    timestamp: now,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: {},
  });
  return store;
}

test("export carries the pinned top-level shape", () => {
  const out = exportSession(storeWithAnException(), META, { now: () => 1_700_000_000_000 });

  assert.deepEqual(Object.keys(out).sort(), [
    "collectors",
    "counts",
    "diagnoses",
    "eventsAreCitedSubset",
    "events",
    "mode",
    "retention",
    "schemaVersion",
    "session",
    "tool",
  ].sort());
  assert.equal(out.schemaVersion, SCHEMA_VERSION);
  assert.equal(out.tool.name, "flutter-lamp");
  assert.equal(out.session.id, "s1");
  assert.equal(out.session.exportedAt, 1_700_000_000_000);
  assert.deepEqual(Object.keys(out.diagnoses).sort(), [
    "navigation",
    "performance",
    "rebuilds",
    "runtime",
  ]);
});

test("full mode returns every retained event, oldest first", () => {
  const out = exportSession(storeWithAnException(), META, { mode: "full" });

  assert.equal(out.mode, "full");
  assert.equal(out.eventsAreCitedSubset, false);
  assert.equal(out.events.length, 2);
  assert.ok(out.events[0].id < out.events[1].id);
});

test("brief mode returns exactly the events its own diagnoses cite", () => {
  const out = exportSession(storeWithAnException(), META, { mode: "brief" });

  assert.equal(out.eventsAreCitedSubset, true);

  const cited = new Set<string>([
    ...out.diagnoses.runtime.evidence.map((e) => e.eventId),
    ...out.diagnoses.runtime.timeline.map((t) => t.eventId),
    ...out.diagnoses.runtime.alternativeCauses.flatMap((a) => a.evidence),
    ...out.diagnoses.performance.findings.flatMap((f) => f.evidence),
    ...out.diagnoses.navigation.visits.flatMap((v) => [v.eventId, ...v.exceptions, ...v.networkFailures]),
  ]);

  // Every exported event is cited...
  for (const event of out.events) assert.ok(cited.has(event.eventId), `${event.eventId} is not cited`);
  // ...and every citation that still resolves is exported.
  const exported = new Set(out.events.map((e) => e.eventId));
  for (const id of cited) assert.ok(exported.has(id), `cited ${id} is missing from the export`);
  // The exception is evidence; the unrelated log line is not.
  assert.ok(out.events.some((e) => e.category === "exception"));
  assert.ok(!out.events.some((e) => e.message === "chatter nobody cites"));
});

test("brief mode is smaller than full mode on the same store", () => {
  const store = storeWithAnException();
  const full = exportSession(store, META, { mode: "full" });
  const brief = exportSession(store, META, { mode: "brief" });
  assert.ok(brief.events.length < full.events.length);
});

test("an empty store still exports a valid artifact", () => {
  const store = new RuntimeStore();
  store.beginSession();
  const out = exportSession(store, { ...META, connected: false }, {});
  assert.equal(out.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(out.events, []);
  assert.equal(out.diagnoses.runtime.status, "unknown");
});
