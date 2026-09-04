import { eventTime, type Collector } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { Severity } from "../core/events.js";
import type { VmService } from "../vm/vmService.js";
import { frameBudgetUs } from "../core/frameBudget.js";

/**
 * Frame timings from the `Extension` stream, extensionKind "Flutter.Frame".
 * Each event reports build/raster/total elapsed in microseconds. We classify
 * severity by how far the frame blew past the budget so jank surfaces in
 * severity-filtered queries and the diagnosis engine. The budget is one
 * assumption held in `core/frameBudget.ts`, not a literal repeated here — and
 * it is an assumption: the VM Service does not report the display refresh rate.
 *
 * `startTime` and `vsyncOverhead` are stored when the event carries them.
 * Nothing reads them yet; they are what a future derivation of the real refresh
 * period would need, and discarding them is why that derivation is currently
 * impossible from recorded evidence.
 */
export class FrameCollector implements Collector {
  readonly name = "frames";

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    // Handlers are registered BEFORE subscribing, deliberately. The VM Service
    // (through DDS) delivers a backlog of buffered stream events the instant a
    // subscription is accepted, and those arrive before the continuation after
    // `await streamListen` runs. Subscribing first therefore drops everything
    // the app produced before this session connected -- measured on a real
    // device as 622 events lost versus 0 with this ordering, which is the
    // entire history when attaching to an already-running app.
    vm.on("stream:Extension", (event: any) => {
      if (event?.extensionKind !== "Flutter.Frame") return;
      const d = event.extensionData ?? {};
      const elapsedUs: number = d.elapsed ?? 0;
      const buildUs: number = d.build ?? 0;
      const rasterUs: number = d.raster ?? 0;

      const budgetUs = frameBudgetUs();
      let severity: Severity = "debug";
      if (elapsedUs > budgetUs * 2) severity = "error";
      else if (elapsedUs > budgetUs) severity = "warning";

      const janky = elapsedUs > budgetUs;
      store.add({
        timestamp: eventTime(event),
        source: "Flutter.Frame",
        severity,
        category: "frame",
        message: `Frame #${d.number ?? "?"} ${(elapsedUs / 1000).toFixed(1)}ms${janky ? " (jank)" : ""}`,
        data: {
          number: d.number,
          elapsedMs: round2(elapsedUs / 1000),
          buildMs: round2(buildUs / 1000),
          rasterMs: round2(rasterUs / 1000),
          janky,
          // Present only on targets that report them. Absent is a fact about
          // the target, so the keys are omitted rather than set to null.
          ...(typeof d.startTime === "number" ? { startTimeUs: d.startTime } : {}),
          ...(typeof d.vsyncOverhead === "number"
            ? { vsyncOverheadMs: round2(d.vsyncOverhead / 1000) }
            : {}),
        },
      });
    });

    await vm.streamListen("Extension");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
