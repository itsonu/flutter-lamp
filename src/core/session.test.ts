import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { connection } from "./connection.js";
import { RuntimeStore } from "./runtimeStore.js";
import { NetworkCollector } from "../collectors/networkCollector.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Collector instances outlive connections, and a session boundary is invisible
 * unless something marks it. These cover both halves: per-session collector
 * state must be dropped on connect, and evidence from a previous app run must
 * not be handed to an agent as if it belonged to this one.
 */

function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not met in time"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** A mock Dart VM Service that answers the handshake and can drop the socket. */
async function mockVmServer() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const result = msg.method === "getVM" ? { isolates: [{ id: "iso-1" }] } : {};
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  const port = (wss.address() as { port: number }).port;
  return {
    uri: `http://127.0.0.1:${port}/`,
    /** Kill the accepted sockets, as a device sleeping or a cable drop would. */
    dropClients: () => {
      for (const c of wss.clients) c.terminate();
    },
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await once(wss, "close");
    },
  };
}

test("NetworkCollector.reset clears the dedup set so a new run is not swallowed", async () => {
  const store = new RuntimeStore();
  const collector = new NetworkCollector();
  // Request ids restart from low numbers in a new app run; the same id in a new
  // session is a different request.
  const vm = {
    call: async (method: string) =>
      method === "ext.dart.io.getHttpProfile"
        ? { requests: [{ id: "1", method: "GET", uri: "https://x/y", startTime: 1, endTime: 2, response: { statusCode: 200 } }] }
        : {},
  } as unknown as VmService;

  await collector.refresh(vm, store, "iso-1");
  assert.equal(store.query({ category: "network" }).length, 1);

  await collector.refresh(vm, store, "iso-1");
  assert.equal(store.query({ category: "network" }).length, 1, "same request must not be stored twice");

  collector.reset();
  await collector.refresh(vm, store, "iso-1");
  assert.equal(
    store.query({ category: "network" }).length,
    2,
    "after reset the id belongs to a new run and must be captured",
  );
});

test("queries are scoped to the current session, with an explicit opt-out", () => {
  const store = new RuntimeStore();
  const base = { timestamp: 1_000, source: "test", severity: "error" as const, category: "exception" as const, data: {} };

  const first = store.beginSession();
  store.add({ ...base, message: "old run" });

  const second = store.beginSession();
  store.add({ ...base, message: "current run" });

  assert.notEqual(first, second);
  assert.deepEqual(
    store.query().map((e) => e.message),
    ["current run"],
    "evidence from a previous app run must not be correlated with this one",
  );
  assert.deepEqual(
    store.query({ sessions: "all" }).map((e) => e.message),
    ["current run", "old run"],
  );
  assert.equal(store.currentSession(), second);
  assert.equal(store.query()[0].sessionId, second);
});

test("a dropped socket reconnects, opens a new session, and restarts collectors", async () => {
  const server = await mockVmServer();
  const savedPolicy = connection.reconnectPolicy;
  connection.store.clear(); // shared singleton: do not inherit the last test's events
  connection.reconnectPolicy = { baseMs: 20, maxMs: 40, maxAttempts: 5 };
  try {
    const first = await connection.connect(server.uri);
    assert.equal(connection.connected, true);

    server.dropClients();
    await waitFor(() => !connection.connected);

    await waitFor(() => connection.connected);
    const status = connection.status();
    assert.notEqual(status.sessionId, first.sessionId, "a reconnect starts a new session");
    assert.equal(status.reconnectAttempt, 0, "the attempt counter resets on success");
    assert.equal(status.reconnecting, false);

    // The gap is recorded, not silently swallowed.
    const system = connection.store.query({ category: "system", sessions: "all" }).map((e) => e.message);
    assert.ok(system.some((m) => m.includes("connection closed")), "the drop must be in the timeline");
    assert.ok(system.some((m) => m.startsWith("Reconnecting in")), "the retry must be in the timeline");
    assert.ok(system.some((m) => m.startsWith("Reconnected to")), "the recovery must be in the timeline");
  } finally {
    await connection.disconnect();
    connection.reconnectPolicy = savedPolicy;
    await server.close();
  }
});

test("reconnection gives up after the attempt cap and says so", async () => {
  const server = await mockVmServer();
  const savedPolicy = connection.reconnectPolicy;
  connection.store.clear(); // shared singleton: do not inherit the last test's events
  connection.reconnectPolicy = { baseMs: 10, maxMs: 20, maxAttempts: 2 };
  try {
    await connection.connect(server.uri);
    await server.close(); // the app is gone for good, not just blinking

    await waitFor(() =>
      connection.store
        .query({ category: "system", sessions: "all" })
        .some((e) => e.message.startsWith("Gave up reconnecting")),
    );
    assert.equal(connection.connected, false);
    assert.equal(connection.status().reconnecting, false);
  } finally {
    await connection.disconnect();
    connection.reconnectPolicy = savedPolicy;
  }
});

test("an explicit disconnect does not trigger a reconnect", async () => {
  const server = await mockVmServer();
  const savedPolicy = connection.reconnectPolicy;
  connection.store.clear(); // shared singleton: do not inherit the last test's events
  connection.reconnectPolicy = { baseMs: 10, maxMs: 20, maxAttempts: 5 };
  try {
    await connection.connect(server.uri);
    await connection.disconnect();

    await new Promise((r) => setTimeout(r, 120)); // long enough for several retries
    assert.equal(connection.connected, false);
    assert.equal(connection.status().reconnecting, false);
    const system = connection.store.query({ category: "system", sessions: "all" }).map((e) => e.message);
    assert.ok(!system.some((m) => m.startsWith("Reconnecting in")), "a deliberate close must stay closed");
  } finally {
    connection.reconnectPolicy = savedPolicy;
    await server.close();
  }
});
