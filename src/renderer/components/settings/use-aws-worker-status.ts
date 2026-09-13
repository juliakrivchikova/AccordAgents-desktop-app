import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AwsWorkerStatus } from "../../../shared/types";

export const AWS_TRANSITION_POLL_MS = 3_000;
// Observation only: survives Settings navigation and never replays Stop.
type StopObservation = { instanceId: string; region?: string; since: number };
function createStopStore() {
  let observation: StopObservation | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => observation,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next: StopObservation | undefined) => { observation = next; listeners.forEach(listener => listener()); }
  };
}
const stopStores = new WeakMap<object, ReturnType<typeof createStopStore>>();
function stopStoreFor(bridge: object) {
  let store = stopStores.get(bridge);
  if (!store) { store = createStopStore(); stopStores.set(bridge, store); }
  return store;
}

/** Reads AWS only; polling never retries a mutation or replays old setup. */
export function useAwsWorkerStatus() {
  const [status, setStatus] = useState<AwsWorkerStatus | null>(null);
  const [error, setError] = useState<string>();
  const [checkedAt, setCheckedAt] = useState<number>();
  const [checking, setChecking] = useState(false);
  const stopStore = stopStoreFor(window.consensus);
  const acceptedStop = useSyncExternalStore(stopStore.subscribe, stopStore.snapshot);
  const instance = status?.actualSpec ?? status?.handle;
  const awaitingStop = Boolean(acceptedStop && status?.configured !== false && (!instance || instance.instanceId === acceptedStop.instanceId && instance.region === acceptedStop.region));
  const [actionPending, setActionPending] = useState(false);
  const current = useRef(status);
  const revision = useRef(0);
  const pendingAction = useRef(false);
  const mounted = useRef(true);

  const accept = useCallback((next: AwsWorkerStatus) => {
    revision.current++;
    current.current = next;
    setStatus(next);
    setCheckedAt(Date.now());
    setError(next.actionError ? undefined : next.message);
    const instance = next.actualSpec ?? next.handle;
    const acceptedStop = stopStore.snapshot();
    const matchingStop = acceptedStop && instance?.instanceId === acceptedStop.instanceId && instance?.region === acceptedStop.region;
    const terminal = next.state === "stopped" || next.state === "terminated" || next.state === "absent" || !next.configured;
    if (acceptedStop && (matchingStop && terminal || !next.configured || instance && !matchingStop)) stopStore.set(undefined);
  }, [stopStore]);

  const refresh = useCallback(async () => {
    if (pendingAction.current) return;
    const request = ++revision.current;
    setChecking(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        window.consensus.getAwsWorkerStatus(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AWS status check timed out. The last confirmed state is shown; retrying automatically.")), 20_000); })
      ]);
      if (!mounted.current || request !== revision.current) return;
      if (next.configured && !next.state && next.message) {
        // Losing contact must not turn an observed Stopping into Configured.
        setError(next.message);
        if (!current.current) { current.current = next; setStatus(next); }
      } else {
        accept(next);
      }
    } catch (cause) {
      if (mounted.current && request === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      clearTimeout(timer);
      if (mounted.current && (request === revision.current || request + 1 === revision.current)) setChecking(false);
    }
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; revision.current++; };
  }, [refresh]);

  useEffect(() => {
    if (checking || actionPending) return;
    const timer = setTimeout(() => void refresh(), isAwsTransition(status) || awaitingStop ? AWS_TRANSITION_POLL_MS : 30_000);
    return () => clearTimeout(timer);
  }, [status, error, checkedAt, checking, refresh, awaitingStop, actionPending]);

  const beginAction = (): void => { pendingAction.current = true; setActionPending(true); revision.current++; setChecking(false); setError(undefined); };
  const endAction = (): void => { pendingAction.current = false; if (mounted.current) setActionPending(false); };
  const acceptStop = (next: AwsWorkerStatus, since: number): void => {
    const instance = next.actualSpec ?? next.handle ?? current.current?.actualSpec ?? current.current?.handle;
    if (!next.actionError && instance && next.configured && next.state !== "stopped" && next.state !== "terminated" && next.state !== "absent") {
      stopStore.set({ instanceId: instance.instanceId, region: instance.region, since });
    }
    if (mounted.current) accept(next);
  };
  return { status, error, checkedAt, checking, refresh, accept, acceptStop, beginAction, endAction, awaitingStop, stopRequestedAt: acceptedStop?.since };
}

export function isAwsTransition(status: AwsWorkerStatus | null): boolean {
  return status?.state === "stopping" || status?.state === "pending";
}
