import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "./tools.js";

/**
 * Exercises the real MCP surface an agent sees: register the tools on a server,
 * connect a client over an in-memory transport, and read `tools/list`.
 */
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "flutter-lamp-test", version: "0.0.0" });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listTools() {
  return withClient(async (client) => (await client.listTools()).tools);
}

/** Parse a tool's JSON payload the way a client would. */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  return withClient(async (client) => {
    const result: any = await client.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  });
}

/**
 * The two operations that change state. `connect_vm` enables dart:io HTTP
 * timeline logging on the app; `get_timeline` with recordFrom=true rewrites the
 * VM's recording flags. Everything else only reads.
 */
const MUTATING = new Set(["connect_vm", "get_timeline"]);

const EXPECTED = [
  "connect_vm",
  "runtime_status",
  "runtime_health",
  "what_changed",
  "get_navigation",
  "get_rebuilds",
  "get_state_activity",
  "explain_diagnosis",
  "get_capabilities",
  "export_session",
  "get_dashboard_url",
  "get_logs",
  "get_exceptions",
  "get_frames",
  "get_network",
  "diagnose_runtime",
  "diagnose_performance",
  "get_widget_tree",
  "get_selected_widget",
  "get_memory",
  "get_timeline",
];

test("every tool is registered and reachable over MCP", async () => {
  const names = (await listTools()).map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED].sort());
});

test("every tool declares whether it is read-only", async () => {
  for (const tool of await listTools()) {
    assert.ok(tool.annotations, `${tool.name} has no safety annotations`);
    assert.equal(
      typeof tool.annotations?.readOnlyHint,
      "boolean",
      `${tool.name} does not declare readOnlyHint`,
    );
    assert.equal(
      tool.annotations?.readOnlyHint,
      !MUTATING.has(tool.name),
      `${tool.name} is classified wrongly`,
    );
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not be destructive`);
  }
});

test("the mutating tools say so in their description, not just in metadata", async () => {
  const tools = new Map((await listTools()).map((t) => [t.name, t]));
  // Annotations are hints a client may ignore; the model reads the description.
  assert.match(String(tools.get("connect_vm")?.description), /NOT purely read-only/);
  assert.match(String(tools.get("get_timeline")?.description), /NOT read-only/);
});

test("get_capabilities agrees with the annotations on tools/list", async () => {
  // The safety map and the registrations are derived from one source; this
  // fails if that ever stops being true.
  const capabilities = await callTool("get_capabilities");
  const declared = new Map<string, string>(
    capabilities.tools.map((t: { name: string; safety: string }) => [t.name, t.safety]),
  );

  for (const tool of await listTools()) {
    assert.ok(declared.has(tool.name), `${tool.name} is missing from get_capabilities`);
    assert.equal(
      declared.get(tool.name) === "read-only",
      tool.annotations?.readOnlyHint,
      `${tool.name} is classified differently in get_capabilities than in its annotations`,
    );
  }
  assert.equal(declared.size, (await listTools()).length, "get_capabilities lists a tool that is not registered");
});

test("get_capabilities states what cannot be observed, not just what can", async () => {
  const capabilities = await callTool("get_capabilities");
  assert.equal(capabilities.server.name, "flutter-lamp");
  assert.ok(capabilities.canObserve.length > 0);
  assert.ok(
    capabilities.cannotObserve.some((c: string) => c.includes("Release builds")),
    "an agent must know the release-build limitation before trying",
  );
  assert.ok(capabilities.cannotObserve.some((c: string) => c.includes("WebView")));
  assert.equal(capabilities.configuration.redaction, "on");
  assert.deepEqual(Object.keys(capabilities.configuration.retention).sort(), [
    "exception",
    "frame",
    "log",
    "navigation",
    "network",
    "rebuild",
    "state",
    "system",
  ]);
});

test("runtime_health lists every collector with its health", async () => {
  const health = await callTool("runtime_health");
  const names = health.collectors.map((c: { name: string }) => c.name).sort();
  assert.deepEqual(names, ["exceptions", "frames", "logs", "navigation", "network", "rebuilds", "state"]);
  for (const c of health.collectors) {
    assert.ok(["active", "degraded", "unavailable"].includes(c.status), `${c.name}: ${c.status}`);
    assert.equal(typeof c.eventsRetained, "number");
  }
});

test("runtime_health answers without a connection instead of throwing", async () => {
  // An agent's first call may land before connect_vm; it should get a verdict,
  // not an error it has to interpret.
  const health = await callTool("runtime_health");
  assert.equal(health.connected, false);
  assert.equal(health.verdict, "no-data");
  assert.ok(health.notes.some((n: string) => n.includes("Not connected")));
});
