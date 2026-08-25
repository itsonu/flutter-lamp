import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { diagnosePerformance } from "./performance.js";

const T = 1_700_000_000_000;

interface FrameOpts {
  count: number;
  janky?: boolean;
  buildMs?: number;
  rasterMs?: number;
  at?: number;
  stepMs?: number;
}

function frames(store: RuntimeStore, opts: FrameOpts) {
  const { count, janky = false, buildMs = 4, rasterMs = 3, at = T, stepMs = 16 } = opts;
  const elapsed = janky ? buildMs + rasterMs + 10 : buildMs + rasterMs;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      store.add({
        timestamp: at + i * stepMs,
        source: "Flutter.Frame",
        severity: janky ? "error" : "debug",
        category: "frame",
        message: `Frame ${elapsed}ms`,
        data: { janky, elapsedMs: elapsed, buildMs, rasterMs },
      }).eventId,
    );
  }
  return ids;
}

function request(store: RuntimeStore, start: number, end: number) {
  return store.add({
    timestamp: start,
    source: "HttpProfile",
    severity: "info",
    category: "network",
    message: "GET /api/feed → 200",
    data: { startTimeMs: start, endTimeMs: end, uri: "/api/feed" },
  });
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

test("too few frames is reported as unknown, not as a clean bill of health", () => {
  const store = new RuntimeStore();
  frames(store, { count: 5, janky: true });

  const d = diagnosePerformance(store);
  assert.equal(d.status, "unknown");
  assert.match(d.summary, /too few/);
  assert.deepEqual(d.findings, []);
});

test("no frames at all says so plainly", () => {
  const d = diagnosePerformance(new RuntimeStore());
  assert.equal(d.status, "unknown");
  assert.match(d.summary, /No frame timings captured/);
});

test("a smooth app is reported healthy with no invented findings", () => {
  const store = new RuntimeStore();
  frames(store, { count: 200 });

  const d = diagnosePerformance(store);
  assert.equal(d.status, "healthy");
  assert.equal(d.frames.janky, 0);
  assert.deepEqual(d.findings, []);
  assert.deepEqual(d.recommendedFixes, [], "healthy means nothing to fix");
});

test("percentiles and the build/raster split are computed from real timings", () => {
  const store = new RuntimeStore();
  frames(store, { count: 90, buildMs: 4, rasterMs: 3 });
  frames(store, { count: 30, janky: true, buildMs: 30, rasterMs: 4, at: T + 10_000 });

  const d = diagnosePerformance(store);
  assert.equal(d.status, "diagnosed");
  assert.equal(d.frames.total, 120);
  assert.equal(d.frames.janky, 30);
  assert.equal(d.frames.jankPercent, 25);
  assert.equal(d.frames.p50Ms, 7, "most frames are fast");
  assert.equal(d.frames.worstMs, 44);
  assert.equal(d.frames.meanBuildMs, 30);
  assert.equal(d.frames.meanRasterMs, 4);
  assert.equal(d.dominantPhase, "build");
  assert.match(d.summary, /Dominated by the build phase/);
  assert.ok(d.findings.some((f) => /building/.test(f.claim)));
});

test("a raster-bound app gets raster advice, not build advice", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, buildMs: 3, rasterMs: 35, at: T + 10_000 });

  const d = diagnosePerformance(store);
  assert.equal(d.dominantPhase, "raster");
  assert.ok(d.recommendedFixes.some((f) => /overdraw/.test(f)));
  assert.ok(!d.recommendedFixes.some((f) => /const widgets/.test(f)));
});

test("an even split is reported as mixed rather than forced into one phase", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, buildMs: 15, rasterMs: 15, at: T + 10_000 });

  const d = diagnosePerformance(store);
  assert.equal(d.dominantPhase, "mixed");
  assert.ok(!d.summary.includes("Dominated by"));
});

test("jank while a request is in flight is surfaced with both sides cited", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  const inFlight = request(store, T + 10_000, T + 12_000);
  frames(store, { count: 40, janky: true, buildMs: 20, rasterMs: 5, at: T + 10_100, stepMs: 40 });

  const d = diagnosePerformance(store);
  const finding = d.findings.find((f) => /in flight/.test(f.claim));
  assert.ok(finding, "jank during a request should be reported");
  assert.ok(finding.evidence.includes(inFlight.eventId), "the request itself must be cited");
  assert.match(finding.fix, /off the main isolate/);
});

