import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";

// Configure the port before importing/starting (startDashboard reads env at call time).
process.env.DASHBOARD_HOST = "127.0.0.1";
process.env.DASHBOARD_PORT = "7390";

const { startDashboard, dashboardWsToken } = await import("./server.js");
const { connection } = await import("../core/connection.js");

const ORIGIN = "http://127.0.0.1:7390";

function nextMessage(ws: WebSocket, match: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    const on = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (match(msg)) {
        clearTimeout(timer);
        ws.off("message", on);
        resolve(msg);
      }
    };
    ws.on("message", on);
  });
}

/**
 * Resolve to "open" or the rejection error, whichever the handshake produces.
 * Listeners are attached directly rather than via events.once() — that helper
 * rejects its promise on "error", which would leave an unhandled rejection
 * behind for whichever outcome lost the race.
 */
function handshake(url: string, opts?: WebSocket.ClientOptions): Promise<"open" | Error> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    const settle = (outcome: "open" | Error) => {
      ws.removeAllListeners();
      ws.terminate();
      resolve(outcome);
    };
    ws.once("open", () => settle("open"));
    ws.once("error", (err) => settle(err as Error));
  });
}

test("dashboard serves HTML and streams store events live over WebSocket", async () => {
  const dash = await startDashboard();
  try {
    // HTTP: index page
    const res = await fetch("http://127.0.0.1:7390/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), "DENY", "page carries the token; never frame it");
    const html = await res.text();
    assert.match(html, /Runtime/);
    assert.match(html, /\/ws/); // client connects to the WS path
    assert.match(html, /__LAMP_TOKEN__/); // handshake token is inlined for same-origin script

    // HTTP: health is liveness only — it must not leak the VM Service URI,
    // which embeds the VM auth token.
    const health = await (await fetch("http://127.0.0.1:7390/health")).json();
    assert.equal(health.ok, true);
    assert.ok(!("wsUri" in health), "health must not expose the VM Service URI");

    // WS: snapshot then live event. Attach the waiter BEFORE open — the server
    // sends the snapshot the instant it accepts the connection.
    const ws = new WebSocket(`ws://127.0.0.1:7390/ws?t=${dashboardWsToken()}`, { origin: ORIGIN });
    const snapshotPromise = nextMessage(ws, (m) => m.type === "snapshot");
    await once(ws, "open");
    const snapshot = await snapshotPromise;
    assert.ok(Array.isArray(snapshot.events));
    assert.ok("connected" in snapshot.status);

    const eventPromise = nextMessage(ws, (m) => m.type === "event");
    connection.store.add({
      timestamp: Date.now(),
      source: "test",
      severity: "info",
      category: "log",
      message: "hello dashboard",
      data: {},
    });
    const evt = await eventPromise;
    assert.equal(evt.event.message, "hello dashboard");

    ws.close();
    await once(ws, "close");
  } finally {
    await dash.close();
  }
});

test("the WebSocket rejects hijack attempts and accepts legitimate clients", async () => {
  const dash = await startDashboard();
  const token = dashboardWsToken();
  try {
    // A hostile page in the developer's browser: right port, wrong origin, and
    // no way to read the token out of a cross-origin response.
    const foreignOrigin = await handshake(`ws://127.0.0.1:7390/ws?t=${token}`, {
      origin: "http://evil.example.com",
    });
    assert.ok(foreignOrigin instanceof Error, "foreign origin must be rejected");
    assert.match(String(foreignOrigin), /403/);

    // Same page guessing the endpoint without the token.
    const noToken = await handshake("ws://127.0.0.1:7390/ws", { origin: ORIGIN });
    assert.ok(noToken instanceof Error, "missing token must be rejected");
    assert.match(String(noToken), /401/);

    const wrongToken = await handshake(`ws://127.0.0.1:7390/ws?t=not-the-token`, { origin: ORIGIN });
    assert.ok(wrongToken instanceof Error, "wrong token must be rejected");

    // A native client (no Origin header) with the token is legitimate.
    assert.equal(await handshake(`ws://127.0.0.1:7390/ws?t=${token}`), "open");
  } finally {
    await dash.close();
  }
});
