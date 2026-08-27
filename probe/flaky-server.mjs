// Local endpoint for the bloc_probe `network` scenario.
//
//   node probe/flaky-server.mjs [port]      (default 8477)
//
// Deliberately offline and deterministic: a recorded incident that depends on
// someone else's server is not reproducible, and a probe should not make
// outbound requests to record a fixture.
//
//   GET /api/health  -> 200, so the session contains healthy traffic too. A
//                       capture where every request failed cannot show that the
//                       collector distinguishes them.
//   GET /api/orders  -> 500, the fault under test.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8477);

createServer((req, res) => {
  if (req.url?.startsWith("/api/orders")) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "order service unavailable" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, "127.0.0.1", () => console.log(`flaky-server on 127.0.0.1:${port}`));