test("jank clustered after a route change is attributed to the new screen's build", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  const nav = navigateTo(store, "/checkout", T + 10_000);
  frames(store, { count: 30, janky: true, buildMs: 25, rasterMs: 4, at: T + 10_050, stepMs: 20 });

  const d = diagnosePerformance(store);
  const finding = d.findings.find((f) => /route change/.test(f.claim));
  assert.ok(finding, "post-navigation jank should be reported");
  assert.match(finding.claim, /\/checkout/);
  assert.ok(finding.evidence.includes(nav.eventId));
  assert.match(finding.fix, /addPostFrameCallback/);
});

test("jank spread evenly is not blamed on a route change", () => {
  const store = new RuntimeStore();
  navigateTo(store, "/home", T);
  frames(store, { count: 60 });
  // 30 seconds later, nowhere near the transition.
  frames(store, { count: 40, janky: true, at: T + 30_000, stepMs: 100 });

  const d = diagnosePerformance(store);
  assert.ok(!d.findings.some((f) => /route change/.test(f.claim)), "co-occurrence must be real to be claimed");
});

test("heap growth is the weakest finding and admits it cannot be confirmed", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, at: T + 5_000 });
  [100, 160, 220].forEach((mb, i) =>
    store.add({
      timestamp: T + i * 2_000,
      source: "getMemoryUsage",
      severity: "info",
      category: "system",
      message: `Heap ${mb}MB`,
      data: { heapUsageMB: mb, heapCapacityMB: 512 },
    }),
  );

  const d = diagnosePerformance(store);
  const memory = d.findings.find((f) => /heap grew/i.test(f.claim));
  assert.ok(memory);
  assert.ok(memory.strength < 0.7, "co-occurrence is not causation and must score lower");
  assert.match(memory.fix, /not visible here/);
  assert.equal(d.findings[0], d.findings.slice().sort((a, b) => b.strength - a.strength)[0]);
});

test("limitations name the blind spots every time", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, at: T + 5_000 });

  const { limitations } = diagnosePerformance(store);
  assert.ok(limitations.some((l) => l.includes("No CPU sampling")));
  assert.ok(limitations.some((l) => l.includes("GC events")));
  // With no rebuild evidence the tool must say tracking is unavailable — not
  // claim, as it once did, that rebuild counts are impossible in principle.
  assert.ok(limitations.some((l) => l.includes("No widget rebuild data in this session")));
});

function rebuildEvent(
  store: RuntimeStore,
  at: number,
  frameNumber: number,
  top: Array<{ widget: string; file: string; line: number; count: number; appCode: boolean }>,
) {
  return store.add({
    timestamp: at,
    source: "Flutter.RebuiltWidgets",
    severity: "debug",
    category: "rebuild",
    message: `Frame #${frameNumber}`,
    data: {
      frameNumber,
      totalRebuilds: top.reduce((s, t) => s + t.count, 0),
      distinctLocations: top.length,
      top,
      truncated: false,
    },
  });
}

test("a build-bound profile names the widget and source line behind it", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, buildMs: 30, rasterMs: 4, at: T + 10_000 });
  for (let i = 0; i < 5; i++) {
    rebuildEvent(store, T + 10_000 + i * 16, 100 + i, [
      { widget: "AppShell", file: "lib/features/home/app_shell.dart", line: 221, count: 16, appCode: true },
      { widget: "GoRouterState", file: "go_router/src/builder.dart", line: 455, count: 40, appCode: false },
    ]);
  }

  const d = diagnosePerformance(store);
  const finding = d.findings.find((f) => /widget rebuild/.test(f.claim));
  assert.ok(finding, "rebuild attribution should be reported");
  assert.ok(finding.strength >= 0.8, "a build-bound profile makes this a strong claim");

  // "Busiest" must mean busiest. Package code rebuilt 200 times against
  // AppShell's 80, so it leads — ranking app code first would make the headline
  // a false statement.
  assert.match(finding.claim, /Busiest: GoRouterState at go_router\/src\/builder\.dart:455 — 200/);
  assert.equal(d.rebuildHotspots[0].widget, "GoRouterState");
  assert.equal(d.rebuildHotspots[0].rebuilds, 200);

  // But the developer can only edit their own code, so name that too, and aim
  // the fix at it.
  assert.match(finding.claim, /Busiest in your own code: AppShell at lib\/features\/home\/app_shell\.dart:221 — 80/);
  assert.match(finding.fix, /Narrow the rebuild scope around AppShell/);

  const mine = d.rebuildHotspots.find((h) => h.appCode);
  assert.equal(mine?.widget, "AppShell");
  assert.equal(mine?.rebuilds, 80);
  assert.equal(mine?.frames, 5);
});

