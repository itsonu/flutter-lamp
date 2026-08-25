import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Optional adb integration, for Android transport awareness.
 *
 * Flutter Lamp connects to a VM Service URI and otherwise knows nothing about
 * how that URI reaches the device. That gap is why a session dies when a USB
 * cable moves: the tunnel `flutter run` maintains is bound to the adb transport
 * it selected at launch, and nothing tells the developer a wireless transport
 * was available all along.
 *
 * Everything here degrades to `null`/`unavailable` when adb is absent, so
 * iOS, desktop and web targets are unaffected. Nothing in this module is
 * required for the server to run.
 *
 * Commands are executed with `execFile` and argument arrays — never a shell —
 * and every serial is validated before use, because serials reach here from
 * tool input as well as from adb's own output.
 */

export type AdbTransport = "usb" | "tcp" | "emulator";

export interface AdbDevice {
  serial: string;
  /** adb's own word: device, unauthorized, offline, … */
  state: string;
  transport: AdbTransport;
  model?: string;
  /** True when this transport keeps working with the cable unplugged. */
  wireless: boolean;
}

/** Serial shapes adb accepts. Anything else is rejected rather than executed. */
const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IPV4_PORT = /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/;
const EMULATOR = /^emulator-\d+$/;
/** Android 11+ wireless debugging advertises over mDNS with this suffix. */
const MDNS_TCP = /_adb-tls-connect\._tcp$/;

export function classifyTransport(serial: string): AdbTransport {
  if (EMULATOR.test(serial)) return "emulator";
  if (IPV4_PORT.test(serial) || MDNS_TCP.test(serial)) return "tcp";
  return "usb";
}

let cachedPath: string | null | undefined;

/** Locate adb: PATH first, then the usual SDK locations. Cached per process. */
export async function adbPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  try {
    await run("adb", ["version"], { timeout: 5_000 });
    cachedPath = "adb";
    return cachedPath;
  } catch {
    // Not on PATH; fall through to the SDK locations.
  }

  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    process.env.HOME ? join(process.env.HOME, "Android", "Sdk") : undefined,
    process.env.HOME ? join(process.env.HOME, "Library", "Android", "sdk") : undefined,
  ].filter((r): r is string => typeof r === "string" && r.length > 0);

  for (const root of roots) {
    const candidate = join(root, "platform-tools", exe);
    if (existsSync(candidate)) {
      cachedPath = candidate;
      return cachedPath;
    }
  }

  cachedPath = null;
  return null;
}

async function adb(args: string[], timeout = 15_000): Promise<string> {
  const bin = await adbPath();
  if (!bin) throw new Error("adb is not available");
  const { stdout } = await run(bin, args, { timeout });
  return stdout;
}

/** Null when adb is unavailable — distinct from an empty list, which means no devices. */
export async function listDevices(): Promise<AdbDevice[] | null> {
  if (!(await adbPath())) return null;
  let stdout: string;
  try {
    stdout = await adb(["devices", "-l"]);
  } catch {
    return null;
  }

  const devices: AdbDevice[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state || !SERIAL_PATTERN.test(serial)) continue;
    const transport = classifyTransport(serial);
    const model = rest.find((r) => r.startsWith("model:"))?.slice("model:".length);
    devices.push({
      serial,
      state,
      transport,
      model,
      wireless: transport === "tcp",
    });
  }
  return devices;
}

