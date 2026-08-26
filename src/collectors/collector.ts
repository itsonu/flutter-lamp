import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Whether a collector can actually see its domain on this target.
 *
 * Collectors fail politely by design — a missing service extension must not
 * take down the session — but a silent failure turns "no events" into a lie:
 * an agent reading an empty network list cannot tell "no requests happened"
 * from "requests are invisible here". Health makes the difference explicit.
 */
export type CollectorStatus = "active" | "degraded" | "unavailable";

export interface CollectorHealth {
  status: CollectorStatus;
  /** Why the collector is not fully active, written for the agent to read. */
  detail?: string;
}

/**
 * A collector wires one class of VM Service data into the centralized store.
 * New runtime sources (Inspector, Timeline, Memory…) are added by implementing
 * this interface — the rest of the architecture is untouched (docs/Rules.md,
 * "future capabilities can be added without changing the architecture").
 */
export interface Collector {
  readonly name: string;
  /** Subscribe to streams / enable service extensions. */
  start(vm: VmService, store: RuntimeStore, isolateId: string): Promise<void>;
  /** Pull-on-demand refresh for sources without a push stream (e.g. HTTP profile). Optional. */
  refresh?(vm: VmService, store: RuntimeStore, isolateId: string): Promise<void>;
  /**
   * Drop per-session state. Called before every connect, because collector
   * instances outlive connections: a dedup set or a partial-line buffer carried
   * into a new app run silently corrupts the next session's evidence.
   */
  reset?(): void;
  /** Current health. Omitted means active whenever start() succeeded. */
  health?(): CollectorHealth;
}

/** Decode a base64 WriteEvent payload to text. */
export function decodeBytes(bytes: string | undefined): string {
  if (!bytes) return "";
  return Buffer.from(bytes, "base64").toString("utf8");
}

/**
 * When the app posted an event, not when we happened to receive it.
 *
 * Every VM Service `Event` carries a `timestamp` from the VM's own clock, and
 * receipt time is not a usable substitute for it. DDS delivers a backlog the
 * instant a stream subscription is accepted, and a slow link stalls and then
 * flushes, so `Date.now()` collapses distinct moments onto one.
 *
 * Measured against a running app rather than assumed: six backlog frames
 * arrived within 1ms of each other by receipt while their posted times were
 * spread across 331ms, and a nine-second session lost 1.1s of its span. Over
 * adb/WiFi it is worse — 111 frame events landing inside one second, above any
 * refresh rate. Everything that reasons about order or windows (correlation,
 * baseline-vs-incident comparison, a timeline handed to a human) is wrong by
 * exactly that much.
 *
 * Falls back to receipt time: a slightly misplaced event beats a dropped one.
 */
export function eventTime(event: unknown): number {
  const ts = (event as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
}
