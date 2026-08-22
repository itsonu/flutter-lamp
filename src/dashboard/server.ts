import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
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
 *
 * Security: binding to loopback does NOT protect a WebSocket. Browsers exempt
 * WebSocket from the same-origin policy and send no preflight, so without a
 * check any page the developer has open could connect to ws://127.0.0.1:7373/ws
 * and read the whole runtime stream (cross-site WebSocket hijacking). Two
 * defences: the handshake requires a per-process token that is only obtainable
 * by reading the served HTML — which cross-origin script cannot do — and the
 * Origin header, when present, must be loopback.
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
let wsToken = "";

/** The per-process WebSocket handshake token. Exposed for tests. */
export function dashboardWsToken(): string {
  return wsToken;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function getDashboardInfo(): { url: string | null; running: boolean } {
  return { url: current.url || null, running: current.running };
}

export async function startDashboard(): Promise<DashboardHandle> {
  const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
  const port = Number(process.env.DASHBOARD_PORT ?? 7373);
  const store = connection.store;

  if (!isLoopback(host)) {
    console.error(
      `[flutter-lamp] WARNING: dashboard bound to ${host}, not loopback. Runtime evidence ` +
        `(logs, network, exceptions) is reachable from your network. Only do this on a network you trust.`,
    );
  }

  let html: string;
  try {
    html = readFileSync(HTML_PATH, "utf8");
  } catch (err) {
    throw new Error(`Dashboard UI not found at ${HTML_PATH}: ${(err as Error).message}`);
  }

  // The WebSocket handshake requires this token. It reaches the page by being
  // inlined into the HTML: same-origin script reads it, cross-origin script
  // cannot read the response body, so a hostile tab cannot obtain it.
  const token = randomUUID();
  html = html.replace(
    "</head>",
    `<script>window.__LAMP_TOKEN__=${JSON.stringify(token)}</script></head>`,
  );

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]; // ignore query string
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // The page carries the WebSocket token, so never let it be framed.
        "x-frame-options": "DENY",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
      });
      res.end(html);
    } else if (path === "/health") {
      // Liveness only. `wsUri` is deliberately withheld — it embeds the VM
      // Service auth token; it goes over the token-gated WebSocket instead.
      const { connected, isolateId } = connection.status();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, connected, isolateId }));
    } else {
      res.writeHead(404).end("not found");
    }
  });

  // Bind before anything that needs the port: DASHBOARD_PORT=0 asks the OS for
  // a free one, which is how tests avoid colliding with a real dashboard.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  const allowedOrigins = new Set([
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
    `http://[::1]:${boundPort}`,
    `http://${host}:${boundPort}`,
  ]);

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    verifyClient: ({ origin, req }, done) => {
      // A browser always sends Origin; a native client (tests, CLI) sends none.
      if (origin && !allowedOrigins.has(origin)) return done(false, 403, "forbidden origin");
      const supplied = new URL(req.url ?? "/", "http://localhost").searchParams.get("t");
      if (supplied !== token) return done(false, 401, "invalid token");
      done(true);
    },
  });
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
      // "all": a human watching wants the previous run's error to stay visible
      // across a hot restart. Agents get the current session only (see
      // RuntimeStore.query), because correlating across runs invents causes.
      events: store.query({ limit: 1000, sessions: "all" }).reverse(),
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

  const url = `http://${host}:${boundPort}`;
  wsToken = token;
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
      wsToken = "";
    },
  };
}
