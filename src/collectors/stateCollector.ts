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
 * or navigate phases — so the count tracked real provider work in that run.
 * That is one observation, not a repeated invariant; `probe/EVIDENCE.md` labels
 * it as such and `probe/measure.mjs` re-runs it.
 *
 * The payload is `{offset: N}` and nothing else: a pointer into a buffer inside
 * the app, with no `ext.riverpod.*` service extension registered to read it.
 * **Provider names and values are therefore unavailable, and none is invented.**
 *
 * ## Bloc: not directly observable; its notifications are
 *
 * Stock `bloc` posts nothing to the VM Service and registers no `ext.bloc.*`
 * RPC (measured, flutter_bloc 9.1.1). Its own observability runs through
 * `BlocObserver`, inside the app process, which nothing outside can reach. Bloc
 * transitions, events, states and errors are therefore **not** observable here,
 * and Bloc is **not** natively instrumented for the VM Service.
 *
 * A flutter_bloc app is still not silent, for an indirect reason: `flutter_bloc`
 * depends transitively on `provider` (`probe/bloc_probe/pubspec.lock`), and
 * `provider` posts `provider:provider_changed` when dependents are notified.
 * Measured on `probe/bloc_probe`: 20 printed transitions alongside ~1,220
 * provider events.
 *
 * That ratio is the important part. The probe has `stormWatchers = 60`, each a
 * `BlocBuilder`, so ~60 notifications per transition — which means the event
 * count measures **how many widgets were notified, not how many state changes
 * happened**. Bloc transition counts cannot be recovered from it, and an app
 * whose lookup avoided provider would produce nothing at all.
 *
 * See `probe/EVIDENCE.md` for the measurements and what each does not
 * establish.
 *
 * ## What this collector claims
 *
 * That state-management activity occurred, which package announced it, and
 * when. Never what changed, never which provider, and never how many state
 * changes there were — a provider event is one notified dependent. Reading
 * values would need `evaluate` against package internals, coupled to private
 * APIs that break on a minor version bump; that is not shipped.
 */

/** Extension-kind prefixes that mean "state-management activity happened". */
const FRAMEWORKS: Array<{ prefix: string; framework: string }> = [
  { prefix: "riverpod:", framework: "riverpod" },
  // The only route by which a flutter_bloc app shows up at all — and it
  // counts notified dependents, not transitions. See above.
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
          `Observing ${[...this.seen].sort().join(", ")} activity. Counted only: each event carries an ` +
          "opaque pointer, not a provider name or value, and no service extension exists to resolve it. " +
          "A provider event means dependents were notified, so the count is not a count of state changes.",
      };
    }
    // Silence here is genuinely ambiguous, and the ambiguity is the useful
    // thing to report: no state-management package, or one installed that has
    // not changed anything yet, look identical from outside.
    return {
      status: "active",
      detail:
        "No state-management activity observed yet. Riverpod posts riverpod:new_event and provider posts " +
        "provider:provider_changed when dependents are notified (which is the only way a flutter_bloc app " +
        "shows up, since bloc itself posts nothing). An app using none of them, and one that simply has not " +
        "changed state yet, look the same from here, so an empty result never proves an app has no blocs.",
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
        message: `${match.framework} state activity`,
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
