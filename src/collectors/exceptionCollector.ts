import type { Collector } from "./collector.js";
import { extractFlutterError, firstLine } from "./flutterError.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Runtime exceptions from two official sources:
 *  - `Extension` stream, extensionKind "Flutter.Error" — structured
 *    FlutterErrorDetails (framework/build/layout errors). Primary source.
 *  - `Debug` stream, kind "PauseException" — VM-level unhandled exceptions
 *    (only fires if the app pauses on exceptions; captured when present).
 */
export class ExceptionCollector implements Collector {
  readonly name = "exceptions";

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    await vm.streamListen("Extension");
    await vm.streamListen("Debug");

    vm.on("stream:Extension", (event: any) => {
      if (event?.extensionKind !== "Flutter.Error") return;
      const info = extractFlutterError(event.extensionData ?? {});
      store.add({
        timestamp: Date.now(),
        source: "Flutter.Error",
        severity: "error",
        category: "exception",
        message: info.summary,
        data: {
          type: info.type,
          library: info.library,
          summary: info.summary,
          widget: info.widget,
          stackTrace: info.stack || undefined,
          hasStack: info.stack.length > 0,
        },
      });
    });

    vm.on("stream:Debug", (event: any) => {
      if (event?.kind !== "PauseException") return;
      const exc = event.exception ?? {};
      const summary: string =
        exc.valueAsString ?? exc.class?.name ?? "Unhandled exception";
      store.add({
        timestamp: Date.now(),
        source: "Debug.PauseException",
        severity: "critical",
        category: "exception",
        message: firstLine(summary),
        data: {
          exceptionClass: exc.class?.name,
          summary,
        },
      });
    });
  }
}
