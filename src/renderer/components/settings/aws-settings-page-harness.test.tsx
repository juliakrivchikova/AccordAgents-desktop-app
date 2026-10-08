// The AWS page mounted in a DOM with a bridge that records every call; the
// page's tests share it.
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";

import type {
  AwsDiskReport, AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus, CloudRunWorkerDoctorReport,
  CloudRunWorkerSetupProgress, CloudRunsSettings
} from "../../../shared/types";
import { AwsSettingsPage } from "./aws-settings-page";
import { forgetAwsSetupChecks } from "./aws-setup-section";
import { clearAwsAttention, useAwsAttention } from "./use-aws-attention";

declare global {
  var ACCORD_RENDERER_JSDOM: boolean | undefined;
}

export const SETTINGS = { enabled: true, mode: "aws", worker: {}, hasAwsCredentials: true, awsInstanceType: "t3.small",
  awsRootVolumeSizeGb: 40, maxRuntimeMs: 86_400_000, pollIntervalMs: 2_500, awsRegion: "us-east-1" } as CloudRunsSettings;
export const RUNNING = { configured: true, state: "running",
  handle: { instanceId: "i-0943", region: "us-east-1" },
  actualSpec: { instanceId: "i-0943", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 40, vCpu: 2, memoryMiB: 2048 },
  autoStop: { enabled: true, needsSetup: false } } as AwsWorkerStatus;
export const DISK: AwsDiskReport = { totalBytes: 40_500_000_000, usedBytes: 36_800_000_000, availableBytes: 3_700_000_000, measuredAt: Date.now(), categories: [
  { id: "system", bytes: 6_700_000_000 },
  { id: "program-logs", bytes: 2_260_000_000, cleanableBytes: 900_000_000, files: 4 },
  { id: "project-copies", bytes: 1_460_000_000, projects: ["AccordAgents-0a6205133d"] },
  { id: "program-versions", bytes: 930_000_000, cleanableBytes: 820_000_000, count: 8, inUse: 1 },
  { id: "swap", bytes: 8_590_000_000 }
] };
export const CHECKS: CloudRunWorkerDoctorReport = { ok: false, message: "1 problem", checks: [
  { id: "connect", label: "SSH connection", status: "pass" },
  { id: "codex", label: "Codex CLI", status: "pass" },
  { id: "codex-auth", label: "Codex signed in", status: "fail", detail: "Codex is not signed in on the worker.", fixable: true },
  { id: "claude", label: "Claude Code CLI", status: "pass" },
  { id: "claude-auth", label: "Claude Code signed in", status: "pass" },
  { id: "gh", label: "GitHub CLI", status: "pass", fixable: true }
] };

let mounted: ReturnType<typeof createRoot> | undefined;

interface Bridge {
  calls: Record<string, unknown[][]>;
  progress: Array<(progress: CloudRunWorkerSetupProgress) => void>;
  operations: Array<(operation: AwsWorkerOperationSnapshot) => void>;
}

/** The Settings sidebar's AWS dot, as the sidebar reads it. */
function AttentionProbe(): JSX.Element {
  return <span data-testid="attention-probe" data-attention={String(useAwsAttention())} />;
}

