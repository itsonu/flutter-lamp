import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED,
  redactHeaders,
  redactText,
  redactUri,
  reloadRedactionConfig,
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
