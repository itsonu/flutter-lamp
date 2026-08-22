import type { Collector } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { Severity } from "../core/events.js";
import type { VmService } from "../vm/vmService.js";
import { redactHeaders, redactText, redactUri } from "../core/redaction.js";

/**
 * HTTP traffic via the official dart:io profiling extensions.
 *
 * There is no push stream for HTTP requests, so this collector is pull-on-demand
 * (`refresh` — invoked by the get_network tool). This is not background polling:
 * we only fetch when the AI asks. `httpEnableTimelineLogging` is turned on at
 * start so the profile is populated. Because dart:io's HttpClient backs Dio and
 * package:http on mobile, Dio/HTTP traffic is captured without any interceptor.
 *
 * Headers and query strings are redacted here, at capture, so credentials never
 * enter the store (see core/redaction.ts).
 */
export class NetworkCollector implements Collector {
  readonly name = "network";
  /** Request ids already stored as completed, so refresh() stays idempotent. */
  private stored = new Set<string>();

  async start(vm: VmService, _store: RuntimeStore, isolateId: string): Promise<void> {
    try {
      await vm.call("ext.dart.io.httpEnableTimelineLogging", {
        isolateId,
        enabled: true,
      });
    } catch {
      // Extension unavailable (e.g. web target) — get_network will simply find nothing.
    }
  }

  async refresh(vm: VmService, store: RuntimeStore, isolateId: string): Promise<void> {
    let profile: any;
    try {
      profile = await vm.call("ext.dart.io.getHttpProfile", { isolateId });
    } catch {
      return; // profiling not supported on this target
    }
    const requests: any[] = profile?.requests ?? [];
    for (const r of requests) {
      const id = String(r.id);
      if (this.stored.has(id)) continue;
      const status: number | undefined = r.response?.statusCode;
      const complete = r.response !== undefined || r.endTime !== undefined;
      if (!complete) continue; // still in-flight; catch it on a later refresh

      this.stored.add(id);
      const rawError: string | undefined = r.request?.error ?? r.response?.error;
      const errorMsg = rawError === undefined ? undefined : redactText(rawError);
      let severity: Severity = "info";
      if (errorMsg) severity = "error";
      else if (status !== undefined && status >= 500) severity = "error";
      else if (status !== undefined && status >= 400) severity = "warning";

      const method: string = r.method ?? "?";
      const uri: string = redactUri(r.uri ?? "");
      const data: Record<string, unknown> = {
        requestId: id,
        method,
        uri,
        statusCode: status,
        error: errorMsg,
        startTimeMs: microsToMs(r.startTime),
        endTimeMs: microsToMs(r.endTime),
        durationMs:
          r.startTime !== undefined && r.endTime !== undefined
            ? round2((r.endTime - r.startTime) / 1000)
            : undefined,
        contentLength: r.response?.contentLength,
      };

      // Enrich failing/slow requests with headers + error detail (one extra RPC,
      // only for the interesting ones, and only once — dedup via `stored`).
      if (severity !== "info") {
        try {
          const full: any = await vm.call("ext.dart.io.getHttpProfileRequest", {
            isolateId,
            id: r.id,
          });
          const req = full?.request ?? {};
          const res = full?.response ?? {};
          const reqHeaders = redactHeaders(flattenHeaders(req.headers));
          const resHeaders = redactHeaders(flattenHeaders(res.headers));
          data.requestHeaders = reqHeaders.headers;
          data.responseHeaders = resHeaders.headers;
          const withheld = [...reqHeaders.redacted, ...resHeaders.redacted];
          if (withheld.length > 0) data.redactedHeaders = withheld;
          data.responseReason = res.reasonPhrase;
          const detail = req.error ?? res.error;
          data.detailError = typeof detail === "string" ? redactText(detail) : detail;
        } catch {
          // detail unavailable — keep the summary record
        }
      }

      store.add({
        timestamp: microsToMs(r.startTime) ?? Date.now(),
        source: "HttpProfile",
        severity,
        category: "network",
        message: `${method} ${uri} → ${errorMsg ? `ERROR ${errorMsg}` : (status ?? "?")}`,
        data,
      });
    }
  }
}

/** VM header maps are name -> string[]; collapse to name -> string for readability. */
function flattenHeaders(h: unknown): Record<string, string> | undefined {
  if (!h || typeof h !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function microsToMs(us: number | undefined): number | undefined {
  return us === undefined ? undefined : Math.round(us / 1000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
