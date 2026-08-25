import type { Collector } from "./collector.js";
import { extractFlutterError, firstLine } from "./flutterError.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";
import { redactText } from "../core/redaction.js";

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
    // Handlers are registered BEFORE subscribing, deliberately. The VM Service
    // (through DDS) delivers a backlog of buffered stream events the instant a
    // subscription is accepted, and those arrive before the continuation after
    // `await streamListen` runs. Subscribing first therefore drops everything
    // the app produced before this session connected -- measured on a real
    // device as 622 events lost versus 0 with this ordering, which is the
    // entire history when attaching to an already-running app.
    vm.on("stream:Extension", (event: any) => {
      if (event?.extensionKind !== "Flutter.Error") return;
      const info = extractFlutterError(event.extensionData ?? {});
      const summary = redactText(info.summary);
      store.add({
        timestamp: Date.now(),
        source: "Flutter.Error",
        severity: "error",
        category: "exception",
        message: summary,
        data: {
          type: info.type,
          library: info.library,
          summary,
          widget: info.widget,
          stackTrace: info.stack ? redactText(info.stack) : undefined,
          hasStack: info.stack.length > 0,
        },
      });
    });

    vm.on("stream:Debug", (event: any) => {
      if (event?.kind !== "PauseException") return;
      const exc = event.exception ?? {};
      const summary: string = redactText(
        exc.valueAsString ?? exc.class?.name ?? "Unhandled exception",
      );
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

    await vm.streamListen("Extension");
    await vm.streamListen("Debug");
  }
}
