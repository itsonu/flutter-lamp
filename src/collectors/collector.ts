import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

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
}

/** Decode a base64 WriteEvent payload to text. */
export function decodeBytes(bytes: string | undefined): string {
  if (!bytes) return "";
  return Buffer.from(bytes, "base64").toString("utf8");
}
