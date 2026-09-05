import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { diagnosePerformance } from "./performance.js";

/**
 * GC correlation, and the trap it exists to avoid.
 *
 * A GC pause overlapping a late frame is not evidence that GC caused it. On a
 * busy app the young generation collects constantly, so most frames overlap a
 * GC whether they were late or not. The tests below are weighted towards the
 * negatives: the finding must stay silent when the base rate explains the
 * overlap, and the limitation must say which of the several "no finding"
 * situations applies.
 */

const BUDGET = 16.67;

/** A frame that completed at `endMs` after taking `elapsedMs`. */
function frame(store: RuntimeStore, endMs: number, elapsedMs: number, n: number): void {
  store.add({
    timestamp: endMs,
    source: "Flutter.Frame",
    severity: elapsedMs > BUDGET ? "warning" : "debug",
    category: "frame",
    message: `Frame #${n} ${elapsedMs}ms`,
    data: { number: n, elapsedMs, buildMs: elapsedMs / 2, rasterMs: elapsedMs / 2, janky: elapsedMs > BUDGET },
  });
}

/** A GC that started at `startMs` and ran `durMs`. */
function gc(store: RuntimeStore, startMs: number, durMs: number): void {
  store.add({
    timestamp: startMs,
    source: "VMTimeline",
    severity: "debug",
    category: "timeline",
    message: `GC CollectNewGeneration ${durMs}ms`,
    data: { name: "CollectNewGeneration", cat: "GC", phase: "X", durMs, tsMicros: startMs * 1000 },
  });
}

const T0 = 1_700_000_000_000;

function limitationsOf(store: RuntimeStore): string {
  return diagnosePerformance(store).limitations.join(" | ");
}
function gcClaim(store: RuntimeStore): string | null {
  const d = diagnosePerformance(store);
  return d.findings.find((f) => /[Gg]arbage collection/.test(f.claim))?.claim ?? null;
}

test("GC inside late frames, and never inside on-time frames, is reported", () => {
  const store = new RuntimeStore();
  // 30 on-time frames, no GC anywhere near them.
  for (let i = 0; i < 30; i++) frame(store, T0 + i * 16, 8, i);
  // 10 late frames, each with a GC pause squarely inside it.
  for (let i = 0; i < 10; i++) {
    const end = T0 + 10_000 + i * 100;
    frame(store, end, 60, 100 + i);
    gc(store, end - 40, 20); // starts 40ms before completion, runs 20ms → inside
  }
  const claim = gcClaim(store);
  assert.ok(claim, "a clean separation should produce a finding");
  assert.match(claim!, /10\/10 late frames/);
  assert.match(claim!, /0\/30 on-time frames/);
  // The base rate must appear in the claim; a bare "GC overlapped late frames"
  // is the exact overstatement this design rejects.
  assert.match(claim!, /no clean frame overlapped one/);
});

test("GC that overlaps everything equally produces NO finding", () => {
  // The central negative. GC is constant, so it lands in late and on-time
  // frames alike. Overlap here carries no information and must not be claimed.
  const store = new RuntimeStore();
  for (let i = 0; i < 30; i++) {
    const end = T0 + i * 100;
    frame(store, end, 8, i);
    gc(store, end - 6, 4); // inside every on-time frame too
  }
  for (let i = 0; i < 10; i++) {
    const end = T0 + 10_000 + i * 100;
    frame(store, end, 60, 100 + i);
    gc(store, end - 40, 20);
  }
  assert.equal(gcClaim(store), null, "an equal base rate must not become a finding");
  assert.match(
    limitationsOf(store),
    /not a large enough difference to associate GC with this jank|co-occurrence only/,
  );
});

test("GC observed but never overlapping a late frame rules GC out", () => {
  // The answer the diagnosis previously could not give at all.
  const store = new RuntimeStore();
  for (let i = 0; i < 30; i++) frame(store, T0 + i * 100, 8, i);
  for (let i = 0; i < 10; i++) frame(store, T0 + 10_000 + i * 100, 60, 100 + i);
  // GC only ever runs during the quiet period, far from any late frame.
  for (let i = 0; i < 5; i++) gc(store, T0 + i * 100 + 1, 2);
  assert.equal(gcClaim(store), null);
  assert.match(limitationsOf(store), /none overlapped a late frame: GC is ruled out/);
});

test("no GC evidence at all says unobservable, not absent", () => {
  const store = new RuntimeStore();
  for (let i = 0; i < 30; i++) frame(store, T0 + i * 100, 8, i);
  for (let i = 0; i < 10; i++) frame(store, T0 + 10_000 + i * 100, 60, 100 + i);
  const lim = limitationsOf(store);
  assert.match(lim, /No garbage-collection events were captured/);
  assert.match(lim, /neither ruled in nor out/);
  // It must not silently claim GC did not happen.
  assert.doesNotMatch(lim, /no garbage collection occurred/i);
});

test("too few on-time frames means no base rate, and the limitation says so", () => {
  const store = new RuntimeStore();
  // Only 4 clean frames — below the threshold for a meaningful base rate.
  for (let i = 0; i < 4; i++) frame(store, T0 + i * 100, 8, i);
  for (let i = 0; i < 25; i++) {
    const end = T0 + 10_000 + i * 100;
    frame(store, end, 60, 100 + i);
    gc(store, end - 40, 20);
  }
  assert.equal(gcClaim(store), null, "no base rate means no claim");
  assert.match(limitationsOf(store), /too few to establish how often GC overlaps/);
});

test("overlap is strict: a GC that ends exactly as a frame begins did not run inside it", () => {
  const store = new RuntimeStore();
  for (let i = 0; i < 30; i++) frame(store, T0 + i * 100, 8, i);
  for (let i = 0; i < 10; i++) {
    const end = T0 + 10_000 + i * 100;
    frame(store, end, 60, 100 + i); // span [end-60, end]
    gc(store, end - 80, 20); // runs [end-80, end-60] — touches the boundary only
  }
  assert.equal(gcClaim(store), null, "a boundary touch is not an overlap");
  assert.match(limitationsOf(store), /none overlapped a late frame: GC is ruled out/);
});

test("the finding cites the GC events it rests on", () => {
  const store = new RuntimeStore();
  for (let i = 0; i < 30; i++) frame(store, T0 + i * 16, 8, i);
  for (let i = 0; i < 10; i++) {
    const end = T0 + 10_000 + i * 100;
    frame(store, end, 60, 100 + i);
    gc(store, end - 40, 20);
  }
  const f = diagnosePerformance(store).findings.find((x) => /[Gg]arbage collection/.test(x.claim));
  assert.ok(f);
  assert.ok(f!.evidence.length > 0, "a claim must point at captured events");
  for (const id of f!.evidence) assert.match(id, /^tml_/);
  // Strength is capped: a rate difference over one session is not a mechanism.
  assert.ok(f!.strength <= 0.7, `strength ${f!.strength} should stay below the mechanism findings`);
  assert.match(f!.fix, /not a demonstrated cause/);
});
