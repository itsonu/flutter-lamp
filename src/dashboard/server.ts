import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { connection } from "../core/connection.js";
import type { RuntimeEvent } from "../core/events.js";

/**
 * Realtime Runtime Dashboard (Phase 12).
 *
 * A standalone HTTP + WebSocket server, completely independent of the MCP stdio
 * transport, so Claude Code (stdio) and a browser can observe the same running
 * app simultaneously. It reuses the centralized RuntimeStore as its ONLY event
 * source — no collector logic is duplicated here; it just fans store events out
 * to connected browsers.
 */

const HTML_PATH = fileURLToPath(new URL("../../dashboard/index.html", import.meta.url));
// Memory has no VM push stream, so a live chart needs sampling. We gate it to
// "someone is watching AND connected" so it never runs in the background.
// ponytail: 2s poll of getMemoryUsage, only while a browser is open.
const MEMORY_SAMPLE_MS = 2000;

export interface DashboardHandle {
  url: string;
  close: () => Promise<void>;
}

let current: { url: string; running: boolean } = { url: "", running: false };

export function getDashboardInfo(): { url: string | null; running: boolean } {
  return { url: current.url || null, running: current.running };
}

export async function startDashboard(): Promise<DashboardHandle> {
  const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
  const port = Number(process.env.DASHBOARD_PORT ?? 7373);
  const store = connection.store;

  let html: string;
  try {
    html = readFileSync(HTML_PATH, "utf8");
  } catch (err) {
    throw new Error(`Dashboard UI not found at ${HTML_PATH}: ${(err as Error).message}`);
  }

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]; // ignore query string
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } else if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...connection.status() }));
    } else {
      res.writeHead(404).end("not found");
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const clients = new Set<WebSocket>();

  const send = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  const broadcast = (payload: unknown) => {
    const data = JSON.stringify(payload);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  // Single store subscription, fanned out to all browsers.
  const onEvent = (event: RuntimeEvent) => {
    broadcast({ type: "event", event });
    if (event.category === "system") broadcast({ type: "status", status: connection.status() });
  };
  const onClear = () => broadcast({ type: "cleared" });
  store.on("event", onEvent);
  store.on("clear", onClear);

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    // Snapshot: oldest→newest so the client can append in order.
    send(ws, {
      type: "snapshot",
      status: connection.status(),
      events: store.query({ limit: 1000 }).reverse(),
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Gated memory sampler.
  const sampler = setInterval(() => {
    if (clients.size > 0 && connection.connected) {
      connection.sampleMemory().catch(() => {});
    }
  }, MEMORY_SAMPLE_MS);
  sampler.unref?.(); // don't keep the process alive on the sampler alone

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const url = `http://${host}:${port}`;
  current = { url, running: true };

  return {
    url,
    close: async () => {
      clearInterval(sampler);
      store.off("event", onEvent);
      store.off("clear", onClear);
      for (const ws of clients) ws.terminate();
      clients.clear();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      current = { url, running: false };
    },
  };
}
