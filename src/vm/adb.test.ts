import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, classifyTransport, type AdbDevice } from "./adb.js";

function device(serial: string, extra: Partial<AdbDevice> = {}): AdbDevice {
  const transport = classifyTransport(serial);
  return { serial, state: "device", transport, wireless: transport === "tcp", ...extra };
}

test("serials are classified by the transport they actually represent", () => {
  assert.equal(classifyTransport("001216499001152"), "usb");
  assert.equal(classifyTransport("192.168.88.3:5555"), "tcp");
  // Android 11+ wireless debugging advertises over mDNS — wireless despite
  // looking nothing like an address.
  assert.equal(classifyTransport("adb-001216499001152-mt5Xk5._adb-tls-connect._tcp"), "tcp");
  assert.equal(classifyTransport("emulator-5554"), "emulator");
});

test("a stable ip:port is preferred over an opaque mDNS serial", () => {
  // Both are wireless, but only one can be dialled again by address after a
  // reconnect; mDNS serials are regenerated.
  const report = buildReport([
    device("adb-001216499001152-mt5Xk5._adb-tls-connect._tcp", { model: "A015" }),
    device("192.168.88.3:5555", { model: "A015" }),
  ]);
  assert.equal(report.recommended?.serial, "192.168.88.3:5555");
});

test("wireless is recommended over USB for the same device", () => {
  const report = buildReport([
    device("001216499001152", { model: "A015" }),
    device("192.168.88.3:5555", { model: "A015" }),
  ]);
  assert.equal(report.recommended?.transport, "tcp");
  assert.deepEqual(report.promotable, [], "a device that already has wireless is not promotable");
  assert.ok(report.notes.some((n) => n.includes("does not depend on the cable")));
});

test("a USB-only device is offered for promotion", () => {
  const report = buildReport([device("001216499001152", { model: "A015" })]);
  assert.equal(report.recommended?.serial, "001216499001152");
  assert.deepEqual(report.promotable.map((d) => d.serial), ["001216499001152"]);
  assert.ok(report.notes.some((n) => n.includes("promote:true")));
});

test("unusable devices are reported with the reason, not silently skipped", () => {
  const report = buildReport([
    device("001216499001152", { state: "unauthorized" }),
    device("192.168.88.9:5555", { state: "offline" }),
  ]);
  assert.equal(report.recommended, null);
  assert.ok(report.notes.some((n) => n.includes("unauthorized") && n.includes("prompt on the device")));
  assert.ok(report.notes.some((n) => n.includes("offline")));
  assert.ok(report.notes.some((n) => n.includes("No usable device")));
});

test("no adb is reported as absence of the capability, not absence of devices", () => {
  const report = buildReport(null);
  assert.equal(report.adbAvailable, false);
  assert.deepEqual(report.devices, []);
  assert.equal(report.recommended, null);
  assert.ok(
    report.notes.some((n) => n.includes("iOS, desktop and web targets are unaffected")),
    "an iOS user must not read this as a broken setup",
  );
});

test("an emulator is usable but never mistaken for a wireless device", () => {
  const report = buildReport([device("emulator-5554")]);
  assert.equal(report.recommended?.serial, "emulator-5554");
  assert.equal(report.recommended?.wireless, false);
  assert.deepEqual(report.promotable, [], "an emulator has no cable to escape");
});
