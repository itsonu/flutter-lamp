import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { eventTime } from "./collector.js";
import { connection } from "../core/connection.js";

/**
 * Events are stamped with the app's clock, not ours.
 *
 * A VM Service `Event` carries the time the VM posted it. Receipt time is not
 * a substitute: DDS hands over a backlog the moment a subscription is accepted,
 * and a slow link stalls and then flushes, so a run of events that happened
 * hundreds of milliseconds apart arrives inside the same millisecond. Measured
 * against a running app, six backlog frames landed within 1ms of each other by
 * receipt while their posted times spanned 331ms.
 *
 * Every window in this codebase — the 3s correlation window, baseline versus
 * incident, a timeline shown to a human — is only as good as this.
 */

test("eventTime prefers the posted time and falls back to receipt", () => {
  assert.equal(eventTime({ timestamp: 1_700_000_000_123 }), 1_700_000_000_123);

  const before = Date.now();
  for (const bad of [undefined, {}, { timestamp: "nope" }, { timestamp: NaN }]) {
    const t = eventTime(bad);
    assert.ok(t >= before && t <= Date.now() + 1_000, `fallback out of range for ${JSON.stringify(bad)}`);
  }
});

test("a flushed backlog keeps the spacing the app actually had", async () => {
  // Three frames posted 300ms apart, delivered in one burst — the shape of a
  // DDS backlog drain. Stamped on receipt they would be indistinguishable.
  const POSTED = [1_700_000_000_000, 1_700_000_000_300, 1_700_000_000_600];

  let flush: (() => void) | undefined;
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const port = (wss.address() as { port: number }).port;

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const reply = (result: unknown) =>
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.method === "getVM") reply({ isolates: [{ id: "iso-1" }] });
      else reply({});
    });
    flush = () => {
      for (const [i, timestamp] of POSTED.entries()) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "streamNotify",
            params: {
              streamId: "Extension",
              event: {
                timestamp,
                extensionKind: "Flutter.Frame",
                extensionData: { number: i, elapsed: 8_000, build: 4_000, raster: 2_000 },
              },
            },
          }),
        );
      }
    };
  });

  try {
    connection.store.clear();
    await connection.connect(`http://127.0.0.1:${port}/`);
    flush?.();

    const deadline = Date.now() + 4_000;
    while (connection.store.query({ category: "frame" }).length < POSTED.length) {
      if (Date.now() > deadline) throw new Error("frames not captured within 4s");
      await new Promise((r) => setTimeout(r, 20));
    }

    const frames = connection.store
      .query({ category: "frame" })
      .sort((a, b) => a.timestamp - b.timestamp);
    assert.deepEqual(frames.map((f) => f.timestamp), POSTED);
  } finally {
    await connection.disconnect();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await once(wss, "close");
  }
});
