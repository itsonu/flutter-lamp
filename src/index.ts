#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { startDashboard } from "./dashboard/server.js";

/**
 * Flutter Lamp — entry point.
 *
 * Exposes the runtime-awareness tools over stdio so any MCP-compatible AI
 * (Claude Code, Cursor, Codex, Gemini …) can connect to a running Flutter app
 * through the Dart VM Service instead of pasting logs.
 */
async function main(): Promise<void> {
  const server = new McpServer({
    name: "flutter-lamp",
    version: "0.2.0",
  });

  registerTools(server);

  // Realtime dashboard runs on its own HTTP/WS server, independent of stdio,
  // so an AI client and a browser can watch the same app at once. Best-effort:
  // a dashboard failure (e.g. port in use) must never take down the MCP.
  if (process.env.DASHBOARD_DISABLE !== "1") {
    try {
      const { url } = await startDashboard();
      console.error(`[flutter-lamp] dashboard at ${url}`);
    } catch (err) {
      console.error("[flutter-lamp] dashboard failed to start:", (err as Error).message);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; diagnostics go to stderr only.
  console.error("[flutter-lamp] ready on stdio");
}

main().catch((err) => {
  console.error("[flutter-lamp] fatal:", err);
  process.exit(1);
});
