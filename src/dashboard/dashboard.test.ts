import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";

// Configure the port before importing/starting (startDashboard reads env at call time).
process.env.DASHBOARD_HOST = "127.0.0.1";
process.env.DASHBOARD_PORT = "7390";

const { startDashboard } = await import("./server.js");
const { connection } = await import("../core/connection.js");

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

test("dashboard serves HTML and streams store events live over WebSocket", async () => {
  const dash = await startDashboard();
  try {
    // HTTP: index page
    const res = await fetch("http://127.0.0.1:7390/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Runtime/);
    assert.match(html, /\/ws/); // client connects to the WS path

    // HTTP: health
    const health = await (await fetch("http://127.0.0.1:7390/health")).json();
    assert.equal(health.ok, true);

    // WS: snapshot then live event. Attach the waiter BEFORE open — the server
    // sends the snapshot the instant it accepts the connection.
    const ws = new WebSocket("ws://127.0.0.1:7390/ws");
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
