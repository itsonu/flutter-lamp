import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { exportSession, SCHEMA_VERSION } from "./session.js";
import { redactVmServiceUri } from "../core/redaction.js";
import { stateActivity } from "../diagnosis/stateActivity.js";

/**
 * `export_session` is a public artifact meant to be shared — attached to bug
 * reports, replayed later, handed to another agent. That makes two things
 * contractual: it must not carry a credential, and `brief` must be a faithful
 * subset rather than an arbitrary sample.
 */

const META = {
  connected: true,
  sessionId: "s1",
  wsUri: "ws://127.0.0.1:62435/ik1OKnShsmc=/ws",
  collectors: [],
};

function populated() {
  const store = new RuntimeStore();
  store.beginSession(1_000);
  const T = 1_700_000_000_000;
  store.add({
    timestamp: T,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/user → 500",
    data: { startTimeMs: T, endTimeMs: T + 100, uri: "/api/user", durationMs: 100 },
  });
  store.add({
    timestamp: T + 500,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: { stackTrace: "#0 ...", library: "widgets library" },
  });
  for (let i = 0; i < 40; i++) {
    store.add({
      timestamp: T + 1_000 + i * 16,
      source: "Flutter.Frame",
      severity: "debug",
      category: "frame",
      message: `frame ${i}`,
      data: { janky: false, elapsedMs: 8, buildMs: 4, rasterMs: 3 },
    });
  }
  return store;
}

test("the VM Service auth token never leaves in an export", () => {
  // The path segment of a VM Service URI is a credential that grants evaluate,
  // i.e. arbitrary Dart execution in the running app.
  const exported = exportSession(populated(), META, { mode: "full" });
  const serialized = JSON.stringify(exported);

  assert.ok(!serialized.includes("ik1OKnShsmc="), "the auth token must not appear anywhere");
  assert.equal(exported.session.wsUri, "ws://127.0.0.1:62435/[REDACTED]/ws");
  // Host and port survive, because they are useful and are not secret.
  assert.match(String(exported.session.wsUri), /127\.0\.0\.1:62435/);
});

test("redactVmServiceUri handles the shapes it will actually meet", () => {
  assert.equal(redactVmServiceUri(null), null);
  assert.equal(
    redactVmServiceUri("ws://127.0.0.1:8181/aUJJy6529Qc=/ws"),
    "ws://127.0.0.1:8181/[REDACTED]/ws",
  );
  // No trailing /ws.
  assert.equal(redactVmServiceUri("ws://127.0.0.1:8181/tok="), "ws://127.0.0.1:8181/[REDACTED]");
  // Already tokenless: nothing to strip beyond the empty segment.
  assert.ok(!String(redactVmServiceUri("ws://127.0.0.1:8181/ws")).includes("8181/ws/"));
});

test("brief carries every event its diagnoses cite, and no other", () => {
  const exported = exportSession(populated(), META, { mode: "brief" });
  assert.equal(exported.mode, "brief");
  assert.equal(exported.eventsAreCitedSubset, true);

  const cited = new Set<string>([
    ...exported.diagnoses.runtime.evidence.map((e) => e.eventId),
    ...exported.diagnoses.runtime.timeline.map((e) => e.eventId),
  ]);
  const carried = new Set(exported.events.map((e) => e.eventId));

  for (const id of cited) {
    assert.ok(carried.has(id), `brief cites ${id} but does not carry it — the claim is uncheckable`);
  }
  // And it is a genuine reduction, not the whole buffer relabelled.
  assert.ok(
    exported.events.length < exportSession(populated(), META, { mode: "full" }).events.length,
    "brief must actually be smaller than full",
  );
});

test("brief is ordered oldest-first and is deterministic", () => {
  const a = exportSession(populated(), META, { mode: "brief" });
  const b = exportSession(populated(), META, { mode: "brief" });

  const ts = a.events.map((e) => e.timestamp);
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y), "events must read forwards in time");

  // Same input, same output — apart from the export timestamp itself.
  const strip = (x: typeof a) => JSON.stringify({ ...x, session: { ...x.session, exportedAt: 0 } });
  assert.equal(strip(a), strip(b), "an artifact used as a fixture must be reproducible");
});

test("an empty session exports a valid artifact rather than failing", () => {
  const exported = exportSession(new RuntimeStore(), META, { mode: "brief" });
  assert.equal(exported.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(exported.events, []);
  assert.equal(exported.diagnoses.runtime.status, "unknown");
  // The diagnosis still explains itself even with nothing to go on.
  assert.ok(exported.diagnoses.runtime.limitations.length > 0);
});

test("full carries strictly more than brief, and says which it is", () => {
  const store = populated();
  const full = exportSession(store, META, { mode: "full" });
  const brief = exportSession(store, META, { mode: "brief" });

  assert.equal(full.eventsAreCitedSubset, false);
  assert.equal(full.mode, "full");
  assert.ok(full.events.length >= brief.events.length);
  assert.equal(full.events.length, 42, "every retained event");
});

test("the schema version is pinned, so a consumer can refuse what it cannot read", () => {
  const exported = exportSession(populated(), META, { mode: "brief" });
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(
    Object.keys(exported).sort(),
    [
      "collectors",
      "counts",
      "diagnoses",
      "events",
      "eventsAreCitedSubset",
      "mode",
      "retention",
      "schemaVersion",
      "session",
      "tool",
    ].sort(),
  );
});

// ── get_state_activity boundaries ────────────────────────────────────────────

test("state activity reports an empty session without implying the app is quiet", () => {
  const report = stateActivity(new RuntimeStore());
  assert.equal(report.totalEvents, 0);
  assert.deepEqual(report.frameworks, []);
  assert.equal(report.firstEventMs, null);
  assert.equal(report.eventsPerSecond, null);
  assert.equal(report.coOccurrence.ratio, null);
  assert.ok(report.notes.length > 0, "an empty result must explain itself");
  assert.ok(
    report.limitations.some((l) => l.includes("not Bloc") || l.includes("not Bloc transitions")),
    "the notification-vs-transition distinction must be stated",
  );
});

test("state activity buckets by second and reports the span it observed", () => {
  const store = new RuntimeStore();
  const base = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) {
    store.add({
      timestamp: base + i * 100, // ten events inside one second
      source: "riverpod:new_event",
      severity: "debug",
      category: "state",
      message: "riverpod state changed",
      data: { framework: "riverpod", providerRef: i, valuesAvailable: false },
    });
  }

  const report = stateActivity(store);
  assert.equal(report.totalEvents, 10);
  assert.deepEqual(report.frameworks, ["riverpod"]);
  assert.equal(report.firstEventMs, base);
  assert.equal(report.lastEventMs, base + 900);
  assert.equal(report.busiestBuckets[0].events, 10, "all ten land in one bucket");
  assert.equal(report.busiestBuckets[0].startMs % 1_000, 0, "buckets align to the second");
});

test("a single state event yields a defined, non-infinite rate", () => {
  const store = new RuntimeStore();
  store.add({
    timestamp: 1_700_000_000_000,
    source: "provider:provider_changed",
    severity: "debug",
    category: "state",
    message: "provider state changed",
    data: { framework: "provider", providerRef: "0", valuesAvailable: false },
  });

  const report = stateActivity(store);
  assert.equal(report.totalEvents, 1);
  // A zero-length span must not divide by zero.
  assert.ok(
    report.eventsPerSecond === null || Number.isFinite(report.eventsPerSecond),
    `eventsPerSecond was ${report.eventsPerSecond}`,
  );
});
