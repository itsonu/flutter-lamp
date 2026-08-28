import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Who is driving this server.
 *
 * The MCP handshake carries `clientInfo` — a name and version the client sends
 * in `initialize` — and the SDK keeps it. Nothing read it until now, so the
 * dashboard could say a runtime was being observed without being able to say by
 * what. This exposes it, and nothing more.
 *
 * The limits are worth stating plainly, because the dashboard must not overstate
 * what this proves:
 *
 * - It is self-reported. A client can call itself anything; this is identity in
 *   the sense of a User-Agent, not an authenticated one.
 * - There is exactly one of them. The transport is stdio: the client spawns this
 *   process and owns its pipes, so a second agent would be a second server with
 *   its own store. "Which clients are connected" is not a question this process
 *   can answer differently than "the one that started me".
 * - It says who connected, never what they did with a result. Tool calls are
 *   observable (see costMeter); the model's reasoning is not.
 */

export interface McpClientInfo {
  name: string;
  version: string | null;
  /** When `initialize` completed, this process's clock. Null until it does. */
  initializedAt: number | null;
}

let server: McpServer | null = null;
let initializedAt: number | null = null;

/** Called once at startup, before the transport is connected. */
export function trackMcpClient(mcp: McpServer): void {
  server = mcp;
  const previous = mcp.server.oninitialized;
  mcp.server.oninitialized = () => {
    initializedAt = Date.now();
    previous?.();
  };
}

/**
 * The connected client, or null before the handshake completes.
 *
 * Null is a real state, not an error: between process start and `initialize`
 * the server is running and has no idea who launched it.
 */
export function mcpClientInfo(): McpClientInfo | null {
  const info = server?.server.getClientVersion();
  if (!info) return null;
  return {
    name: info.name,
    version: typeof info.version === "string" ? info.version : null,
    initializedAt,
  };
}

/** Test seam: drop the tracked server so state does not leak between tests. */
export function resetMcpClient(): void {
  server = null;
  initializedAt = null;
}
