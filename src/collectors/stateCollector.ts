import type { Collector, CollectorHealth } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * State-management activity: when application state changed, and how often.
 *
 * Measured against real Riverpod and Provider/Bloc apps on a physical device
 * (2026-08-26). Both broadcast a change notification on the `Extension` stream
 * and neither carries the state itself:
 *
 *     riverpod:new_event        { offset: 42 }
 *     provider:provider_changed { id: "0" }
 *
 * Neither package registers an `ext.riverpod.*` or `ext.provider.*` service
 * extension to fetch the value behind those pointers, so provider *values* and
 * provider *names* are not obtainable through the VM Service. Reading them
 * would take eval-based introspection into package internals, which breaks on
 * every version bump — not something to put underneath a diagnosis.
 *
 * What is obtainable is timing and volume, and that is enough for the question
 * that actually matters: did a burst of state changes precede this rebuild
 * storm? That correlation is deterministic and honest. Anything about *which*
 * provider is not, and is not claimed.
 *
 * `bloc` is included by observation, not assumption: flutter_bloc builds on
 * provider, so a Bloc app's changes arrive as `provider:provider_changed`.
 * A dedicated `bloc:` kind is matched too, in case a future version adds one.
 */

/** Extension-kind prefixes that mean "application state changed". */
const FRAMEWORKS: Array<{ prefix: string; framework: string }> = [
  { prefix: "riverpod:", framework: "riverpod" },
  { prefix: "provider:", framework: "provider" },
  { prefix: "bloc:", framework: "bloc" },
];

export class StateCollector implements Collector {
  readonly name = "state";
  private seen = new Set<string>();

  health(): CollectorHealth {
    if (this.seen.size > 0) {
      return { status: "active", detail: `Observing ${[...this.seen].join(", ")} state changes.` };
    }
    // Silence is genuinely ambiguous here: no state-management package
    // installed, or one installed that simply has not changed anything yet.
    // Saying "active" and explaining beats guessing at "unavailable".
    return {
      status: "active",
      detail:
        "No state-management activity observed yet. Riverpod, Provider and Bloc announce changes on the Extension stream; an app using none of them, or one that has not changed state yet, looks identical here.",
    };
  }

  reset(): void {
    this.seen.clear();
  }

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    // Handler first — see the note in frameCollector.ts about the backlog.
    vm.on("stream:Extension", (event: any) => {
      const kind: string | undefined = event?.extensionKind;
      if (!kind) return;
      const match = FRAMEWORKS.find((f) => kind.startsWith(f.prefix));
      if (!match) return;

      this.seen.add(match.framework);
      const data = event.extensionData ?? {};
      store.add({
        timestamp: Date.now(),
        source: kind,
        severity: "debug",
        category: "state",
        message: `${match.framework} state changed`,
        data: {
          framework: match.framework,
          kind,
          // Opaque pointers, kept because they distinguish one changing
          // provider from another even though neither can be named.
          providerRef: data.id ?? data.offset ?? undefined,
          valuesAvailable: false,
        },
      });
    });

    await vm.streamListen("Extension");
  }
}
