import type { Collector, CollectorStatus } from "../collectors/collector.js";
import type { Category } from "./events.js";
import { ExceptionCollector } from "../collectors/exceptionCollector.js";
import { FrameCollector } from "../collectors/frameCollector.js";
import { LogCollector } from "../collectors/logCollector.js";
import { NavigationCollector } from "../collectors/navigationCollector.js";
import { NetworkCollector } from "../collectors/networkCollector.js";
import { RebuildCollector } from "../collectors/rebuildCollector.js";
import { RuntimeStore } from "./runtimeStore.js";
import { redactVmServiceUri } from "./redaction.js";
import { costMeter } from "./costMeter.js";
import { StateCollector } from "../collectors/stateCollector.js";
import { VmService } from "../vm/vmService.js";
import { diagnoseUnreachable } from "../vm/adb.js";

export interface ReconnectPolicy {
  /** Delay before the first retry; doubles each attempt. */
  baseMs: number;
  /** Ceiling for the backoff delay. */
  maxMs: number;
  /** Give up after this many consecutive failures. */
  maxAttempts: number;
}

/** One collector's health joined with what the store shows it has produced. */
export interface CollectorReport {
  name: string;
  status: CollectorStatus;
  detail?: string;
  eventsRetained: number;
  lastEventMs: number | null;
}

/** Which store category each collector writes, for liveness reporting. */
const COLLECTOR_CATEGORY: Record<string, Category> = {
  logs: "log",
  exceptions: "exception",
  frames: "frame",
  network: "network",
  navigation: "navigation",
  rebuilds: "rebuild",
  state: "state",
};

export interface ConnectionStatus {
  connected: boolean;
  isolateId: string | null;
  wsUri: string | null;
  /** Current debugging session, or null before the first connect. */
  sessionId: string | null;
  /** True while a reconnect is scheduled or in flight. */
  reconnecting: boolean;
  /** Consecutive failed reconnect attempts. */
  reconnectAttempt: number;
  /**
   * The VM's clock minus this process's, in ms, as last observed on a stream
   * event. Null before any stamped event arrives.
   *
   * Captured events are stamped with the VM's clock; our own notes about the
   * connection, and polled memory samples, are stamped with ours. A large
   * value here means the two are being compared across a real offset, and a
   * timeline that mixes them is off by that much.
   */
  clockOffsetMs: number | null;
}

