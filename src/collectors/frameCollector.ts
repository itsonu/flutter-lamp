import type { Collector } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { Severity } from "../core/events.js";
import type { VmService } from "../vm/vmService.js";

/** 60fps frame budget in microseconds. Above this a frame is "janky". */
const FRAME_BUDGET_US = 16_667;

/**
 * Frame timings from the `Extension` stream, extensionKind "Flutter.Frame".
 * Each event reports build/raster/total elapsed in microseconds. We classify
 * severity by how far the frame blew past the 60fps budget so jank surfaces
 * in severity-filtered queries and the diagnosis engine.
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

      let severity: Severity = "debug";
      if (elapsedUs > FRAME_BUDGET_US * 2) severity = "error";
      else if (elapsedUs > FRAME_BUDGET_US) severity = "warning";

      const janky = elapsedUs > FRAME_BUDGET_US;
      store.add({
        timestamp: Date.now(),
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
        },
      });
    });

    await vm.streamListen("Extension");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
