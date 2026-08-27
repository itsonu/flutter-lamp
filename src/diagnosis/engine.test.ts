import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { diagnose } from "./engine.js";

test("empty store → Unknown, low confidence", () => {
  const d = diagnose(new RuntimeStore());
  assert.ok(d.confidence < 0.7);
  assert.match(d.summary, /Unknown/i);
});

test("exception + correlated network error → exception root cause, high confidence", () => {
  const store = new RuntimeStore();
  const now = 1_000_000;
  store.add({
    timestamp: now,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/user → 500",
    data: { uri: "/api/user", statusCode: 500 },
  });
  store.add({
    timestamp: now + 500, // within correlation window
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: { stackTrace: "#0 ...", library: "widgets library" },
  });

  const d = diagnose(store);
  assert.equal(d.rootCause, "Null check operator used on a null value");
  assert.ok(d.confidence >= 0.7, `expected >=0.7, got ${d.confidence}`);
  // network error must appear as correlated evidence
  assert.ok(d.evidence.some((e) => e.category === "network"));
});

test("jank pattern (no exceptions) → performance root cause", () => {
  const store = new RuntimeStore();
  for (let i = 0; i < 10; i++) {
    const janky = i % 2 === 0;
    store.add({
      timestamp: 1000 + i,
      source: "Flutter.Frame",
      severity: janky ? "warning" : "debug",
      category: "frame",
      message: `Frame #${i}`,
      data: { elapsedMs: janky ? 40 : 8, buildMs: janky ? 35 : 4, rasterMs: 3, janky },
    });
  }
  const d = diagnose(store);
  assert.match(d.summary, /jank/i);
  assert.ok(d.confidence >= 0.7);
});

test("severity + category filtering in store query", () => {
  const store = new RuntimeStore();
  store.add({ timestamp: 1, source: "Stdout", severity: "info", category: "log", message: "hello", data: {} });
  store.add({ timestamp: 2, source: "Stderr", severity: "error", category: "log", message: "boom", data: {} });
  const errorsOnly = store.query({ category: "log", minSeverity: "error" });
  assert.equal(errorsOnly.length, 1);
  assert.equal(errorsOnly[0].message, "boom");
});

test("a chatty category does not starve the exception", () => {
  // Regression guard, measured on a real device: bloc_probe pushed 2,000
  // provider events in 30 seconds, which put the session's only exception
  // 2,436th newest. The engine read a flat most-recent-2,000 window, never saw
  // it, and reported that no exceptions were found — a confident false
  // negative contradicted by the store it was reading.
  const store = new RuntimeStore();
  const now = 2_000_000;
  store.add({
    timestamp: now,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Bad state: starved by volume",
    data: { stackTrace: "#0 ..." },
  });
  for (let i = 0; i < 2_500; i++) {
    store.add({
      timestamp: now + i,
      source: "provider:provider_changed",
      severity: "debug",
      category: "state",
      message: `notified ${i}`,
      data: {},
    });
  }

  const d = diagnose(store);
  assert.equal(d.cause, "exception");
  assert.equal(d.rootCause, "Bad state: starved by volume");
});

/** A framework error with no stack: what `A RenderFlex overflowed` looks like. */
function frameworkNote(store: RuntimeStore, at: number) {
  store.add({
    timestamp: at,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "A RenderFlex overflowed by 390 pixels on the bottom.",
    data: { type: "_FlutterErrorDetailsNode", hasStack: false },
  });
}

function jankyRun(store: RuntimeStore, at: number, janky: number, clean: number) {
  for (let i = 0; i < clean; i++) {
    store.add({
      timestamp: at + i * 100, source: "Flutter.Frame", severity: "debug", category: "frame",
      message: `Frame #${i}`, data: { elapsedMs: 8, buildMs: 4, rasterMs: 1, janky: false },
    });
  }
  for (let i = 0; i < janky; i++) {
    store.add({
      timestamp: at + (clean + i) * 100, source: "Flutter.Frame", severity: "error", category: "frame",
      message: `Frame #${clean + i}`,
      data: { elapsedMs: 50 + i, buildMs: 48 + i, rasterMs: 1, janky: true },
    });
  }
}

test("a stackless framework error does not outrank evidenced jank", () => {
  // Measured on a real session: an overflow error and a 45ms build arrive in the
  // same category at the same severity, and the exception used to win on
  // priority alone — naming a layout box as the cause of a build-bound stall.
  const store = new RuntimeStore();
  frameworkNote(store, 1_000_000);
  jankyRun(store, 1_010_000, 12, 20);

  const d = diagnose(store);
  assert.equal(d.cause, "jank");
  assert.equal(d.status, "diagnosed");
  // Demoted, not hidden: the error is still offered as an explanation.
  assert.ok(d.alternativeCauses.some((a) => a.cause === "exception"));
});

