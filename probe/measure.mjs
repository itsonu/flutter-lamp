// Measures what a running Flutter app actually exposes to the VM Service, so
// collectors are written against observation instead of an assumed API.
//
//   node probe/measure.mjs ws://127.0.0.1:PORT/TOKEN=/ws [seconds]
//
// Reports: registered ext.* RPCs, then every event seen on the Extension,
// Logging, Stdout and Debug streams, grouped by kind, with one sample payload
// each and the probe phase (from the app's PROBE_PHASE marker) it landed in.
import WebSocket from "ws";

const uri = process.argv[2];
const seconds = Number(process.argv[3] ?? 60);
if (!uri) {
  console.error("usage: node probe/measure.mjs <ws-uri> [seconds]");
  process.exit(1);
}

const ws = new WebSocket(uri);
// Without these the script hangs forever on a bad URI: every timer lives inside
// the "open" handler, so a connection that never opens never exits.
ws.on("error", (err) => {
  console.error("websocket error:", err.message);
  process.exit(1);
});
ws.on("close", (code, reason) => {
  console.error(`websocket closed: ${code} ${reason}`);
  process.exit(1);
});
setTimeout(() => {
  console.error("timed out waiting for the VM Service to respond");
  process.exit(1);
}, (seconds + 30) * 1000).unref();

let id = 1;
const rpc = (method, params = {}) =>
  new Promise((resolve) => {
    const rid = String(id++);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === rid) {
        ws.off("message", onMsg);
        resolve(m.result ?? { error: m.error });
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }));
  });

/** kind -> { count, sample, phases: Set } */
const seen = new Map();
let phase = "(before first marker)";

function record(kind, payload) {
  let entry = seen.get(kind);
  if (!entry) {
    entry = { count: 0, sample: payload, phases: new Set() };
    seen.set(kind, entry);
  }
  entry.count++;
  entry.phases.add(phase);
}

ws.on("open", async () => {
  const vm = await rpc("getVM");
  const isolateId = vm.isolates?.[0]?.id;
  const isolate = await rpc("getIsolate", { isolateId });
  const ext = (isolate.extensionRPCs ?? []).sort();
  console.log(`isolate: ${isolateId}  (${ext.length} extension RPCs)`);
  const interesting = ext.filter((n) => !n.startsWith("ext.flutter.") && !n.startsWith("ext.dart."));
  console.log("non-framework extension RPCs:", JSON.stringify(interesting));
  console.log("riverpod/bloc RPCs:", JSON.stringify(ext.filter((n) => /riverpod|bloc/i.test(n))));

  for (const stream of ["Extension", "Logging", "Stdout", "Debug"]) {
    const r = await rpc("streamListen", { streamId: stream });
    if (r.error) console.log(`streamListen ${stream} failed:`, JSON.stringify(r.error));
  }

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method !== "streamNotify") return;
    const e = m.params.event;
    const stream = m.params.streamId;

    if (stream === "Stdout" && e.bytes) {
      const text = Buffer.from(e.bytes, "base64").toString("utf8");
      const marker = text.match(/PROBE_PHASE (\w+)/);
      if (marker) {
        phase = marker[1];
        console.log(`--- phase: ${phase}`);
      }
      return;
    }
    if (stream === "Extension") record(`Extension/${e.extensionKind}`, e.extensionData);
    else if (stream === "Logging") record(`Logging/${e.logRecord?.loggerName?.valueAsString ?? "?"}`, e.logRecord);
    else record(`${stream}/${e.kind}`, undefined);
  });

  console.log(`listening for ${seconds}s...`);
  setTimeout(() => {
    console.log("\n=== observed ===");
    for (const [kind, { count, sample, phases }] of [...seen].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`\n${kind}  x${count}  phases: ${[...phases].join(",")}`);
      if (sample !== undefined) console.log("  sample:", JSON.stringify(sample).slice(0, 500));
    }
    ws.close();
    process.exit(0);
  }, seconds * 1000);
});
