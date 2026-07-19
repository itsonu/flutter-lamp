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
