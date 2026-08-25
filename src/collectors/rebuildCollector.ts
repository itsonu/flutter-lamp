import type { Collector } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * Per-frame widget rebuild counts, resolved to widget name and source location.
 *
 * `ext.flutter.inspector.trackRebuildDirtyWidgets` makes the framework post a
 * `Flutter.RebuiltWidgets` event per frame. The payload is deliberately compact:
 *
 *     {
 *       frameNumber, startTime,
 *       events: [locationId, count, locationId, count, ...],
 *       locations:    { "file:///…": { ids, lines, columns, names } },
 *       newLocations: { "file:///…": [id, line, column, …] }
 *     }
 *
 * Location tables arrive incrementally — a file is described once, and later
 * frames reference its ids without repeating it — so the map has to be
 * accumulated across events and reset per session. Crucially, anything
 * described BEFORE this collector attached is never re-sent, so the map is
 * seeded from `widgetLocationIdMap` at startup. Without that seed, most ids in
 * a mid-session connection resolve to nothing: measured against a real app,
 * 714 of 1346 rebuilds landed in an "unknown" bucket.
 *
 * This is what turns "the build phase was slow" into "AppShell at
 * app_shell.dart:221 rebuilt 16 times", which is the difference between a
 * number and something actionable.
 */

interface WidgetLocation {
  name?: string;
  file: string;
  line?: number;
  column?: number;
}

/**
 * How many hotspots to keep per frame. The tail is counted, not stored.
 *
 * Kept twice over: the busiest locations overall, and the busiest that belong
 * to the developer's own code. A frame can touch 150 locations, most of them
 * framework internals rebuilt once — without the second slice, the handful of
 * app widgets that actually matter get truncated away behind package noise.
 */
const TOP_N = 12;

export class RebuildCollector implements Collector {
  readonly name = "rebuilds";
  private locations = new Map<number, WidgetLocation>();

  reset(): void {
    this.locations.clear();
  }

  async start(vm: VmService, store: RuntimeStore, isolateId: string): Promise<void> {
    await vm.streamListen("Extension");

    try {
      // Without widget creation tracking there are no location ids to resolve,
      // so rebuild counts would be anonymous numbers. Say so rather than
      // reporting a table of unnamed integers.
      const tracked = await vm.call<{ result?: boolean }>(
        "ext.flutter.inspector.isWidgetCreationTracked",
        { isolateId },
      );
      if (tracked?.result !== true) {
        store.add({
          timestamp: Date.now(),
          source: "system",
          severity: "info",
          category: "system",
          message:
            "Widget creation is not tracked in this build, so rebuild counts cannot be attributed to widgets.",
          data: {},
        });
        return;
      }
      // Seed the whole location table. Connecting mid-session means every id
      // already described is absent from future events.
      const seed = await vm.call<{ result?: unknown }>(
        "ext.flutter.inspector.widgetLocationIdMap",
        { isolateId },
      );
      this.ingestLocations(seed?.result ?? seed);

      await vm.call("ext.flutter.inspector.trackRebuildDirtyWidgets", {
        isolateId,
        enabled: "true", // the extension expects the string, not a bool
      });
    } catch {
      return; // no Inspector (release build) — nothing to collect
    }

    vm.on("stream:Extension", (event: any) => {
      if (event?.extensionKind !== "Flutter.RebuiltWidgets") return;
      const d = event.extensionData ?? {};
      this.ingestLocations(d.locations);
      this.ingestNewLocations(d.newLocations);

      const pairs: number[] = Array.isArray(d.events) ? d.events : [];
      const counted: Array<{ location: WidgetLocation; count: number }> = [];
      let total = 0;
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const count = pairs[i + 1];
        if (!count) continue;
        total += count;
        const location = this.locations.get(pairs[i]) ?? { file: "unknown" };
        counted.push({ location, count });
      }
      if (total === 0) return;

      counted.sort((a, b) => b.count - a.count);
      const kept = new Set([
        ...counted.slice(0, TOP_N),
        ...counted.filter((c) => isAppCode(c.location.file)).slice(0, TOP_N),
      ]);
      const top = [...kept].map(({ location, count }) => ({
        widget: location.name,
        file: shortenFile(location.file),
        line: location.line,
        column: location.column,
        count,
        appCode: isAppCode(location.file),
      }));
      top.sort((a, b) => b.count - a.count);
      const headline = top[0];

      store.add({
        timestamp: Date.now(),
        source: "Flutter.RebuiltWidgets",
        severity: "debug",
        category: "rebuild",
        message:
          `Frame #${d.frameNumber ?? "?"}: ${total} widget rebuild(s)` +
          (headline?.widget ? `, most in ${headline.widget} ×${headline.count}` : ""),
        data: {
          frameNumber: d.frameNumber,
          totalRebuilds: total,
          distinctLocations: counted.length,
          top,
          truncated: counted.length > top.length,
        },
      });
    });
  }

  /** `locations` carries names; prefer it over `newLocations`. */
  private ingestLocations(locations: unknown): void {
    if (!locations || typeof locations !== "object") return;
    for (const [file, value] of Object.entries(locations as Record<string, any>)) {
      const ids: number[] = value?.ids ?? [];
      for (let i = 0; i < ids.length; i++) {
        this.locations.set(ids[i], {
          name: value?.names?.[i],
          file,
          line: value?.lines?.[i],
          column: value?.columns?.[i],
        });
      }
    }
  }

  /** `newLocations` is a flat [id, line, column, …] run per file, with no names. */
  private ingestNewLocations(newLocations: unknown): void {
    if (!newLocations || typeof newLocations !== "object") return;
    for (const [file, value] of Object.entries(newLocations as Record<string, any>)) {
      if (!Array.isArray(value)) continue;
      for (let i = 0; i + 2 < value.length; i += 3) {
        const id = value[i];
        if (this.locations.has(id)) continue; // never overwrite a named entry
        this.locations.set(id, { file, line: value[i + 1], column: value[i + 2] });
      }
    }
  }
}

/**
 * Whether a source file belongs to the developer's own code.
 *
 * Heuristic by necessity: `getPubRootDirectories` returns an empty list until a
 * DevTools client sets it, so there is no authoritative project root to compare
 * against. Excluding the package cache and the Flutter/Dart SDKs is accurate in
 * practice and fails in the safe direction — a misclassified file is still
 * reported, just not promoted as the headline.
 */
export function isAppCode(file: string): boolean {
  if (!file || file === "unknown") return false;
  const f = file.toLowerCase();
  return !(
    f.includes("/hosted/pub.dev/") ||
    f.includes("/pub.cache/") ||
    f.includes("/.pub-cache/") ||
    f.includes("/packages/flutter/lib/") ||
    f.includes("/packages/flutter_") ||
    f.includes("/dart-sdk/")
  );
}

/** Trim the file URI to something readable without losing identity. */
export function shortenFile(file: string): string {
  if (!file) return "unknown";
  const withoutScheme = file.replace(/^file:\/\/\/?/, "");
  const packaged = withoutScheme.match(/hosted\/pub\.dev\/([^/]+)\/(.*)$/);
  if (packaged) return `${packaged[1]}/${packaged[2]}`;
  const sdk = withoutScheme.match(/packages\/(flutter[^/]*)\/lib\/(.*)$/);
  if (sdk) return `${sdk[1]}/${sdk[2]}`;
  // App code: keep the last few segments, which is where the meaning is.
  const parts = withoutScheme.split("/");
  return parts.slice(-3).join("/");
}
