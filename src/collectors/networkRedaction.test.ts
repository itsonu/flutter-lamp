import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { REDACTED } from "../core/redaction.js";
import { NetworkCollector } from "./networkCollector.js";
import type { VmService } from "../vm/vmService.js";

/**
 * The unit tests prove the redaction helpers work. This proves the collector
 * actually calls them: a bearer token and a session cookie from a real-shaped
 * HTTP profile must never land in the store, because everything in the store is
 * handed to the AI agent and broadcast to every dashboard browser.
 */

const BEARER = "Bearer sk-live-9f3a2b7c1d4e5f6a";
const COOKIE = "session=6f2b9c1e4a7d";

/** Minimal VmService stand-in: only `call` is exercised by refresh(). */
function mockVm(): VmService {
  const call = async (method: string): Promise<any> => {
    if (method === "ext.dart.io.getHttpProfile") {
      return {
        requests: [
          {
            id: "req-1",
            method: "GET",
            uri: "https://api.example.com/v1/me?api_key=abc123&page=2",
            startTime: 1_700_000_000_000_000,
            endTime: 1_700_000_000_450_000,
            response: { statusCode: 500, contentLength: 42 },
          },
        ],
      };
    }
    if (method === "ext.dart.io.getHttpProfileRequest") {
      return {
        request: { headers: { Authorization: BEARER, "Content-Type": "application/json" } },
        response: { headers: { "Set-Cookie": COOKIE, "X-Request-Id": "abc" }, reasonPhrase: "Server Error" },
      };
    }
    return {};
  };
  return { call } as unknown as VmService;
}

test("credentials from the HTTP profile never reach the store", async () => {
  const store = new RuntimeStore();
  await new NetworkCollector().refresh(mockVm(), store, "iso-1");

  const [event] = store.query({ category: "network" });
  assert.ok(event, "the failing request should have been captured");

  const requestHeaders = event.data.requestHeaders as Record<string, string>;
  const responseHeaders = event.data.responseHeaders as Record<string, string>;
  assert.equal(requestHeaders.Authorization, REDACTED);
  assert.equal(responseHeaders["Set-Cookie"], REDACTED);
  assert.deepEqual((event.data.redactedHeaders as string[]).sort(), ["Authorization", "Set-Cookie"]);

  // Non-sensitive context must survive — redaction should not blind the agent.
  assert.equal(requestHeaders["Content-Type"], "application/json");
  assert.equal(responseHeaders["X-Request-Id"], "abc");
  assert.equal(event.data.statusCode, 500);
  assert.equal(event.data.responseReason, "Server Error");

  // The API key in the query string goes, the request shape stays.
  assert.equal(event.data.uri, `https://api.example.com/v1/me?api_key=${REDACTED}&page=2`);

  // Belt and braces: no secret anywhere in the serialized event.
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes("sk-live-9f3a2b7c1d4e5f6a"), "bearer token leaked into the store");
  assert.ok(!serialized.includes("6f2b9c1e4a7d"), "session cookie leaked into the store");
  assert.ok(!serialized.includes("abc123"), "api key leaked into the store");
});
