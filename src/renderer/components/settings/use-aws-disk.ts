import { useCallback, useEffect, useRef, useState } from "react";
import type { AwsDiskChangeResult, AwsDiskCleanCategory, AwsDiskLockReason, AwsDiskReport } from "../../../shared/types";
import { cleanError } from "./aws-shared";

/** Below this, the disk section says so in red: updates and agents fail
 *  under about 2 GB, and a busy day of logs fills a gigabyte or two. */
export const AWS_DISK_LOW_BYTES = 5_000_000_000;

/** Sizes the way Finder shows them: decimal, one decimal place from GB. A
 *  value that rounds up to the next unit is said in that unit. */
export function formatBytes(bytes: number): string {
  if (bytes >= 999_500_000) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 999_500) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Why the instance kept a file, in the words the file browser uses. */
export const LOCK_TEXT: Record<AwsDiskLockReason, string | undefined> = {
  "system": undefined,
  "sign-ins": "holds the agents' sign-ins",
  "agent-tools": "in use by the agents",
  "program": "the program's own files",
  "running-version": "running now",
  "qa-browser": "the browser for QA",
  "other-program": "another computer's program",
  "in-use": "in use right now",
  "worktree": "has a member's worktree",
  "changes": "has uncommitted changes",
  "unpushed": "has commits not pushed anywhere",
  "repository": "part of a git project; only the whole project can go"
};

/** What a change left in place and why, in one sentence each. */
export function keptText(failed: AwsDiskChangeResult["failed"]): string | undefined {
  if (!failed.length) return undefined;
  const parts: string[] = [];
  const locked = failed.flatMap((failure) => failure.reason === "error" ? [] : [failure.reason]);
  if (locked.length) {
    const reasons = [...new Set(locked.map((reason) => LOCK_TEXT[reason] ?? "protected"))];
    parts.push(`${plural(locked.length, "item")} stayed: ${reasons.join("; ")}.`);
  }
  const errors = failed.filter((failure) => failure.reason === "error");
  if (errors.length) {
    const messages = [...new Set(errors.map((failure) => failure.message ?? "could not be removed"))];
    parts.push(`${plural(errors.length, "item")} could not be removed: ${messages.join("; ")}.`);
  }
  return parts.join(" ");
}

/**
 * The instance's disk as last measured, measured again by itself when the
 * page opens and the last measurement is old, and after every change. A
 * change applies its result at once (free space, the category it emptied)
 * and the full picture follows from the next measurement.
 */
export function useAwsDisk(running: boolean) {
  const [report, setReport] = useState<AwsDiskReport>();
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const measure = useCallback(async (refresh = false): Promise<void> => {
    setMeasuring(true);
    setError(undefined);
    try {
      const next = await window.consensus.getAwsInstanceDisk({ refresh });
      if (mounted.current) setReport(next);
    } catch (cause) {
      if (mounted.current) setError(cleanError(cause));
    } finally {
      if (mounted.current) setMeasuring(false);
    }
  }, []);
  useEffect(() => { if (running) void measure(); }, [running, measure]);

  /** What a change did, shown before the next measurement arrives. */
  const applyChange = (result: AwsDiskChangeResult, emptied?: AwsDiskCleanCategory): void => {
    setReport((current) => current ? {
      ...current,
      ...result.space,
      categories: current.categories.map((category) => category.id === emptied
        ? { ...category, bytes: Math.max(0, category.bytes - result.freedBytes), cleanableBytes: 0 }
        : category)
    } : current);
    void measure(true);
  };
  const clean = async (category: AwsDiskCleanCategory): Promise<AwsDiskChangeResult> => {
    const result = await window.consensus.cleanAwsInstanceDisk(category);
    if (mounted.current) applyChange(result, category);
    return result;
  };
  const remove = async (paths: string[]): Promise<AwsDiskChangeResult> => {
    const result = await window.consensus.deleteAwsInstanceFiles(paths);
    if (mounted.current) applyChange(result);
    return result;
  };
  return { report, measuring, error, measure, clean, remove };
}

export type AwsDiskControl = ReturnType<typeof useAwsDisk>;