test("when nothing resolves to your own code, the claim says so", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, buildMs: 30, rasterMs: 4, at: T + 10_000 });
  rebuildEvent(store, T + 10_000, 100, [
    { widget: "GoRouterState", file: "go_router/src/builder.dart", line: 455, count: 40, appCode: false },
  ]);

  const finding = diagnosePerformance(store).findings.find((f) => /widget rebuild/.test(f.claim));
  assert.ok(finding);
  assert.match(finding.claim, /No hotspot resolved to your own code/);
});

test("rebuild data on a raster-bound profile is context, not a cause", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, buildMs: 3, rasterMs: 35, at: T + 10_000 });
  rebuildEvent(store, T + 10_000, 100, [
    { widget: "AppShell", file: "lib/app_shell.dart", line: 221, count: 4, appCode: true },
  ]);

  const finding = diagnosePerformance(store).findings.find((f) => /widget rebuild/.test(f.claim));
  assert.ok(finding);
  assert.ok(finding.strength < 0.7, "raster jank is not explained by rebuild counts");
  assert.match(finding.fix, /unlikely to be the cause/);
});

test("with rebuild data, the limitations describe its real bounds", () => {
  const store = new RuntimeStore();
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, buildMs: 30, rasterMs: 4, at: T + 10_000 });
  rebuildEvent(store, T + 10_000, 100, [
    { widget: "AppShell", file: "lib/app_shell.dart", line: 221, count: 4, appCode: true },
  ]);

  const { limitations } = diagnosePerformance(store);
  assert.ok(!limitations.some((l) => l.includes("No widget rebuild data")));
  assert.ok(limitations.some((l) => l.includes("busiest locations in each frame")));
  assert.ok(limitations.some((l) => l.includes("path heuristic")));
  assert.ok(
    limitations.some((l) => l.includes("not to a specific function")),
    "CPU attribution is still out of reach, and must still be stated",
  );
});

test("dropped frames are declared, so percentages are not read as whole-session", () => {
  const store = new RuntimeStore({ frame: 50 });
  frames(store, { count: 60 });
  frames(store, { count: 40, janky: true, at: T + 5_000 });

  const { limitations } = diagnosePerformance(store);
  assert.match(limitations[0], /dropped by retention/);
});

test("state activity beside janky frames is reported, without naming a provider", () => {
  const store = new RuntimeStore();
  frames(store, { count: 40 });
  const janky = frames(store, { count: 12, janky: true, buildMs: 30, at: T + 5_000 });

  // Provider activity interleaved with the janky frames, as measured from
  // probe/riverpod_probe: an offset and nothing else.
  for (let i = 0; i < 12; i++) {
    store.add({
      timestamp: T + 5_000 + i * 16,
      source: "riverpod:new_event",
      severity: "debug",
      category: "state",
      message: "Riverpod provider activity",
      data: { framework: "riverpod", offset: i },
    });
  }

  const result = diagnosePerformance(store);
  const finding = result.findings.find((f) => f.claim.includes("state activity"));
  assert.ok(finding, "state co-occurrence should be reported");
  assert.match(finding.claim, /riverpod/);
  assert.ok(finding.strength < 0.6, "co-occurrence must rank below the causal findings");
  assert.ok(finding.evidence.some((id) => janky.includes(id)));
  // No provider name exists, so none may appear in the fix either.
  assert.match(finding.fix, /not observable/);
});

test("no state finding when nothing posted state activity", () => {
  const store = new RuntimeStore();
  frames(store, { count: 40 });
  frames(store, { count: 12, janky: true, buildMs: 30, at: T + 5_000 });

  const result = diagnosePerformance(store);
  assert.ok(!result.findings.some((f) => f.claim.includes("state activity")));
});
