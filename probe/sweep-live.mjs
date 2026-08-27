// Call every read-only tool against a running app and check what comes back.
//
//   node probe/sweep-live.mjs <vm-service-uri>
//
// `scripts/verify-release.sh` verifies the *package*: versions, tags, tarball
// contents. Nothing verified the *behaviour*, and both defects that made 0.18.0
// unusable were found exactly here — by pointing the server at a real app and
// reading whole responses. A unit test does not read a whole response, and a
// mock does not care what a parameter is called.
//
// Exits non-zero if any tool errors or if the VM Service credential appears in
// any response. Prints the session's cost so a regression in response size is
// visible rather than discovered in an agent's context window.

import { spawn } from "node:child_process";

const uri = process.argv[2];
if (!uri) {
  console.error("usage: node probe/sweep-live.mjs <http-or-ws vm service uri>");
  process.exit(2);
}
const ws = uri.startsWith("ws") ? uri : uri.replace(/^http/, "ws") + (uri.endsWith("/") ? "ws" : "/ws");
// The path segment authorises `evaluate`. It must not appear in any response.
const credential = ws.split("/").filter(Boolean)[2] ?? "";

const server = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "ignore"] });
let buffer = "";
const pending = new Map();
let nextId = 0;
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

/**
 * Arguments per tool. Anything absent here is skipped, which is deliberate:
 * `connect_vm`, `disconnect_vm` and `ensure_tcp_device` change state, and a
 * sweep that disconnects halfway through measures nothing.
 */
const SWEEP = {
  get_logs: {}, get_exceptions: {}, get_frames: {}, get_network: {}, get_memory: {},
  get_timeline: {}, get_navigation: {}, get_rebuilds: {}, get_state_activity: {},
  get_widget_tree: {}, get_selected_widget: {}, get_dashboard_url: {},
  runtime_status: {}, runtime_health: {}, what_changed: {},
  diagnose_runtime: {}, diagnose_performance: {}, explain_diagnosis: {},
  get_capabilities: {}, export_session: { mode: "brief" },
};

await rpc("initialize", {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "sweep-live", version: "0" },
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const advertised = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
console.log(`advertised: ${advertised.length} tools`);

const connected = await rpc("tools/call", { name: "connect_vm", arguments: { uri: ws } });
if (connected.result?.isError) {
  console.error("connect failed:", connected.result.content[0].text.slice(0, 300));
  process.exit(1);
}
// Let the collectors accumulate something to report on. A sweep over an empty
// store passes trivially and proves nothing.
await new Promise((r) => setTimeout(r, Number(process.env.SWEEP_WARMUP_MS ?? 18000)));

const errors = [];
const leaks = [];
let called = 0;
for (const name of advertised) {
  const args = SWEEP[name];
  if (!args) continue;
  const reply = await rpc("tools/call", { name, arguments: args });
  const text = reply.result?.content?.map((c) => c.text ?? "").join("") ?? JSON.stringify(reply.error ?? {});
  called += 1;
  if (reply.result?.isError) errors.push(`${name}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  if (credential.length > 7 && text.includes(credential)) leaks.push(name);
}

const status = JSON.parse(
  (await rpc("tools/call", { name: "runtime_status", arguments: {} })).result.content[0].text,
);
// Collector health lives on runtime_health, not runtime_status. Reading it off
// the wrong one silently printed nothing, which is the failure mode this whole
// script exists to catch — so it is worth naming here.
const health = JSON.parse(
  (await rpc("tools/call", { name: "runtime_health", arguments: {} })).result.content[0].text,
);

console.log(`called: ${called} read-only tools`);
console.log(`errors: ${errors.length}`);
for (const e of errors) console.log("  " + e);
console.log(`credential leaks: ${leaks.length}${leaks.length ? " -> " + leaks.join(", ") : ""}`);
console.log(
  `cost: ${status.cost.calls} calls, ${status.cost.responseBytes} bytes (~${status.cost.estimatedTokens} tokens)`,
);
console.log(`clock offset: ${status.clockOffsetMs}ms (VM minus this machine)`);
const reported = health.collectors ?? [];
if (reported.length === 0) console.log("WARNING: runtime_health reported no collectors");
for (const c of reported) {
  if (c.status !== "active") {
    console.log(`collector ${c.name}: ${c.status} — ${(c.detail ?? "").slice(0, 110)}`);
  }
}

server.kill();
process.exit(errors.length > 0 || leaks.length > 0 ? 1 : 0);
