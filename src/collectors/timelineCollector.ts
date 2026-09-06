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
 * ## Only GC, and only the outermost collections
 *
 * The VM will record Dart, Compiler and Embedder streams too. It is not done
 * here: those are the streams that fill the recorder's ~24,500-event buffer and
 * stall it (see `vm/timelineStaleness.ts`), and none of them answers a question
 * the stored evidence cannot already answer. GC is the gap, so GC is the slice.
 *
 * ## What counts as a pause, measured rather than assumed
 *
 * Read off a physical device (Android 16, Dart 3.12), a 32,313-event timeline
 * contained **no `ph: "X"` events at all** — the Dart VM emits `B`/`E` pairs, so
 * a collector filtering on complete events stores nothing, forever. Durations
 * are recovered by matching each `E` to the nearest open `B` on the same
 * (name, thread).
 *
 * Not every `cat: "GC"` event is a pause, and treating them as one would inflate
 * the evidence badly:
 *
 * - The names are **nested phases of one collection**, not separate collections.
 *   In the same capture `Scavenge` measured p50 1.775ms while its parent
 *   `CollectNewGeneration` measured p50 1.915ms — summing both double-counts the
 *   same stall.
 * - `ConcurrentMark` measured p50 8.1ms and max 63ms, and runs *concurrently
 *   with* the mutator. Calling that a pause would attribute 63ms of jank to work
 *   that never stopped the app.
 * - `NotifyIdle` (208 of the 810 GC events in that window) is an idle
 *   notification, not a collection.
 *
 * So only the outermost stop-the-world collections are stored. Everything else
 * is either nested inside one of them or genuinely concurrent.
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
/**
 * The names that are stop-the-world collections rather than phases inside one.
 *
 * Deliberately a short allow-list rather than "everything with cat GC". Measured
 * on device, a single `CollectNewGeneration` contains `Prologue`, `Scavenge`,
 * `IterateIsolateRoots`, `IterateStoreBuffers`, `MournWeakHandles`, `Epilogue`
 * and more; storing them all would count one 2ms stall a dozen times over. The
 * two names here are the outermost spans, so each collection contributes its
 * pause exactly once.
 *
 * `ConcurrentMark`, `ParallelMark` and `IncrementalMarkWithSizeBudget` are
 * excluded on purpose: they overlap the mutator rather than stopping it, and the
 * largest of them measured 63ms — attributing that to jank would be inventing a
 * stall the app never suffered.
 */
const GC_PAUSE_NAMES = new Set(["CollectNewGeneration", "CollectOldGeneration"]);

interface PauseSpan {
  name: string;
  /** Monotonic microseconds at the Begin marker. */
  ts: number;
  durMs: number;
  tid: string;
}

/**
 * Recover complete pause spans from the VM's Begin/End markers.
 *
 * The Dart VM emits `ph: "B"` and `ph: "E"` with no duration; a span's length is
 * the difference between a Begin and the End that closes it on the same thread.
 * Markers are nested, so Begins are kept on a per-(name, thread) stack and each
 * End closes the most recent one.
 *
 * Both halves of an unmatched pair are dropped rather than guessed. The recorder
 * is a ring buffer, so the oldest Begins get overwritten while their Ends
 * survive, and a collection still running when we read has a Begin with no End
 * yet. Inventing a duration for either would put a fabricated pause into the
 * evidence.
 */
function pauseSpans(raw: Array<Record<string, unknown>>): PauseSpan[] {
  const events = raw
    .filter((e) => e.cat === "GC" && typeof e.name === "string" && GC_PAUSE_NAMES.has(e.name as string))
    .filter((e) => typeof e.ts === "number")
    .sort((a, b) => (a.ts as number) - (b.ts as number));

  const open = new Map<string, number[]>();
  const out: PauseSpan[] = [];
  for (const e of events) {
    const name = e.name as string;
    const tid = String(e.tid ?? "");
    const ts = e.ts as number;
    const key = `${name}|${tid}`;
    if (e.ph === "B") {
      const stack = open.get(key) ?? [];
      stack.push(ts);
      open.set(key, stack);
    } else if (e.ph === "E") {
      const start = open.get(key)?.pop();
      if (start === undefined) continue; // End whose Begin was evicted.
      out.push({ name, ts: start, durMs: Math.round(((ts - start) / 1000) * 100) / 100, tid });
    }
  }
  return out;
}

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

    for (const { name, ts, durMs, tid } of pauseSpans(raw)) {
      const key = `${ts}:${tid}:${name}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

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
          phase: "B/E",
          durMs,
          /** Raw monotonic timestamp of the Begin marker, so the mapping stays auditable. */
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