test("an exception with a stack still outranks jank", () => {
  const store = new RuntimeStore();
  store.add({
    timestamp: 1_000_000, source: "Flutter.Error", severity: "error", category: "exception",
    message: "Null check operator used on a null value",
    data: { stackTrace: "#0 MyWidget.build (package:app/main.dart:42:9)" },
  });
  jankyRun(store, 1_010_000, 12, 20);

  const d = diagnose(store);
  assert.equal(d.cause, "exception");
});

test("a stackless framework error is still the answer when nothing else fires", () => {
  // The demotion must not become suppression. With no competing hypothesis the
  // overflow is the only fault observed, and saying so is correct.
  const store = new RuntimeStore();
  frameworkNote(store, 1_000_000);
  jankyRun(store, 1_010_000, 0, 20);

  const d = diagnose(store);
  assert.equal(d.cause, "exception");
  assert.equal(d.status, "diagnosed");
});

test("a jank verdict cites its own worst frame", () => {
  const store = new RuntimeStore();
  jankyRun(store, 1_000_000, 12, 20);

  const d = diagnose(store);
  const worst = d.evidence
    .map((e) => e.eventId)
    .includes(store.query({ category: "frame" }).filter((e) => e.data.janky === true)
      .sort((a, b) => Number(b.data.elapsedMs) - Number(a.data.elapsedMs))[0].eventId);
  assert.ok(worst, "worst janky frame must be in the cited evidence");
});

test("sustained heap growth does not outrank evidenced jank", () => {
  // Memory is the lowest-priority hypothesis on purpose: a growing heap is not
  // a leak, and Dart's heap grows between collections. No recorded incident
  // constrains this — one would need a session that both stutters and grows,
  // where which of the two is the root cause is genuinely arguable — so the
  // policy is pinned here instead. Found by mutation: promoting memory above
  // jank passed the whole eval suite unnoticed.
  const store = new RuntimeStore();
  const now = 3_000_000;
  for (let i = 0; i < 5; i++) {
    store.add({
      timestamp: now + i * 1_000,
      source: "getMemoryUsage",
      severity: "info",
      category: "system",
      message: `Heap ${50 + i * 30}MB`,
      data: { heapUsageMB: 50 + i * 30, heapCapacityMB: 60 + i * 30, externalUsageMB: 0 },
    });
  }
  jankyRun(store, now + 10_000, 12, 20);

  const d = diagnose(store);
  assert.equal(d.cause, "jank");
  // Offered as a competing explanation rather than hidden.
  assert.ok(d.alternativeCauses.some((a) => a.cause === "memory"));
});

test("heap growth alone is diagnosed, and never called a leak", () => {
  const store = new RuntimeStore();
  const now = 3_000_000;
  for (let i = 0; i < 5; i++) {
    store.add({
      timestamp: now + i * 1_000,
      source: "getMemoryUsage",
      severity: "info",
      category: "system",
      message: `Heap ${50 + i * 30}MB`,
      data: { heapUsageMB: 50 + i * 30, heapCapacityMB: 60 + i * 30, externalUsageMB: 0 },
    });
  }

  const d = diagnose(store);
  assert.equal(d.cause, "memory");
  assert.equal(d.status, "diagnosed");
  // The restraint is part of the contract, not a wording accident: growth is
  // evidence of retention at most, and the tool must not upgrade it.
  const text = [d.summary, d.rootCause, ...d.recommendedFixes].join(" ").toLowerCase();
  assert.ok(!/\bis a leak\b|\bleaking\b/.test(text), `overclaimed: ${text}`);
});

test("a blind category with events is not called unobservable", () => {
  // Found by mutation: the recorded web incident cannot catch this, because
  // there both blind categories are also empty. A collector that degraded
  // part-way through a session still left real evidence behind, and calling
  // that a hole would understate what is known.
  const store = new RuntimeStore();
  store.add({
    timestamp: 4_000_000,
    source: "HttpProfile",
    severity: "error",
    category: "network",
    message: "GET /api/orders → 500",
    data: { uri: "/api/orders", statusCode: 500 },
  });

  const d = diagnose(store, ["network", "exception"]);
  assert.ok(!d.coverage.unobservable.includes("network"), "network has events; it is not a hole");
  assert.ok(d.coverage.unobservable.includes("exception"), "exception is blind and empty");
  assert.ok(!d.coverage.empty.includes("network"), "and it is not empty either");
});
