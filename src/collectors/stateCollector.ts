import type { Collector, CollectorHealth } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";

/**
 * State-management activity, from whatever the framework actually posts to the
 * VM Service — measured against real apps, not assumed.
 *
 * ## Riverpod: activity only
 *
 * Riverpod posts `riverpod:new_event` on the `Extension` stream whenever a
 * provider is created, updated, disposed or fails. Measured against
 * `probe/riverpod_probe` on flutter_riverpod 3.4.2: 98 events over 70 seconds,
 * all inside the workload phases (tick, invalidate, throw) and none in the idle
 * or navigate phases — so the count tracks real provider work.
 *
 * The payload is `{offset: N}` and nothing else: a pointer into a buffer inside
 * the app, with no `ext.riverpod.*` service extension registered to read it.
 * **Provider names and values are therefore unavailable, and none is invented.**
 *
 * ## Bloc: observable, but only through provider
 *
 * `bloc` itself posts nothing to the VM Service and registers no `ext.bloc.*`
 * RPC — its own observability goes through `BlocObserver`, inside the app
 * process, which nothing outside can reach. That much is measured and true.
 *
 * It does not follow that a Bloc app is invisible. `flutter_bloc` 9.1.1 depends
 * transitively on `provider` (confirmed in `probe/bloc_probe/pubspec.lock`), and
 * `provider` posts `provider:provider_changed` in debug builds. Measured against
 * `probe/bloc_probe`: 20 printed `Bloc`/`Cubit` transitions alongside 1,220
 * `provider:provider_changed` events, each burst following a transition marker
 * in the same stream. So Bloc state changes *are* observable as provider
 * activity — attributed to `provider`, which is what actually emitted them,
 * rather than to `bloc`, which did not.
 *
 * The payload is `{id: "0"}` — again a pointer, again no names or values.
 *
 * ## What this collector claims
 *
 * That state changed, which framework announced it, and when. Never what
 * changed, and never which provider. Reading values would need `evaluate`
 * against package internals, coupled to private APIs that break on a minor
 * version bump; that is not shipped.
 */

/** Extension-kind prefixes that mean "application state changed". */
const FRAMEWORKS: Array<{ prefix: string; framework: string }> = [
  { prefix: "riverpod:", framework: "riverpod" },
  // Also the route by which Bloc and Cubit changes surface — see above.
  { prefix: "provider:", framework: "provider" },
  // Matched in case a future bloc release adds VM Service integration; as of
  // 9.1.1 it posts nothing, so this never fires today.
  { prefix: "bloc:", framework: "bloc" },
];

export class StateCollector implements Collector {
  readonly name = "state";
  /** Frameworks seen posting at least once this session. */
  private readonly seen = new Set<string>();

  health(): CollectorHealth {
    if (this.seen.size > 0) {
      return {
        status: "active",
        detail:
          `Observing ${[...this.seen].sort().join(", ")} state changes. Counted only: the events carry an ` +
          "opaque pointer, not a provider name or value, and no service extension exists to resolve it.",
      };
    }
    // Silence here is genuinely ambiguous, and the ambiguity is the useful
    // thing to report: no state-management package, or one installed that has
    // not changed anything yet, look identical from outside.
    return {
      status: "active",
      detail:
        "No state-management activity observed yet. Riverpod posts riverpod:new_event and provider posts " +
        "provider:provider_changed (which is how flutter_bloc's changes surface, since it depends on provider). " +
        "An app using none of them, and one that simply has not changed state yet, look the same from here. " +
        "Stock bloc alone posts nothing to the VM Service, so an empty result never proves an app has no blocs.",
    };
  }

  reset(): void {
    this.seen.clear();
  }

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    // Handler first, subscribe last — the VM Service flushes a backlog the
    // moment a subscription is accepted. See the note in frameCollector.ts.
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
        // One provider update is not notable on its own. It becomes evidence in
        // aggregate, correlated against something that is.
        severity: "debug",
        category: "state",
        message: `${match.framework} state changed`,
        data: {
          framework: match.framework,
          kind,
          // The only identity these events carry: Riverpod's buffer offset or
          // provider's element id. It distinguishes distinct activity from a
          // duplicated notification, and names nothing.
          providerRef: data.offset ?? data.id ?? undefined,
          valuesAvailable: false,
        },
      });
    });

    await vm.streamListen("Extension");
  }
}
