import { useEffect, useReducer, useState } from "react";
import type { AwsWorkerStatus } from "../../../shared/types";

/** Things only the AWS page measures (the disk, the setup checks, the
 *  program's updates) report here, so Settings can mark AWS while the User
 *  is elsewhere in Settings. */
export type AwsAttentionTopic = "program" | "disk" | "setup";
const published = new Map<AwsAttentionTopic, boolean>();
const listeners = new Set<() => void>();
const STATUS_POLL_MS = 60_000;

export function publishAwsAttention(topic: AwsAttentionTopic, needed: boolean): void {
  if ((published.get(topic) ?? false) === needed) return;
  published.set(topic, needed);
  for (const listener of listeners) listener();
}

/** Without an instance nothing the page measured still applies. */
export function clearAwsAttention(): void {
  for (const topic of [...published.keys()]) publishAwsAttention(topic, false);
}

/** A problem the instance status itself reports. */
export function awsStatusNeedsAttention(status: AwsWorkerStatus): boolean {
  return Boolean(status.configured && (status.machineProblem || status.autoStop?.problem
    || status.operation?.phase === "error" && status.operation.remediation === "refresh-aws-authorization"));
}

/** True when something on the AWS page needs the User: a problem the
 *  instance status reports, or one the page measured on its last visit. */
export function useAwsAttention(): boolean {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [statusProblem, setStatusProblem] = useState(false);
  useEffect(() => {
    listeners.add(rerender);
    return () => { listeners.delete(rerender); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void window.consensus.getAwsWorkerStatus().then((status) => {
        if (cancelled) return;
        setStatusProblem(awsStatusNeedsAttention(status));
      }).catch(() => undefined);
    };
    read();
    const timer = setInterval(read, STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return statusProblem || [...published.values()].some(Boolean);
}
