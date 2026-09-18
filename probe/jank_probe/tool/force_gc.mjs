// Ground truth for the positive path: force full collections while the app
// renders, so the cause of any resulting late frame is known by construction
// rather than inferred. Uses the same RPC DevTools' GC button uses.
// node forcegc.mjs <http-vm-uri> <seconds> <intervalMs>
const base = process.argv[2].replace(/\/$/, "");
const seconds = Number(process.argv[3] ?? 40);
const every = Number(process.argv[4] ?? 1200);

const rpc = async (method, params = {}) => {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${base}/${method}${q ? "?" + q : ""}`);
  return (await r.json()).result;
};

const vm = await rpc("getVM");
const isolateId = vm.isolates[0].id;
console.log("forcing GC on", isolateId, "every", every, "ms for", seconds, "s");

const until = Date.now() + seconds * 1000;
let n = 0;
while (Date.now() < until) {
  const t = Date.now();
  await rpc("_collectAllGarbage", { isolateId });
  n++;
  console.log(`gc ${n} took ${Date.now() - t}ms`);
  await new Promise((r) => setTimeout(r, every));
}
console.log("forced", n, "collections");
