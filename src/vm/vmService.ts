import { EventEmitter } from "node:events";
import WebSocket from "ws";

/**
 * Minimal client for the Dart VM Service Protocol.
 *
 * The VM Service speaks JSON-RPC 2.0 over a WebSocket. We use the official
 * protocol RPCs directly (getVM, streamListen, callServiceExtension, …) rather
 * than scraping DevTools (docs/Rules.md). Stream events arrive as JSON-RPC
 * notifications with method "streamNotify" and are re-emitted as
 * `stream:<streamId>` events for collectors to subscribe to.
 *
 * Spec: https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md
 */
export class VmService extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(public readonly wsUri: string) {
    super();
  }

  /**
   * Normalize a VM Service URI to its WebSocket form and connect.
   * Accepts the http(s) URI printed by `flutter run` or a ws(s) URI directly.
   *   http://127.0.0.1:PORT/TOKEN=/  ->  ws://127.0.0.1:PORT/TOKEN=/ws
   */
  static async connect(uri: string, timeoutMs = 10_000): Promise<VmService> {
    const wsUri = VmService.toWsUri(uri);
    const svc = new VmService(wsUri);
    await svc.open(timeoutMs);
    return svc;
  }

  static toWsUri(uri: string): string {
    let u = uri.trim();
    u = u.replace(/^http/, "ws");
    if (!u.endsWith("/ws")) {
      u = u.endsWith("/") ? `${u}ws` : `${u}/ws`;
    }
    return u;
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUri);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`VM Service connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("message", (raw) => this.onMessage(raw.toString()));
      ws.on("close", () => {
        this.failAllPending(new Error("VM Service connection closed"));
        this.emit("close");
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    // Stream notification (no id): re-emit for collectors.
    if (msg.method === "streamNotify" && msg.params) {
      const { streamId, event } = msg.params;
      this.emit(`stream:${streamId}`, event);
      this.emit("streamNotify", streamId, event);
      return;
    }

    // Response to a request.
    if (msg.id !== undefined) {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(String(msg.id));
      if (msg.error) {
        p.reject(
          new Error(
            `VM Service error ${msg.error.code}: ${msg.error.message ?? "unknown"}`,
          ),
        );
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Send a JSON-RPC request and await its result. */
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("VM Service is not connected"));
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Subscribe to a VM stream. Safe to call when already subscribed (code 103 tolerated). */
  async streamListen(streamId: string): Promise<void> {
    try {
      await this.call("streamListen", { streamId });
    } catch (err) {
      // 103 = stream already subscribed — not an error for us.
      if (!(err instanceof Error) || !err.message.includes("103")) throw err;
    }
  }

  /** Resolve the id of the main (first) isolate. */
  async mainIsolateId(): Promise<string> {
    const vm = await this.call<{ isolates: Array<{ id: string }> }>("getVM");
    const first = vm.isolates?.[0];
    if (!first) throw new Error("No isolates found on the VM");
    return first.id;
  }

  close(): void {
    this.ws?.close();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
