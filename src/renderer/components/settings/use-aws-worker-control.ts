import { useEffect, useRef, useState } from "react";
import type { AwsWorkerOperationSnapshot, AwsWorkerSpec, AwsWorkerSpecResolution, CloudRunsSettings } from "../../../shared/types";
import { cleanError } from "./aws-shared";
import { useAwsAutoStop } from "./aws-worker-auto-stop";
import { isAwsTransition, useAwsWorkerStatus } from "./use-aws-worker-status";

export type AwsAction = "setup" | "resize" | "check" | "stop" | "delete" | "command";
export type AwsAttemptIntent = "setup" | "resize" | "check";
const isAttempt = (action: AwsAction | undefined): action is AwsAttemptIntent => action === "setup" || action === "resize" || action === "check";

const TERMINAL_PHASES: AwsWorkerOperationSnapshot["phase"][] = ["ready", "error", "needs-decision"];
const livePhase = (operation: AwsWorkerOperationSnapshot | null | undefined): boolean =>
  Boolean(operation && !TERMINAL_PHASES.includes(operation.phase));
const latestOperation = (
  previous: AwsWorkerOperationSnapshot | null,
  next: AwsWorkerOperationSnapshot | null
): AwsWorkerOperationSnapshot | null => {
  if (!next) return previous;
  const sameStamp = previous?.operationId === next.operationId && previous?.updatedAt === next.updatedAt;
  if (previous && (previous.updatedAt > next.updatedAt || sameStamp && !livePhase(previous) && livePhase(next))) return previous;
  return next;
};

/**
 * Everything the AWS page does to the instance, without any of its layout:
 * one attempt at a time (start, resize, check), stop, delete, and the setup
 * command for connecting or recovering access. The page's sections read the
 * same state, so a change made in one dialog shows everywhere at once.
 */
