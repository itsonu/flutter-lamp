import type { Collector, CollectorHealth } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * State-management activity, from whatever the framework actually posts to the
 * VM Service — measured, not assumed.
 *
 * ## Riverpod: activity only
 *
 * Riverpod posts `riverpod:new_event` on the `Extension` stream whenever a
 * provider is created, updated, disposed or fails. Measured against
 * `probe/riverpod_probe` on flutter_riverpod 3.4.2: 98 events over 70 seconds,
 * all of them inside the workload phases (tick, invalidate, throw) and none in
 * the idle or navigate phases — so the count tracks real provider work.
 *
 * The payload is `{offset: N}` and nothing else. That offset is a pointer into
 * a buffer that lives inside the app, and no `ext.riverpod.*` service extension
 * is registered to read it (0 of 74 registered extension RPCs on the probe).
 * **So the provider's name, its old value and its new value are not available
 * here, and none of them is invented.** What is available is timing: how much
 * provider activity happened, and when — enough to say a rebuild storm
 * coincided with provider churn, which is the useful half of the question.
 *
 * Reading actual state would need `evaluate` against Riverpod's internals,
 * which is coupled to the package's private API and breaks on a minor version.
 * That is not shipped.
 *
 * ## Bloc: nothing to collect
 *
 * Measured against `probe/bloc_probe` on bloc/flutter_bloc 9.1.1: 143 real
 * `Bloc`/`Cubit` transitions and 2 handler errors produced **zero** events on
 * the `Extension` stream and registered **zero** `ext.bloc.*` RPCs. Stock Bloc
 * has no VM Service integration — its observability goes through
 * `BlocObserver` inside the app process, which nothing outside can reach.
 *
 * So there is no bloc adapter, because there is nothing to adapt to. `health()`
 * says exactly that instead of leaving an agent to read an empty list and
 * conclude the app has no blocs.
 */

/** Frameworks this collector knows how to look for. */
export type StateFramework = "riverpod";

export class StateCollector implements Collector {
  readonly name = "state";

  /** Frameworks seen posting at least once this session. */
  private readonly seen = new Set<StateFramework>();

  reset(): void {
    this.seen.clear();
  }

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    await vm.streamListen("Extension");

    vm.on("stream:Extension", (event: any) => {
      if (event?.extensionKind !== "riverpod:new_event") return;
      this.seen.add("riverpod");

      const offset = Number(event.extensionData?.offset);
      store.add({
        timestamp: Date.now(),
        source: "riverpod:new_event",
        // Debug: on its own one provider update is not notable. It becomes
        // evidence in aggregate, correlated against something that is.
        severity: "debug",
        category: "state",
        message: "Riverpod provider activity",
        data: {
          framework: "riverpod",
          // The app-side buffer index Riverpod sent. Kept because it is the
          // only identity the event carries — it distinguishes distinct
          // activity from a duplicated notification — but it names nothing.
          offset: Number.isFinite(offset) ? offset : null,
        },
      });
    });
  }

  health(): CollectorHealth {
    if (this.seen.has("riverpod")) {
      return {
        status: "degraded",
        detail:
          "Riverpod activity is being counted, but only counted: its events carry an app-side buffer offset and no provider name or value, and no ext.riverpod.* RPC exists to resolve them. Bloc exposes nothing at all to the VM Service.",
      };
    }
    return {
      status: "unavailable",
      detail:
        "No state-management activity is observable on this target. Riverpod posts riverpod:new_event on the Extension stream and none has arrived — either the app does not use Riverpod, or nothing has changed yet. Bloc and Cubit are never observable from here: they post nothing to the VM Service (measured against bloc 9.1.1), so an empty result says nothing about whether the app uses Bloc.",
    };
  }
}
