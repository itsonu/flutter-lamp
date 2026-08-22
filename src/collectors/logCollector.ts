import type { Collector } from "./collector.js";
import { decodeBytes } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { Severity } from "../core/events.js";
import type { VmService } from "../vm/vmService.js";
import { redactText } from "../core/redaction.js";

/** Map dart:developer log levels (0..2000) to our severity scale. */
function levelToSeverity(level: number): Severity {
  if (level >= 1000) return "error"; // SEVERE / SHOUT
  if (level >= 900) return "warning"; // WARNING
  if (level >= 700) return "info"; // INFO / CONFIG
  return "debug"; // FINE / FINER / FINEST
}

/**
 * Console + structured logging: Stdout, Stderr and the `Logging` stream.
 * Multi-line writes are buffered until a newline so each log line is one event.
 *
 * Log text is redacted at capture — developers print tokens (see
 * core/redaction.ts).
 */
export class LogCollector implements Collector {
  readonly name = "logs";
  private carry: Record<string, string> = { Stdout: "", Stderr: "" };

  /** Drop the incomplete tail, so it is not prepended to the next run's first line. */
  reset(): void {
    this.carry = { Stdout: "", Stderr: "" };
  }

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    await vm.streamListen("Stdout");
    await vm.streamListen("Stderr");
    await vm.streamListen("Logging");

    for (const streamId of ["Stdout", "Stderr"] as const) {
      vm.on(`stream:${streamId}`, (event: any) => {
        if (event?.kind !== "WriteEvent") return;
        const text = this.carry[streamId] + decodeBytes(event.bytes);
        const lines = text.split("\n");
        this.carry[streamId] = lines.pop() ?? ""; // keep incomplete tail
        const severity: Severity = streamId === "Stderr" ? "error" : "info";
        for (const raw of lines) {
          if (raw.trim() === "") continue;
          const line = redactText(raw);
          store.add({
            timestamp: Date.now(),
            source: streamId,
            severity,
            category: "log",
            message: line,
            data: { stream: streamId, line },
          });
        }
      });
    }

    vm.on("stream:Logging", (event: any) => {
      const rec = event?.logRecord;
      if (!rec) return;
      const level: number = rec.level ?? 0;
      const message = redactText(rec.message?.valueAsString ?? "");
      const loggerName = rec.loggerName?.valueAsString ?? "";
      store.add({
        timestamp: rec.time ?? Date.now(),
        source: "Logging",
        severity: levelToSeverity(level),
        category: "log",
        message: loggerName ? `[${loggerName}] ${message}` : message,
        data: {
          level,
          loggerName,
          error: redactText(rec.error?.valueAsString ?? "") || undefined,
          stackTrace: redactText(rec.stackTrace?.valueAsString ?? "") || undefined,
        },
      });
    });
  }
}
