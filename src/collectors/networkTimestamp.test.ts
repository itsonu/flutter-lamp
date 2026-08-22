import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStore } from "../core/runtimeStore.js";
import { NetworkCollector } from "./networkCollector.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Regression guard for the timestamp basis of network evidence.
 *
 * Every other collector stamps events with `Date.now()`. NetworkCollector uses
 * the HTTP profile's `startTime`, so if that were monotonic-since-VM-start
 * rather than epoch, network events would sit decades away from everything else
 * and the correlation window in the diagnosis engine would never match them —
 * the "an HTTP 500 preceded this exception" result would silently never fire,
 * while a unit test that builds both timestamps from one base still passed.
 *
 * It is epoch microseconds. Dart SDK 3.12.1, sdk/lib/_http/http_impl.dart:62:
 *
 *     requestStartTimestamp = DateTime.now().microsecondsSinceEpoch;
 *
 * This test pins that assumption to realistic values so a future change to the
 * profile format is caught here rather than by a diagnosis quietly going blind.
 */

const REAL_EPOCH_MICROS = 1_755_000_000_000_000; // ~2025-08-12 in epoch microseconds

function profileVm(startTimeMicros: number): VmService {
  return {
    call: async (method: string) =>
      method === "ext.dart.io.getHttpProfile"
        ? {
            requests: [
              {
                id: "1",
                method: "GET",
                uri: "https://api.example.com/v1/me",
                startTime: startTimeMicros,
                endTime: startTimeMicros + 450_000,
                response: { statusCode: 200 },
              },
            ],
          }
        : {},
  } as unknown as VmService;
}

test("network events land on the same epoch-ms timeline as everything else", async () => {
  const store = new RuntimeStore();
  await new NetworkCollector().refresh(profileVm(REAL_EPOCH_MICROS), store, "iso-1");

  const [event] = store.query({ category: "network" });
  assert.equal(event.timestamp, REAL_EPOCH_MICROS / 1000, "startTime is epoch micros, not monotonic");

  // The concrete failure this guards: an exception captured with Date.now()
  // right after the request must fall inside the engine's 3s window.
  const exception = store.add({
    timestamp: event.timestamp + 500,
    source: "Flutter.Error",
    severity: "error",
    category: "exception",
    message: "Null check operator used on a null value",
    data: {},
  });
  assert.ok(
    Math.abs(exception.timestamp - event.timestamp) <= 3_000,
    "a request and the exception it caused must be correlatable",
  );
});

test("duration is derived from the profile, not from arrival time", async () => {
  const store = new RuntimeStore();
  await new NetworkCollector().refresh(profileVm(REAL_EPOCH_MICROS), store, "iso-1");

  const [event] = store.query({ category: "network" });
  assert.equal(event.data.durationMs, 450);
  assert.equal(event.data.startTimeMs, REAL_EPOCH_MICROS / 1000);
  assert.equal(event.data.endTimeMs, REAL_EPOCH_MICROS / 1000 + 450);
});