export async function mount(options: {
  status?: AwsWorkerStatus;
  settings?: CloudRunsSettings;
  start?: (request: AwsWorkerStartRequest) => Promise<{ operation: AwsWorkerOperationSnapshot; status: AwsWorkerStatus }>;
  machines?: unknown;
  installs?: unknown[];
  appVersion?: string;
  disk?: AwsDiskReport;
  checks?: CloudRunWorkerDoctorReport;
  getStatus?: () => Promise<AwsWorkerStatus>;
  stop?: () => Promise<AwsWorkerStatus>;
  remove?: () => Promise<AwsWorkerStatus>;
  clean?: (category: string) => Promise<unknown>;
  list?: (path?: string) => Promise<unknown>;
  del?: (paths: string[]) => Promise<unknown>;
  keepSetupChecks?: boolean;
} = {}) {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  if (mounted) { const previous = mounted; mounted = undefined; await act(async () => { previous.unmount(); }); }
  if (!options.keepSetupChecks) forgetAwsSetupChecks();
  clearAwsAttention();
  let status = options.status ?? RUNNING;
  const bridge: Bridge = { calls: {}, progress: [], operations: [] };
  const record = (name: string, ...args: unknown[]): void => { (bridge.calls[name] ??= []).push(args); };
  (window as unknown as { consensus: unknown }).consensus = {
    getAwsWorkerStatus: options.getStatus ?? (async () => status),
    onAwsWorkerProgress: (listener: (operation: AwsWorkerOperationSnapshot) => void) => { bridge.operations.push(listener); return () => undefined; },
    startAwsWorker: async (request: AwsWorkerStartRequest) => {
      record("startAwsWorker", request);
      const result = options.start ? await options.start(request)
        : { operation: { operationId: request.operationId, intent: request.intent, phase: "ready", message: "Done", updatedAt: new Date().toISOString() } as AwsWorkerOperationSnapshot, status };
      status = result.status;
      return result;
    },
    stopAwsWorker: async () => { record("stopAwsWorker"); return options.stop ? options.stop() : { ...status, state: "stopped" }; },
    deleteAwsWorker: async () => {
      record("deleteAwsWorker");
      const next = options.remove ? await options.remove() : { configured: false } as AwsWorkerStatus;
      status = next;
      return next;
    },
    getAwsWorkerBootstrapCommand: async (region: string, recovery?: string) => { record("command", region, recovery); return `command-for-${region}`; },
    setAwsAutoStop: async () => status,
    reconnectAwsMachine: async (machineId?: string) => { record("reconnectAwsMachine", machineId); return status; },
    listMachines: async () => options.machines ?? { machines: [], status: [] },
    onMachinesUpdated: () => () => undefined,
    listMachineInstalls: async () => options.installs ?? [],
    getAppVersion: async () => options.appVersion ?? "1.11.2-beta.3",
    onMachineInstallProgress: () => () => undefined,
    getAwsInstanceDisk: async (request?: { refresh?: boolean }) => { record("getAwsInstanceDisk", request); return options.disk ?? DISK; },
    cleanAwsInstanceDisk: async (category: string) => {
      record("cleanAwsInstanceDisk", category);
      if (options.clean) return options.clean(category);
      return { freedBytes: 900_000_000, failed: [], space: { totalBytes: DISK.totalBytes, usedBytes: 35_900_000_000, availableBytes: 4_600_000_000 } };
    },
    listAwsInstanceFiles: async (path?: string) => {
      record("listAwsInstanceFiles", path);
      if (options.list) return options.list(path);
      return { path: "/home/ubuntu/own/workspace/mirrors", home: "/home/ubuntu", own: "/home/ubuntu/own", truncated: 0, entries: [
        { name: "AccordAgents-0a6205133d", path: "/home/ubuntu/own/workspace/mirrors/AccordAgents-0a6205133d", bytes: 1_460_000_000, dir: true, lock: "worktree" },
        { name: "old-project-1234567890", path: "/home/ubuntu/own/workspace/mirrors/old-project-1234567890", bytes: 300_000_000, dir: true, lock: null }
      ] };
    },
    deleteAwsInstanceFiles: async (paths: string[]) => {
      record("deleteAwsInstanceFiles", paths);
      if (options.del) return options.del(paths);
      return { freedBytes: 300_000_000, removed: 1, failed: [], space: { totalBytes: DISK.totalBytes, usedBytes: 36_500_000_000, availableBytes: 4_000_000_000 } };
    },
    diagnoseCloudRunWorker: async () => { record("diagnoseCloudRunWorker"); return options.checks ?? CHECKS; },
    setupCloudRunWorker: async () => { record("setupCloudRunWorker"); return new Promise(() => undefined); },
    onCloudRunSetupProgress: (listener: (progress: CloudRunWorkerSetupProgress) => void) => { bridge.progress.push(listener); return () => undefined; },
    getCloudRunSetupProgress: async () => undefined,
    openExternal: async (url: string) => { record("openExternal", url); },
    submitCloudRunAuthCode: async () => undefined,
    cancelCloudRunAuth: async (requestId: string) => { record("cancelCloudRunAuth", requestId); },
    isCloudRunAuthActive: async () => true
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => undefined } } });
  document.body.replaceChildren();
  const container = document.createElement("div");
  container.className = "settings-view";
  document.body.append(container);
  const root = createRoot(container);
  mounted = root;
  const deleted: string[] = [];
  const page = (): JSX.Element => (
    <TooltipProvider>
      <AwsSettingsPage settings={options.settings ?? SETTINGS} onDeleted={async () => { deleted.push("deleted"); }} />
      <AttentionProbe />
    </TooltipProvider>
  );
  await act(async () => { root.render(page()); });
  // setImmediate, not setTimeout: tests that mock timers still settle.
  const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); }); };
  await settle();
  /** Leaves Settings and comes back, with the same app behind it. */
  const remount = async (): Promise<void> => {
    await act(async () => { mounted?.unmount(); });
    const next = createRoot(container);
    mounted = next;
    await act(async () => { next.render(page()); });
    await settle();
  };
  const find = <T extends HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
  const button = (label: string, scope: ParentNode = document): HTMLButtonElement | null =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label) ?? null;
  const click = async (element: Element | null): Promise<void> => {
    assert.ok(element, "missing element to click");
    await act(async () => { (element as HTMLElement).click(); });
    await settle();
  };
  const type = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string): Promise<void> => {
    assert.ok(element, "missing field");
    const proto = element instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    await act(async () => { element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
    await settle();
  };
  const tick = async (t: { mock: { timers: { tick: (ms: number) => void } } }, ms: number): Promise<void> => {
    await act(async () => { t.mock.timers.tick(ms); });
    await settle();
  };
  return { bridge, find, button, click, type, settle, deleted, remount, tick, setStatus: (next: AwsWorkerStatus) => { status = next; } };
}

export async function unmount(): Promise<void> {
  await act(async () => { mounted?.unmount(); });
  mounted = undefined;
}
