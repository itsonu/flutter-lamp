import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REDACTED,
  redactHeaders,
  redactText,
  redactUri,
  reloadRedactionConfig,
  redactionEnabled,
  redactVmServiceUri,
} from "./redaction.js";

/** Run `fn` with env vars applied, then restore and reload the config. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  reloadRedactionConfig();
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    reloadRedactionConfig();
  }
}

test("credential headers are redacted, ordinary headers survive", () => {
  const { headers, redacted } = redactHeaders({
    Authorization: "Bearer sk-live-abcdefghijklmnop",
    Cookie: "session=abc123",
    "Set-Cookie": "session=abc123; HttpOnly",
    "X-Api-Key": "key-12345",
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  assert.equal(headers?.Authorization, REDACTED);
  assert.equal(headers?.Cookie, REDACTED);
  assert.equal(headers?.["Set-Cookie"], REDACTED);
  assert.equal(headers?.["X-Api-Key"], REDACTED);
  assert.equal(headers?.["Content-Type"], "application/json", "safe header must pass through");
  assert.equal(headers?.Accept, "application/json");
  assert.deepEqual(redacted.sort(), ["Authorization", "Cookie", "Set-Cookie", "X-Api-Key"]);
});

test("header matching is case-insensitive and substring-based", () => {
  const { headers } = redactHeaders({
    authorization: "Bearer x",
    "x-session-token": "abc",
    "X-CSRF-Secret": "abc",
    "x-request-id": "req-1",
  });
  assert.equal(headers?.authorization, REDACTED);
  assert.equal(headers?.["x-session-token"], REDACTED);
  assert.equal(headers?.["X-CSRF-Secret"], REDACTED);
  assert.equal(headers?.["x-request-id"], "req-1");
});

test("JWTs and scheme-prefixed tokens are stripped out of free text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.s5Kd8xQwErTyUiOp";
  assert.equal(redactText(`token=${jwt} failed`), `token=${REDACTED} failed`);
  assert.equal(redactText("Authorization: Bearer sk-live-abcdefgh"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactText("GET /users returned 500"), "GET /users returned 500", "clean text untouched");
});

test("sensitive query parameters are redacted, request shape is preserved", () => {
  assert.equal(
    redactUri("https://api.example.com/v1/me?api_key=abc123&page=2"),
    `https://api.example.com/v1/me?api_key=${REDACTED}&page=2`,
  );
  assert.equal(
    redactUri("https://api.example.com/v1/me?page=2"),
    "https://api.example.com/v1/me?page=2",
    "non-sensitive params untouched",
  );
  assert.equal(redactUri("https://api.example.com/v1/me"), "https://api.example.com/v1/me");
});

test("FLUTTER_LAMP_REDACT_EXTRA adds custom header patterns", () => {
  withEnv({ FLUTTER_LAMP_REDACT_EXTRA: "x-tenant" }, () => {
    const { headers } = redactHeaders({ "X-Tenant-Id": "acme", "X-Other": "keep" });
    assert.equal(headers?.["X-Tenant-Id"], REDACTED);
    assert.equal(headers?.["X-Other"], "keep");
  });
});

test("FLUTTER_LAMP_REDACT=off passes values through untouched", () => {
  withEnv({ FLUTTER_LAMP_REDACT: "off" }, () => {
    const { headers, redacted } = redactHeaders({ Authorization: "Bearer secret-value" });
    assert.equal(headers?.Authorization, "Bearer secret-value");
    assert.deepEqual(redacted, []);
    assert.equal(redactText("Bearer secret-value"), "Bearer secret-value");
    assert.equal(redactUri("https://x/y?api_key=abc"), "https://x/y?api_key=abc");
  });
});

/**
 * The VM Service token is the one credential this tool holds itself, and it
 * authorises `evaluate` — arbitrary Dart execution in the app being debugged.
 *
 * It leaked. `export_session` was fixed in the 0.18.0 audit, but the deeper
 * problem was that `ConnectionManager.open()` wrote the raw URI into the event
 * store, so anything reading system events surfaced it — found live, in
 * `what_changed`, at `$.system[0].message`. Fixing one consumer was the wrong
 * altitude; the fix belongs where the value enters.
 */
test("the VM Service token survives nowhere it can be read back", () => {
  const uri = "ws://127.0.0.1:8181/SeCrEtT0k3n=/ws";
  const safe = redactVmServiceUri(uri);

  assert.ok(safe && !safe.includes("SeCrEtT0k3n"), "the token must not survive redaction");
  assert.match(safe!, /^ws:\/\/127\.0\.0\.1:8181\//, "host and port must survive — they identify the app");
  assert.ok(safe!.endsWith("/ws"), "the path suffix must survive");
});

test("redaction of the token ignores FLUTTER_LAMP_REDACT=off", () => {
  // That flag is a choice about observed evidence — headers, log text. Nobody
  // asking to see their own request headers asked for an RCE credential in
  // every export and on every dashboard.
  const before = process.env.FLUTTER_LAMP_REDACT;
  process.env.FLUTTER_LAMP_REDACT = "off";
  reloadRedactionConfig();
  try {
    assert.equal(redactionEnabled(), false, "the opt-out must still apply to evidence");
    const safe = redactVmServiceUri("ws://127.0.0.1:8181/SeCrEtT0k3n=/ws");
    assert.ok(safe && !safe.includes("SeCrEtT0k3n"), "the token must be redacted even with redaction off");
  } finally {
    if (before === undefined) delete process.env.FLUTTER_LAMP_REDACT;
    else process.env.FLUTTER_LAMP_REDACT = before;
    reloadRedactionConfig();
  }
});

/**
 * The leak was not in this module — it was in `ConnectionManager.open()`, which
 * read `vm.wsUri` raw and wrote it into a stored event and its own return value.
 * `ConnectionManager` needs a live `VmService` to construct, so a unit test
 * cannot reach it; this asserts the boundary instead. The failure mode is a raw
 * read crossing out of the connection layer, which is exactly what this sees.
 */
test("the connection layer never reads the raw URI without redacting it", () => {
  const source = readFileSync("src/core/connection.ts", "utf8");

  // Remove every legitimate use, then look for what is left.
  const remaining = source
    .replace(/redactVmServiceUri\([^)]*\)/g, "REDACTED_CALL")
    .replace(/^\s*(\/\/|\*).*$/gm, ""); // comments discuss wsUri freely

  const bare = remaining.match(/\b(vm|this\.vm)\??\.wsUri\b/g) ?? [];
  assert.deepEqual(
    bare,
    [],
    `connection.ts reads vm.wsUri without redacting: ${bare.join(", ")} — ` +
      "the path segment authorises evaluate and must not enter the store or a return value",
  );
});
