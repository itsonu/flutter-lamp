import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { connection } from "../core/connection.js";

/**
 * End-to-end: a mock Dart VM Service pushes a realtime Flutter.Error event with
 * a stack trace; assert it flows connect → collector → store → query with the
 * reconstructed stacktrace intact. This is the "realtime exception grabbing
 * with stacktrace" path exercised without a real Flutter app.
 */

const FLUTTER_ERROR = {
  type: "FlutterErrorDetails",
  library: "widgets library",
  properties: [
    { description: "Null check operator used on a null value", level: "summary", type: "ErrorSummary" },
    { description: "When the exception was thrown, this was the stack:" },
    { description: "#0      _MyState.build (package:my_app/main.dart:20:15)" },
    { description: "#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5000:1)" },
  ],
};

test("realtime Flutter.Error reaches the store with a stack trace", async () => {
  let pushError: (() => void) | undefined;
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const port = (wss.address() as { port: number }).port;

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const reply = (result: unknown) =>
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.method === "getVM") reply({ isolates: [{ id: "iso-1" }] });
      else reply({}); // streamListen / extensions
    });
    // Deliberately NOT on a timer. A fixed delay races collector startup: under
    // load the push can beat the listeners being attached, and a missed stream
    // event is missed forever. The test pushes explicitly once connect()
    // resolves, at which point every collector is subscribed.
    pushError = () =>
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "streamNotify",
          params: {
            streamId: "Extension",
            event: { extensionKind: "Flutter.Error", extensionData: FLUTTER_ERROR },
          },
        }),
      );
  });

  try {
    connection.store.clear();
    const info = await connection.connect(`http://127.0.0.1:${port}/`);
    assert.equal(info.isolateId, "iso-1");

    pushError?.();
    // Poll rather than sleep: a fixed wait is either flaky or needlessly slow.
    const deadline = Date.now() + 4_000;
    while (connection.store.query({ category: "exception" }).length === 0) {
      if (Date.now() > deadline) throw new Error("no exception captured within 4s");
      await new Promise((r) => setTimeout(r, 20));
    }

    const exceptions = connection.store.query({ category: "exception" });
    assert.equal(exceptions.length, 1, "expected one captured exception");
    const e = exceptions[0];
    assert.equal(e.message, "Null check operator used on a null value");
    assert.equal(e.data.library, "widgets library");
    assert.equal(e.data.hasStack, true);
    assert.match(String(e.data.stackTrace), /#0\s+_MyState\.build/);
    assert.match(String(e.data.stackTrace), /#1\s+StatefulElement\.build/);
  } finally {
    await connection.disconnect();
    for (const client of wss.clients) client.terminate(); // ws.close() leaves accepted sockets open
    wss.close();
    await once(wss, "close");
  }
});
