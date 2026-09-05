import type { Collector, CollectorHealth } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Garbage-collection pauses from the VM timeline.
 *
 * This closes the one correlation input `diagnose_performance` was missing.
 * Memory, frames, network, route and state activity were all stored and
 * correlated; the timeline was fetched on demand by `get_timeline` and thrown
 * away, so the diagnosis could only ever say GC pauses "cannot be ruled in or
 * out". Storing them makes both answers possible — including the negative.
 *
 * ## Only GC, and only complete events
 *
 * The VM will record Dart, Compiler and Embedder streams too. It is not done
 * here: those are the streams that fill the recorder's ~24,500-event buffer and
 * stall it (see `vm/timelineStaleness.ts`), and none of them answers a question
 * the stored evidence cannot already answer. GC is the gap, so GC is the slice.
 *
 * Only `ph: "X"` events are kept. A complete event carries `dur`, which is the
 * pause length — the single fact the correlation needs. `B`/`E` pairs would have
 * to be matched up across the buffer to recover the same number, and an
 * unmatched `B` has no duration at all.
 *
 * ## The clock, which is the whole difficulty
 *
 * Timeline `ts` is **monotonic microseconds since VM start**. Every other event
 * in the store is stamped in **epoch milliseconds from the VM's own clock**
 * (`eventTime`). The two cannot be compared without an anchor, and picking the
 * wrong anchor silently corrupts every window:
 *
 * - `getVMTimelineMicros` gives "now" on the monotonic clock, so
 *   `now - ts` is the event's age, which is reliable.
 * - Converting that age to an epoch instant needs an epoch "now" **on the VM's
 *   clock, not ours**. Measured on a physical device, the VM's clock ran 839ms
 *   behind the host's — nearly a third of the 3s correlation window. Anchoring
 *   on `Date.now()` would offset every GC event from every frame by exactly
 *   that much, in a comparison whose entire purpose is sub-frame overlap.
 *
 * So the anchor is `Date.now() + vm.clockOffsetMs`, reusing the offset the
 * VmService already measures from stream-event timestamps.
 *
 * When the offset has not been observed yet, or the VM will not report its
 * timeline clock, events are **not stored**. A GC pause with a guessed
 * timestamp is worse than no GC pause: it would be correlated against frames
 * as if it were evidence.
 */
export class TimelineCollector implements Collector {
  readonly name = "timeline";
  /**
   * `getVMTimeline` returns the whole ring buffer on every read, so refresh
   * would re-store everything it already has. Keyed on the monotonic timestamp
   * and thread, which are unique per event and stable across reads.
   */
  private seen = new Set<string>();
  private state: CollectorHealth = { status: "active" };

  health(): CollectorHealth {
    return this.state;
  }

  /**
   * Monotonic timestamps restart at zero in a new app run, so a dedup set kept
   * across a reconnect would make the new session's GC events look like
   * duplicates of the old one's and drop them.
   */
  reset(): void {
    this.seen.clear();
    this.state = { status: "active" };
  }

  async start(vm: VmService, _store: RuntimeStore, _isolateId: string): Promise<void> {
    try {
      // Union, never replace. `setVMTimelineFlags` overwrites the recorded set,
      // and `get_timeline` with recordFrom:true deliberately turns on Dart,
      // Compiler and Embedder. Narrowing that here would break a tool contract
      // from a collector, which is not this collector's business.
      const flags = await vm.call<{ recordedStreams?: unknown }>("getVMTimelineFlags");
      const current = Array.isArray(flags?.recordedStreams)
        ? flags.recordedStreams.filter((s): s is string => typeof s === "string")
        : [];
      if (!current.includes("GC")) {
        await vm.call("setVMTimelineFlags", { recordedStreams: [...current, "GC"] });
      }
    } catch {
      this.state = {
        status: "unavailable",
        detail:
          "This target has no VM timeline: a web target runs on DWDS rather than a Dart VM and does not " +
          "implement getVMTimelineFlags. Empty GC evidence means garbage collection is invisible here, " +
          "not that none happened — so GC can be neither ruled in nor out on this target.",
      };
    }
  }

  async refresh(vm: VmService, store: RuntimeStore, _isolateId: string): Promise<void> {
    let raw: Array<Record<string, unknown>>;
    try {
      const tl = await vm.call<{ traceEvents?: unknown }>("getVMTimeline");
      raw = Array.isArray(tl?.traceEvents) ? (tl.traceEvents as Array<Record<string, unknown>>) : [];
    } catch {
      this.state = {
        status: "unavailable",
        detail:
          "This target does not implement getVMTimeline, so garbage-collection pauses cannot be observed. " +
          "Empty GC evidence here means invisible, not absent.",
      };
      return;
    }

    const nowMicros = await vm
      .call<{ timestamp?: unknown }>("getVMTimelineMicros")
      .then((r) => (typeof r?.timestamp === "number" ? r.timestamp : null))
      .catch(() => null);

    const offset = vm.clockOffsetMs;
    if (nowMicros === null || offset === null) {
      // Deliberately stores nothing. The events exist and are readable through
      // `get_timeline`, but they cannot be placed on the same axis as frames,
      // and an unplaceable event correlated against a frame window is a
      // fabricated coincidence.
      this.state = {
        status: "degraded",
        detail:
          nowMicros === null
            ? "The VM will not report its timeline clock (getVMTimelineMicros), so timeline events cannot be " +
              "placed on the same time axis as frames. They are readable through get_timeline but are not " +
              "stored, because correlating an event with an unknown timestamp would invent the coincidence."
            : "The VM-to-host clock offset has not been observed yet (no stamped stream event has arrived), so " +
              "timeline events cannot be placed on the same axis as frames without inheriting the skew. " +
              "They are not stored until it is known; one stream event from the app is enough.",
      };
      return;
    }

    // The anchor: epoch "now" on the VM's clock, not the host's.
    const vmEpochNow = Date.now() + offset;
    let stored = 0;

    for (const e of raw) {
      if (e.cat !== "GC" || e.ph !== "X") continue;
      const ts = e.ts;
      const dur = e.dur;
      if (typeof ts !== "number" || typeof dur !== "number") continue;
      const key = `${ts}:${String(e.tid ?? "")}:${String(e.name ?? "")}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      const durMs = Math.round((dur / 1000) * 100) / 100;
      const name = typeof e.name === "string" ? e.name : "GC";
      store.add({
        // `ts` is the event's START; `dur` runs forward from it. The frame
        // collector stores a completion instant, so the two spans are built
        // differently and the diagnosis must not assume otherwise.
        timestamp: Math.round(vmEpochNow - (nowMicros - ts) / 1000),
        source: "VMTimeline",
        // Not a warning. A long concurrent-marking phase is not a pause, and
        // severity here would assert a problem the duration alone cannot
        // support. The diagnosis does the reasoning; this only records.
        severity: "debug",
        category: "timeline",
        message: `GC ${name} ${durMs}ms`,
        data: {
          name,
          cat: "GC",
          phase: "X",
          durMs,
          /** Raw monotonic timestamp, kept so the mapping stays auditable. */
          tsMicros: ts,
          /** How `timestamp` was derived, so a reader can check it. */
          clockAnchor: { vmEpochNowMs: vmEpochNow, nowMicros, clockOffsetMs: offset },
        },
      });
      stored++;
    }

    if (this.state.status !== "active" && stored > 0) this.state = { status: "active" };
  }
}