/**
 * Process-wide singleton owning the live VM connection, the centralized runtime
 * store, and the collector set. MCP tools are stateless (docs/Rules.md) — they
 * hold no state themselves and read/write exclusively through this manager.
 *
 * Collector instances outlive connections, so every connect resets their
 * per-session state and opens a new store session. Without that, a dedup set or
 * a partial log line from the previous app run corrupts the next one, and
 * evidence from two runs sits in a single timeline where correlation will
 * happily invent a cause across the gap.
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
    new NavigationCollector(),
    new RebuildCollector(),
    new StateCollector(),
  ];

  /** Tunable so tests do not wait on real backoff. */
  reconnectPolicy: ReconnectPolicy = { baseMs: 1_000, maxMs: 30_000, maxAttempts: 8 };

  /** True between connect() and disconnect(): an unexpected close should retry. */
  private wantConnection = false;
  private lastUri?: string;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  get connected(): boolean {
    return this.vm?.connected ?? false;
  }

  /** Names of the registered collectors, for capability reporting. */
  collectorNames(): string[] {
    return this.collectors.map((c) => c.name);
  }

  /**
   * Per-collector health: whether the collector can see its domain on this
   * target, plus what the store shows it has produced. This is how an agent
   * distinguishes "no events" from "events are invisible here".
   */
  collectorHealth(): CollectorReport[] {
    const counts = this.store.counts();
    const newest = this.store.newestByCategory();
    return this.collectors.map((c) => {
      const category = COLLECTOR_CATEGORY[c.name];
      return {
        name: c.name,
        ...(c.health?.() ?? { status: "active" as const }),
        eventsRetained: category ? counts[category] : 0,
        lastEventMs: category ? newest[category] : null,
      };
    });
  }

  async connect(uri: string): Promise<{ wsUri: string; isolateId: string; collectors: string[]; sessionId: string }> {
    this.cancelReconnect();
    this.wantConnection = true;
    this.lastUri = uri;
    this.reconnectAttempt = 0;
    this.teardown();
    return this.open(uri, "Connected");
  }

  /** Establish the socket, reset collectors, start a session, and wire streams. */
  private async open(
    uri: string,
    verb: "Connected" | "Reconnected",
  ): Promise<{ wsUri: string; isolateId: string; collectors: string[]; sessionId: string }> {
    const vm = await VmService.connect(uri);
    vm.on("close", () => this.onClose(vm));

    const isolateId = await vm.mainIsolateId();

    // Order matters: drop stale collector state, open the session, then start —
    // so everything a collector emits during startup lands in the new session.
    for (const c of this.collectors) c.reset?.();
    const sessionId = this.store.beginSession();
    // Cost is per debugging session, like every other count here. Without this
    // a reconnect would keep charging the new session for the old one's calls.
    costMeter.reset();
    for (const c of this.collectors) await c.start(vm, this.store, isolateId);

    this.vm = vm;
    this.isolateId_ = isolateId;
    // Redacted before it is stored, and before it is returned. The path
    // segment of a VM Service URI authorises `evaluate` — arbitrary Dart
    // execution in the app — so it must not enter the event store, where
    // what_changed, the dashboard and the session export all read from, and it
    // must not go back to the caller either. The raw URI stays in `lastUri`
    // for reconnect and in VmService for the socket; nothing else needs it.
    const safeUri = redactVmServiceUri(vm.wsUri) ?? "";
    this.store.add({
      timestamp: Date.now(),
      source: "system",
      severity: "info",
      category: "system",
      message: `${verb} to VM Service at ${safeUri}`,
      data: { wsUri: safeUri, isolateId, sessionId },
    });

    return { wsUri: safeUri, isolateId, collectors: this.collectors.map((c) => c.name), sessionId };
  }

  /**
   * The socket dropped. Ignore it if a newer connection has already superseded
   * this one — teardown() clears `this.vm` before close() fires, so a stale
   * socket's close event must not tear down its replacement.
   */
  private onClose(vm: VmService): void {
    if (this.vm !== vm) return;
    this.vm = undefined;
    this.isolateId_ = undefined;
    this.store.add({
      timestamp: Date.now(),
      source: "system",
      severity: "warning",
      category: "system",
      message: "VM Service connection closed",
      data: {},
    });
    if (this.wantConnection && this.lastUri) this.scheduleReconnect();
  }

  /**
   * Exponential backoff, bounded. Every attempt is recorded as a system event
   * so the gap shows up in the evidence timeline rather than as dead air an
   * agent would read as "the app went quiet".
   */
  private scheduleReconnect(): void {
    const { baseMs, maxMs, maxAttempts } = this.reconnectPolicy;
    if (this.reconnectAttempt >= maxAttempts) {
      // The terminal event is recorded synchronously and unconditionally. An
      // earlier version awaited an adb probe first so it could explain WHY,
      // which made the most important record in the timeline depend on an
      // optional external process: if adb is slow the event arrives late, if
      // adb hangs it never arrives at all, and an agent polling status sees
      // reconnecting:false with nothing in the evidence explaining it.
      this.store.add({
        timestamp: Date.now(),
        source: "system",
        severity: "error",
        category: "system",
        message: `Gave up reconnecting after ${maxAttempts} attempts. Call connect_vm with a fresh URI.`,
        data: { attempts: maxAttempts },
      });
      this.wantConnection = false;

      // The explanation is worth having, so it still runs — as a separate,
      // later event that enriches the timeline rather than gating it.
      void diagnoseUnreachable()
        .then((transport) => {
          if (transport.length === 0) return;
          this.store.add({
            timestamp: Date.now(),
            source: "system",
            severity: "info",
            category: "system",
            message: "Why the VM Service is unreachable",
            data: { transport },
          });
        })
        .catch(() => {
          /* adb is optional; its absence must never surface as an error here */
        });
      return;
    }

    const attempt = ++this.reconnectAttempt;
    const delayMs = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
    this.store.add({
      timestamp: Date.now(),
      source: "system",
      severity: "info",
      category: "system",
      message: `Reconnecting in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`,
      data: { attempt, maxAttempts, delayMs },
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.wantConnection || !this.lastUri) return;
      this.open(this.lastUri, "Reconnected")
        .then(() => {
          this.reconnectAttempt = 0;
        })
        .catch((err: unknown) => {
          this.store.add({
            timestamp: Date.now(),
            source: "system",
            severity: "warning",
            category: "system",
            message: `Reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
            data: { attempt },
          });
          this.scheduleReconnect();
        });
    }, delayMs);
    this.reconnectTimer.unref?.(); // never hold the process open on a retry
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** Close the socket without arming a reconnect. */
  private teardown(): void {
    const vm = this.vm;
    if (!vm) return;
    this.vm = undefined;
    this.isolateId_ = undefined;
    vm.close();
  }

  /** Pull-on-demand collectors (e.g. HTTP profile) update the store now. */
  async refreshPullCollectors(): Promise<void> {
    if (!this.vm || !this.isolateId_) return;
    for (const c of this.collectors) {
      if (c.refresh) await c.refresh(this.vm, this.store, this.isolateId_);
    }
  }

  async disconnect(): Promise<void> {
    this.wantConnection = false;
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    this.teardown();
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
  status(): ConnectionStatus {
    return {
      connected: this.connected,
      isolateId: this.isolateId_ ?? null,
      wsUri: redactVmServiceUri(this.vm?.wsUri ?? null),
      sessionId: this.store.currentSession(),
      reconnecting: this.reconnectTimer !== undefined,
      reconnectAttempt: this.reconnectAttempt,
      clockOffsetMs: this.vm?.clockOffsetMs ?? null,
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
