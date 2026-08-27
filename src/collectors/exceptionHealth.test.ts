import { test } from "node:test";
import assert from "node:assert/strict";
import { ExceptionCollector } from "./exceptionCollector.js";
import { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * An empty exception list has two very different meanings, and the collector has
 * to say which one it is.
 *
 * Subscribing to a stream always succeeds, so this collector reported `active`
 * on targets where `Flutter.Error` can never fire — profile mode and the web,
 * where `isStructuredErrorsEnabled` defaults to `!kIsWeb`. An agent reading
 * "no exceptions" there was reading blindness as health.
 */

function fakeVm(structuredErrors: unknown | Error): VmService {
  return {
    on() {},
    async streamListen() {},
    async call() {
      if (structuredErrors instanceof Error) throw structuredErrors;
      return { enabled: structuredErrors };
    },
  } as unknown as VmService;
}

test("structured errors on: the collector is active", async () => {
  const c = new ExceptionCollector();
  // The reply is the string "true", not the boolean — measured against a real
  // app. `ext.dart.io.httpEnableTimelineLogging` returns a real boolean from the
  // same protocol, which is the trap this pins.
  await c.start(fakeVm("true"), new RuntimeStore(), "iso-1");
  assert.deepEqual(c.health(), { status: "active" });
});

test("structured errors off: empty means unobserved, and health says so", async () => {
  const c = new ExceptionCollector();
  await c.start(fakeVm("false"), new RuntimeStore(), "iso-1");

  const h = c.health();
  assert.equal(h.status, "degraded");
  assert.match(String(h.detail), /not observable|unobserved/i);
  // The detail has to be specific enough to act on, naming what is lost and
  // what still works.
  assert.match(String(h.detail), /PauseException/);
});

test("the check failing claims nothing either way", async () => {
  const c = new ExceptionCollector();
  await c.start(fakeVm(new Error("no such extension")), new RuntimeStore(), "iso-1");

  const h = c.health();
  assert.equal(h.status, "degraded");
  assert.match(String(h.detail), /[Cc]ould not confirm/);
});

test("health resets between sessions", async () => {
  const c = new ExceptionCollector();
  await c.start(fakeVm("false"), new RuntimeStore(), "iso-1");
  assert.equal(c.health().status, "degraded");

  // Collectors outlive connections: a stale "degraded" from a web session would
  // otherwise follow the next connect to a healthy device.
  c.reset();
  assert.equal(c.health().status, "active");
});
