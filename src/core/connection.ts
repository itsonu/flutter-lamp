import type { Collector } from "../collectors/collector.js";
import { ExceptionCollector } from "../collectors/exceptionCollector.js";
import { FrameCollector } from "../collectors/frameCollector.js";
import { LogCollector } from "../collectors/logCollector.js";
import { NetworkCollector } from "../collectors/networkCollector.js";
import { RuntimeStore } from "./runtimeStore.js";
import { VmService } from "../vm/vmService.js";

/**
 * Process-wide singleton owning the live VM connection, the centralized runtime
 * store, and the collector set. MCP tools are stateless (docs/Rules.md) — they
 * hold no state themselves and read/write exclusively through this manager.
 */
class ConnectionManager {
  private vm?: VmService;
  private isolateId_?: string;
  readonly store = new RuntimeStore();
  private readonly collectors: Collector[] = [
    new LogCollector(),
    new ExceptionCollector(),
    new FrameCollector(),
    new NetworkCollector(),
  ];

  get connected(): boolean {
    return this.vm?.connected ?? false;
  }

  async connect(uri: string): Promise<{ wsUri: string; isolateId: string; collectors: string[] }> {
    await this.disconnect();
    const vm = await VmService.connect(uri);
    vm.on("close", () => {
      this.store.add({
        timestamp: Date.now(),
        source: "system",
        severity: "warning",
        category: "system",
        message: "VM Service connection closed",
        data: {},
      });
      this.vm = undefined;
      this.isolateId_ = undefined;
    });

    const isolateId = await vm.mainIsolateId();
    for (const c of this.collectors) {
      await c.start(vm, this.store, isolateId);
    }

    this.vm = vm;
    this.isolateId_ = isolateId;
    this.store.add({
      timestamp: Date.now(),
      source: "system",
      severity: "info",
      category: "system",
      message: `Connected to VM Service at ${vm.wsUri}`,
      data: { wsUri: vm.wsUri, isolateId },
    });

    return {
      wsUri: vm.wsUri,
      isolateId,
      collectors: this.collectors.map((c) => c.name),
    };
  }

  /** Pull-on-demand collectors (e.g. HTTP profile) update the store now. */
  async refreshPullCollectors(): Promise<void> {
    if (!this.vm || !this.isolateId_) return;
    for (const c of this.collectors) {
      if (c.refresh) await c.refresh(this.vm, this.store, this.isolateId_);
    }
  }

  async disconnect(): Promise<void> {
    if (this.vm) {
      this.vm.close();
      this.vm = undefined;
      this.isolateId_ = undefined;
    }
  }

  requireConnectedOrThrow(): void {
    if (!this.connected) {
      throw new Error(
        "Not connected to a Flutter VM Service. Call connect_vm with the ws:// URI from `flutter run` first.",
      );
    }
  }

  get isolateId(): string {
    if (!this.isolateId_) throw new Error("No isolate — connect first.");
    return this.isolateId_;
  }

  /** Raw VM Service RPC (requires a live connection). Used by query-style tools. */
  async vmCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requireConnectedOrThrow();
    return this.vm!.call<T>(method, params);
  }

  /** RPC scoped to the main isolate (auto-injects isolateId). */
  async isolateCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.vmCall<T>(method, { isolateId: this.isolateId, ...params });
  }

  /** Connection status snapshot (safe to call when disconnected). */
  status(): { connected: boolean; isolateId: string | null; wsUri: string | null } {
    return {
      connected: this.connected,
      isolateId: this.isolateId_ ?? null,
      wsUri: this.vm?.wsUri ?? null,
    };
  }

  /**
   * Sample current isolate memory (MB), record it into runtime history, and
   * return it. Shared by the `get_memory` tool and the dashboard's live sampler
   * so the logic lives in exactly one place.
   */
  async sampleMemory(): Promise<{ heapUsageMB: number; heapCapacityMB: number; externalUsageMB: number }> {
    const m = await this.isolateCall<{ heapUsage: number; heapCapacity: number; externalUsage: number }>(
      "getMemoryUsage",
    );
    const snapshot = {
      heapUsageMB: bytesToMb(m.heapUsage),
      heapCapacityMB: bytesToMb(m.heapCapacity),
      externalUsageMB: bytesToMb(m.externalUsage),
    };
    this.store.add({
      timestamp: Date.now(),
      source: "getMemoryUsage",
      severity: "info",
      category: "system",
      message: `Heap ${snapshot.heapUsageMB}MB / cap ${snapshot.heapCapacityMB}MB, external ${snapshot.externalUsageMB}MB`,
      data: snapshot,
    });
    return snapshot;
  }
}

function bytesToMb(b: number | undefined): number {
  return b === undefined ? 0 : Math.round((b / (1024 * 1024)) * 100) / 100;
}

export const connection = new ConnectionManager();