/** The device's wlan0 address, needed to open a TCP transport to it. */
export async function deviceIp(serial: string): Promise<string | null> {
  if (!SERIAL_PATTERN.test(serial)) return null;
  try {
    const stdout = await adb(["-s", serial, "shell", "ip", "-f", "inet", "addr", "show", "wlan0"]);
    return stdout.match(/inet (\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PromotionResult {
  ok: boolean;
  /** The TCP serial to use with `flutter run -d`, when promotion succeeded. */
  endpoint?: string;
  detail: string;
}

/**
 * Put a USB-attached device onto a TCP transport, so the session survives the
 * cable being unplugged.
 *
 * Restarts adbd on the device in TCP mode — a real change to device state, and
 * the reason the calling tool is declared mutating. Reversible with `adb usb`.
 */
export async function promoteToTcp(serial: string, port = 5555): Promise<PromotionResult> {
  if (!SERIAL_PATTERN.test(serial)) {
    return { ok: false, detail: `Refusing to run adb with an unrecognised serial: ${serial}` };
  }
  if (!(await adbPath())) {
    return { ok: false, detail: "adb is not available on this machine." };
  }
  if (classifyTransport(serial) !== "usb") {
    return { ok: false, detail: `${serial} is already a ${classifyTransport(serial)} transport.` };
  }

  const ip = await deviceIp(serial);
  if (!ip) {
    return {
      ok: false,
      detail:
        "Could not read the device's wlan0 address. Connect it to Wi-Fi (the same network as this machine) and try again.",
    };
  }

  try {
    await adb(["-s", serial, "tcpip", String(port)]);
  } catch (err) {
    return { ok: false, detail: `adb tcpip failed: ${errText(err)}` };
  }

  // adbd needs a moment to come back up on the new port.
  await new Promise((r) => setTimeout(r, 3_000));

  const endpoint = `${ip}:${port}`;
  try {
    const out = await adb(["connect", endpoint]);
    if (/unable to connect|failed to connect/i.test(out)) {
      return { ok: false, detail: `adb connect ${endpoint} was refused: ${out.trim()}` };
    }
  } catch (err) {
    return { ok: false, detail: `adb connect ${endpoint} failed: ${errText(err)}` };
  }

  return {
    ok: true,
    endpoint,
    detail: `${serial} is now also reachable at ${endpoint}. Launch with \`flutter run -d ${endpoint}\` and the session no longer depends on the cable.`,
  };
}

export interface TransportReport {
  adbAvailable: boolean;
  devices: AdbDevice[];
  /** The transport to prefer, wireless first. Null when there is no usable device. */
  recommended: AdbDevice | null;
  /** USB-only devices that could be promoted. */
  promotable: AdbDevice[];
  notes: string[];
}

/**
 * What transports exist, and which to use.
 *
 * Wireless is preferred whenever one exists for a device: a `flutter run`
 * started on a TCP transport keeps its VM Service tunnel when the cable is
 * removed, and one started on USB does not.
 */
export async function transportReport(): Promise<TransportReport> {
  return buildReport(await listDevices());
}

/**
 * The decision itself, separated from the shelling out so it can be tested
 * against device layouts that are awkward to reproduce on real hardware.
 * `null` means adb is unavailable; `[]` means adb ran and saw nothing.
 */
export function buildReport(devices: AdbDevice[] | null): TransportReport {
  if (devices === null) {
    return {
      adbAvailable: false,
      devices: [],
      recommended: null,
      promotable: [],
      notes: [
        "adb was not found. Transport selection is Android-only; iOS, desktop and web targets are unaffected.",
      ],
    };
  }

  const notes: string[] = [];
  const usable = devices.filter((d) => d.state === "device");
  for (const d of devices) {
    if (d.state === "unauthorized") {
      notes.push(`${d.serial} is unauthorized — accept the debugging prompt on the device.`);
    } else if (d.state === "offline") {
      notes.push(`${d.serial} is offline.`);
    }
  }

  // Several serials can be the same physical device (USB + mDNS + tcpip).
  // Group by model so the advice is about devices, not transports.
  const wireless = usable.filter((d) => d.transport === "tcp");
  const usb = usable.filter((d) => d.transport === "usb");
  const emulators = usable.filter((d) => d.transport === "emulator");

  // Prefer an explicit ip:port over an mDNS serial: it is stable across
  // reconnects and can be dialled again by address.
  const recommended =
    wireless.find((d) => IPV4_PORT.test(d.serial)) ??
    wireless[0] ??
    emulators[0] ??
    usb[0] ??
    null;

  const promotable = usb.filter(
    (u) => !wireless.some((w) => w.model && u.model && w.model === u.model),
  );

  if (wireless.length > 0) {
    notes.push(
      `A wireless transport is available (${wireless.map((d) => d.serial).join(", ")}). Launch with \`flutter run -d ${recommended?.serial}\` so the session does not depend on the cable.`,
    );
  } else if (promotable.length > 0) {
    notes.push(
      `Only USB transports are connected. Call this tool with promote:true to put ${promotable[0].serial} on a TCP transport, which needs the cable once and not afterwards.`,
    );
  } else if (usable.length === 0) {
    notes.push("No usable device is connected.");
  }

  return { adbAvailable: true, devices, recommended, promotable, notes };
}

/**
 * Why a VM Service URI might be unreachable, in transport terms.
 *
 * Called when a connection fails, so the answer is "the device dropped off
 * adb" or "the app is not running" rather than a bare ECONNREFUSED.
 */
export async function diagnoseUnreachable(): Promise<string[]> {
  const report = await transportReport();
  if (!report.adbAvailable) return [];

  const out: string[] = [];
  const usable = report.devices.filter((d) => d.state === "device");
  if (usable.length === 0) {
    out.push(
      "No device is attached to adb, so the forwarded VM Service port cannot be reachable. Reconnect the device, or reconnect wirelessly with `adb connect <ip>:5555`.",
    );
  } else {
    out.push(
      `adb sees ${usable.length} device(s), so the transport is up — the app itself is probably no longer running. Relaunch it; the VM Service URI changes on relaunch.`,
    );
    if (usable.every((d) => d.transport === "usb")) {
      out.push(
        "Every transport is USB. A session started this way dies with the cable — promote to TCP so the next one does not.",
      );
    }
  }
  out.push(...report.notes);
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
