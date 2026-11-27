import { useSyncExternalStore } from "react";

import { EMPTY_PLAN_USAGE_VIEW } from "../../../../shared/planUsage";
import type { PlanUsageRefreshRequest, PlanUsageRefreshResult, PlanUsageView } from "../../../../shared/types";

/**
 * The plan usage of the members' CLI accounts as the main process knows it
 * (this computer's CLIs, and each machine's through the User's server),
 * shared by every ring: one subscription and one question to the main
 * process, kept while any ring is shown.
 */
let current: PlanUsageView = EMPTY_PLAN_USAGE_VIEW;
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;

function publish(next: PlanUsageView): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopListening) {
    let changed = false;
    // Component tests mount composers without the whole bridge.
    const bridge = globalThis.window?.consensus;
    const off = bridge?.onPlanUsageChanged?.((next) => {
      changed = true;
      publish(next);
    });
    stopListening = () => {
      changed = true;
      off?.();
    };
    void bridge?.getPlanUsage?.().then((view) => {
      if (view && !changed) publish(view);
    }).catch(() => undefined);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
}

export function usePlanUsageView(): PlanUsageView {
  return useSyncExternalStore(subscribe, () => current, () => EMPTY_PLAN_USAGE_VIEW);
}

/** Asks for a fresh read (a card opened, Refresh); the answer arrives as a
 *  change. Resolves when the read ended, whatever it found, saying why a
 *  machine's could not be read. */
export async function refreshPlanUsage(request: PlanUsageRefreshRequest): Promise<PlanUsageRefreshResult["failed"]> {
  const bridge = globalThis.window?.consensus;
  const result = await bridge?.refreshPlanUsage?.(request).catch(() => undefined);
  if (result?.view) publish(result.view);
  return result ? result.failed : request.machineId ? "server-unreachable" : undefined;
}
