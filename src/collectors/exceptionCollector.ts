import { eventTime, type Collector, type CollectorHealth } from "./collector.js";
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
  private state: CollectorHealth = { status: "active" };

  health(): CollectorHealth {
    return this.state;
  }

  reset(): void {
    this.state = { status: "active" };
  }

  async start(vm: VmService, store: RuntimeStore, isolateId: string): Promise<void> {
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
        timestamp: eventTime(event),
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
        timestamp: eventTime(event),
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
    await this.checkStructuredErrors(vm, isolateId);
  }

  /**
   * Ask the app whether framework errors can be reported at all.
   *
   * Subscribing to a stream always succeeds, so until this existed the
   * collector could never report blindness: an empty result looked identical
   * whether the app had thrown nothing or could not tell us that it had. That
   * is precisely the confusion `CollectorHealth` exists to prevent, and this
   * was the one collector not honouring it.
   *
   * `Flutter.Error` is posted by the widget inspector only while
   * `FlutterError.presentError` is its structured reporter, and the framework
   * leaves that off in profile mode and on the web —
   * `isStructuredErrorsEnabled` defaults to `!kIsWeb`. The inspector exposes
   * the current value, so the answer is knowable rather than guessable.
   *
   * The reply is `{enabled: "true"}` — a **string**, measured against a running
   * app. `ext.dart.io.httpEnableTimelineLogging` returns a real boolean from
   * the same protocol, so comparing this one against `true` would have read as
   * blind on every healthy app.
   */
  private async checkStructuredErrors(vm: VmService, isolateId: string): Promise<void> {
    try {
      const reply = await vm.call<{ enabled?: unknown }>(
        "ext.flutter.inspector.structuredErrors",
        { isolateId },
      );
      if (String(reply?.enabled) === "true") return;
      this.state = {
        status: "degraded",
        detail:
          "Structured error reporting is off in this build, so framework errors (Flutter.Error) " +
          "are not observable — the framework disables it in profile mode and on the web. An " +
          "empty exception list here means unobserved, not quiet. Only VM-level " +
          "Debug.PauseException could still appear, and only if the app is set to pause on " +
          "exceptions.",
      };
    } catch {
      // The inspector extension is absent or not registered yet. Do not claim
      // either way: say the check failed, because a false alarm on a healthy app
      // is as misleading as silence on a blind one.
      this.state = {
        status: "degraded",
        detail:
          "Could not confirm whether framework error reporting is enabled " +
          "(ext.flutter.inspector.structuredErrors did not answer), so an empty exception list " +
          "cannot be read as proof that nothing was thrown.",
      };
    }
  }
}
