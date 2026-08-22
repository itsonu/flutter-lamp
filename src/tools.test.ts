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
async function listTools() {
  const server = new McpServer({ name: "flutter-lamp-test", version: "0.0.0" });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
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
  "get_dashboard_url",
  "get_logs",
  "get_exceptions",
  "get_frames",
  "get_network",
  "diagnose_runtime",
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
