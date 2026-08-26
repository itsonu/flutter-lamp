import { eventTime, type Collector } from "./collector.js";
import type { RuntimeStore } from "../core/runtimeStore.js";
import type { VmService } from "../vm/vmService.js";
import { redactText } from "../core/redaction.js";

/**
 * Route changes from the `Extension` stream, extensionKind "Flutter.Navigation".
 *
 * Flutter's Navigator posts this itself on every push, pop, replace and remove
 * (`packages/flutter/lib/src/widgets/navigator.dart`, `_afterNavigation`), so
 * no observer has to be installed in the app. The payload is:
 *
 *     { route: { description, settings: { name, arguments? } } | null }
 *
 * `route` is null when the last route is popped. The event is guarded by
 * `!kReleaseMode`, so like everything else here it is debug and profile only.
 *
 * Route arguments are redacted: they routinely carry ids, tokens and user data,
 * and a route name plus its arguments is often the most identifying thing in a
 * whole session.
 */
export class NavigationCollector implements Collector {
  readonly name = "navigation";

  async start(vm: VmService, store: RuntimeStore): Promise<void> {
    // Handlers are registered BEFORE subscribing, deliberately. The VM Service
    // (through DDS) delivers a backlog of buffered stream events the instant a
    // subscription is accepted, and those arrive before the continuation after
    // `await streamListen` runs. Subscribing first therefore drops everything
    // the app produced before this session connected -- measured on a real
    // device as 622 events lost versus 0 with this ordering, which is the
    // entire history when attaching to an already-running app.
    vm.on("stream:Extension", (event: any) => {
      if (event?.extensionKind !== "Flutter.Navigation") return;
      const route = event.extensionData?.route;

      if (!route) {
        store.add({
          timestamp: eventTime(event),
          source: "Flutter.Navigation",
          severity: "info",
          category: "navigation",
          message: "Navigated back past the last route",
          data: { name: null, popped: true },
        });
        return;
      }

      const settings = route.settings ?? {};
      const name: string | null = typeof settings.name === "string" ? settings.name : null;
      const description: string | undefined =
        typeof route.description === "string" ? route.description : undefined;
      const label = name ?? description ?? "unnamed route";

      store.add({
        timestamp: eventTime(event),
        source: "Flutter.Navigation",
        severity: "info",
        category: "navigation",
        message: `Navigated to ${label}`,
        data: {
          name,
          description,
          arguments: typeof settings.arguments === "string" ? redactText(settings.arguments) : undefined,
        },
      });
    });

    await vm.streamListen("Extension");
  }
}