export function useAwsWorkerControl(settings: CloudRunsSettings, onDeleted: () => Promise<void>) {
  const monitor = useAwsWorkerStatus();
  const { status } = monitor;
  const [region, setRegion] = useState(settings.awsRegion ?? "us-east-1");
  const [command, setCommand] = useState("");
  const [commandError, setCommandError] = useState<string>();
  const [blob, setBlob] = useState("");
  const [operation, setOperation] = useState<AwsWorkerOperationSnapshot | null>(null);
  const [activeOperationId, setActiveOperationId] = useState<string>();
  const [action, setAction] = useState<AwsAction>();
  const [busy, setBusy] = useState(false);
  const active = useRef<AwsAction>();
  const [startedAt, setStartedAt] = useState<number>();
  const [feedback, setFeedback] = useState<{ message: string; failed: boolean; action?: AwsAction }>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (active.current) return;
    const next = status?.operation;
    setOperation(previous => latestOperation(previous, next ?? null));
    if (next && livePhase(next) && !action) {
      setActiveOperationId(next.operationId);
      setAction(next.intent ?? "setup");
    }
  }, [status?.operation, action]);
  useEffect(() => window.consensus.onAwsWorkerProgress(next => {
    if (next.operationId !== activeOperationId || !isAttempt(action)) return;
    setOperation(previous => latestOperation(previous, next));
    setFeedback(undefined);
  }), [activeOperationId, action]);

  const currentOperation = operation?.operationId === activeOperationId && isAttempt(action) ? operation : null;
  const begin = (kind: AwsAction): boolean => {
    if (active.current || isAwsTransition(status) || monitor.awaitingStop) return false;
    active.current = kind;
    monitor.beginAction();
    // Reading recovery instructions keeps the failed attempt current.
    if (kind !== "command" || !currentOperation) setAction(kind);
    setBusy(true);
    setFeedback(undefined);
    setStartedAt(Date.now());
    return true;
  };
  const finish = (): void => {
    active.current = undefined;
    monitor.endAction();
    if (mounted.current) setBusy(false);
  };
  const fail = (cause: unknown, kind?: AwsAction): void => {
    if (mounted.current) setFeedback({ message: cleanError(cause), failed: true, action: kind });
  };

  const actual = status?.actualSpec;
  const configured = Boolean(status?.configured);
  const baseSpec: AwsWorkerSpec = actual ?? { instanceType: settings.awsInstanceType, rootVolumeSizeGb: settings.awsRootVolumeSizeGb };
  const mismatch = currentOperation?.phase === "needs-decision" ? currentOperation.specMismatch : undefined;
  // A size decision answers the attempt that raised it: "keep" during Start
  // continues the start, "keep" during an explicit resize changes nothing.
  const decisionIntent: AwsAttemptIntent = currentOperation?.intent === "resize" ? "resize" : "setup";
  const showProgress = livePhase(currentOperation) && !feedback?.failed;
  const locked = busy || showProgress || isAwsTransition(status) || monitor.awaitingStop;

  const start = async (
    resolution?: AwsWorkerSpecResolution,
    spec: AwsWorkerSpec = baseSpec,
    intent: AwsAttemptIntent = "setup"
  ): Promise<boolean> => {
    if (!begin(intent)) return false;
    const continuation = operation && (operation.phase === "error" || operation.phase === "needs-decision") && (operation.intent ?? "setup") === intent
      ? operation
      : undefined;
    const operationId = continuation?.operationId ?? crypto.randomUUID();
    setActiveOperationId(operationId);
    try {
      const result = await window.consensus.startAwsWorker({
        operationId,
        clientToken: continuation?.clientToken ?? operationId,
        intent,
        blob: blob.trim() || undefined,
        instanceType: spec.instanceType,
        rootVolumeSizeGb: spec.rootVolumeSizeGb,
        resolution,
        expectedInstanceId: mismatch?.instanceId ?? (intent === "resize" ? actual?.instanceId : undefined),
        expectedDesiredSpec: resolution ? spec : undefined,
        expectedActualSpec: intent === "resize" && actual && !mismatch ? actual : undefined
      });
      if (!mounted.current) return false;
      monitor.accept(result.status);
      setOperation(result.operation);
      const failed = result.operation.phase === "error";
      setFeedback({ message: result.operation.message, failed, action: intent });
      if (result.status.configured) setBlob("");
      return !failed;
    } catch (cause) {
      fail(cause, intent);
      return false;
    } finally {
      finish();
    }
  };
  /** A bigger disk keeps the instance; AWS cannot make it smaller. */
  const growDisk = (sizeGb: number): Promise<boolean> =>
    actual ? start("grow-disk", { instanceType: actual.instanceType, rootVolumeSizeGb: sizeGb }, "resize") : Promise.resolve(false);
  /** Another type means a new instance at that type, with the same disk size. */
  const changeType = (instanceType: string): Promise<boolean> =>
    actual ? start("recreate", { instanceType, rootVolumeSizeGb: actual.rootVolumeSizeGb }, "resize") : Promise.resolve(false);

  const stop = async (): Promise<boolean> => {
    if (!begin("stop")) return false;
    try {
      const next = await window.consensus.stopAwsWorker();
      monitor.acceptStop(next, Date.now());
      if (!mounted.current) return false;
      if (next.actionError) {
        setFeedback({ message: next.message ?? next.actionError, failed: true, action: "stop" });
        return false;
      }
      return true;
    } catch (cause) {
      fail(cause, "stop");
      return false;
    } finally {
      finish();
    }
  };
  const remove = async (): Promise<boolean> => {
    if (!begin("delete")) return false;
    try {
      const next = await window.consensus.deleteAwsWorker();
      if (!mounted.current) return false;
      monitor.accept(next);
      if (next.configured) {
        setFeedback({ message: next.message ?? "Deletion has not been confirmed.", failed: true, action: "delete" });
        return false;
      }
      setOperation(null);
      await onDeleted();
      return true;
    } catch (cause) {
      fail(cause, "delete");
      return false;
    } finally {
      finish();
    }
  };
  const loadCommand = async (forRegion = region): Promise<void> => {
    if (!begin("command")) return;
    setCommandError(undefined);
    const recoveryOperationId = currentOperation?.phase === "error" && currentOperation.remediation === "refresh-aws-authorization"
      ? currentOperation.operationId
      : undefined;
    try {
      setCommand(await window.consensus.getAwsWorkerBootstrapCommand(forRegion.trim() || "us-east-1", recoveryOperationId));
    } catch (cause) {
      if (mounted.current) setCommandError(cleanError(cause));
    } finally {
      finish();
    }
  };
  // A switch that could not change says why in its own row.
  const [autoStopError, setAutoStopError] = useState<string>();
  const autoStopControl = useAwsAutoStop(status?.autoStop, monitor.accept, (cause) => setAutoStopError(cause ? cleanError(cause) : undefined));

  const isRunning = status?.state === "running" || status?.state === "pending";
  const stoppedLike = configured && (status?.state === "stopped" || status?.state === "absent" || status?.state === "terminated");
  // Configured but AWS is not answering: the last known state may still be
  // shown; the page checks access by itself, which is also how a revoked
  // permission reaches recovery.
  const statusUnavailable = Boolean(status) && configured && (Boolean(monitor.error) || !status?.state);
  const canStart = Boolean(blob.trim() || settings.hasAwsCredentials || configured);
  const authorizationFailure = currentOperation?.phase === "error" && currentOperation.remediation === "refresh-aws-authorization"
    ? currentOperation : undefined;
  const attemptFailed = isAttempt(action) && Boolean(feedback?.failed || currentOperation?.phase === "error") && !authorizationFailure;

  return {
    monitor, status, actual, configured, baseSpec, region, setRegion, command, commandError, blob, setBlob,
    currentOperation, action, busy, locked, feedback, startedAt, mismatch, decisionIntent, showProgress,
    isRunning, stoppedLike, statusUnavailable, canStart, authorizationFailure, attemptFailed,
    autoStopControl, autoStopError, start, growDisk, changeType, stop, remove, loadCommand,
    instanceRegion: status?.handle?.region ?? actual?.region ?? region
  };
}

export type AwsWorkerControl = ReturnType<typeof useAwsWorkerControl>;
