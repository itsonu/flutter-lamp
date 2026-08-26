// Measures the relationship between Bloc transitions and provider events.
//
// The question this answers is narrow and specific: a flutter_bloc app is not
// silent on the VM Service, but what exactly are the events it produces?
// Counting them is not enough — the useful facts are whether every transition
// produces a burst, whether bursts occur without transitions, and whether the
// ratio holds across runs.
//
// Both signals are read from ONE socket (transitions arrive on Stdout as
// PROBE_TRANSITION markers, provider events on Extension), so ordering is a
// property of a single stream rather than of two clocks that may disagree.
//
//   node probe/measure-bloc.mjs ws://127.0.0.1:PORT/TOKEN=/ws [runs]

import WebSocket from "ws";

const [uri, runsArg] = process.argv.slice(2);
if (!uri) {
  console.error("usage: node probe/measure-bloc.mjs <vm-service-ws-uri> [runs]");
  process.exit(1);
}
const RUNS = Number(runsArg ?? 3);
const RUN_MS = 25_000; // the probe app cycles roughly every 20s
/** A burst is "attributed" to a transition if it starts within this of it. */
const ATTRIBUTION_MS = 1_000;

const ws = new WebSocket(uri);
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

/** Every signal, in arrival order on one socket. */
const timeline = [];

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method !== "streamNotify") return;
  const e = m.params.event;
  const at = Date.now();

  if (e.kind === "WriteEvent") {
    const text = Buffer.from(e.bytes ?? "", "base64").toString("utf8");
    for (const line of text.split("\n")) {
      if (line.includes("PROBE_TRANSITION")) timeline.push({ at, kind: "transition", text: line.trim() });
      else if (line.includes("PROBE_PHASE")) timeline.push({ at, kind: "phase", text: line.trim() });
    }
    return;
  }
  if (String(e.extensionKind ?? "").startsWith("provider:")) {
    timeline.push({ at, kind: "provider" });
  } else if (String(e.extensionKind ?? "").startsWith("bloc:")) {
    timeline.push({ at, kind: "bloc-native" });
  }
});

function analyse(slice) {
  const transitions = slice.filter((e) => e.kind === "transition");
  const providers = slice.filter((e) => e.kind === "provider");
  const nativeBloc = slice.filter((e) => e.kind === "bloc-native");

  // How many transitions have at least one provider event shortly after?
  const attributed = transitions.filter((t) =>
    providers.some((p) => p.at >= t.at && p.at - t.at <= ATTRIBUTION_MS),
  ).length;

  // Provider events with no transition within the preceding window: these are
  // the ones that prove provider activity is not a Bloc-only signal.
  const orphan = providers.filter(
    (p) => !transitions.some((t) => p.at >= t.at && p.at - t.at <= ATTRIBUTION_MS),
  ).length;

  return {
    transitions: transitions.length,
    providerEvents: providers.length,
    nativeBlocEvents: nativeBloc.length,
    transitionsWithBurst: attributed,
    providerEventsWithoutTransition: orphan,
    eventsPerTransition:
      transitions.length > 0 ? Number((providers.length / transitions.length).toFixed(1)) : null,
  };
}

ws.on("open", async () => {
  for (const stream of ["Extension", "Stdout"]) await rpc("streamListen", { streamId: stream });

  const vm = await rpc("getVM");
  const iso = await rpc("getIsolate", { isolateId: vm.isolates[0].id });
  const blocRpcs = (iso.extensionRPCs ?? []).filter((r) => /bloc/i.test(r));
  console.log(`ext.bloc.* RPCs registered: ${blocRpcs.length ? blocRpcs.join(", ") : "none"}`);

  const results = [];
  for (let run = 1; run <= RUNS; run++) {
    const from = timeline.length;
    await new Promise((r) => setTimeout(r, RUN_MS));
    const result = analyse(timeline.slice(from));
    results.push(result);
    console.log(`run ${run}: ${JSON.stringify(result)}`);
  }

  const ratios = results.map((r) => r.eventsPerTransition).filter((r) => r !== null);
  console.log("\n--- across runs ---");
  console.log(`events per transition: ${ratios.join(", ")}`);
  console.log(
    `every transition had a burst: ${results.every((r) => r.transitions > 0 && r.transitionsWithBurst === r.transitions)}`,
  );
  console.log(
    `provider events occurred without a transition: ${results.some((r) => r.providerEventsWithoutTransition > 0)}`,
  );
  console.log(
    `native bloc events seen at all: ${results.some((r) => r.nativeBlocEvents > 0)}`,
  );
  console.log(
    "\nA ratio well above 1 means provider events count notified dependents, not transitions.",
  );

  ws.close();
  process.exit(0);
});

ws.on("error", (e) => {
  console.error("connect failed:", e.message);
  process.exit(1);
});
