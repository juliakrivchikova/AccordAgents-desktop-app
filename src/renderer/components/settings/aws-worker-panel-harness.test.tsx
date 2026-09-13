import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus, CloudRunsSettings } from "../../../shared/types";
import { AwsWorkerPanel } from "./aws-worker-panel";

export const SETTINGS: CloudRunsSettings = { enabled: true, mode: "aws", worker: {}, hasAwsCredentials: true, awsInstanceType: "t3.small", awsRootVolumeSizeGb: 8, maxRuntimeMs: 86_400_000, pollIntervalMs: 2_500 };
export const RUNNING: AwsWorkerStatus = { configured: true, state: "running", actualSpec: { instanceId: "i-shared", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 40 } };
export const OLD_ERROR: AwsWorkerOperationSnapshot = { operationId: "old", clientToken: "old-token", phase: "error", message: "Missing AWS permission", updatedAt: "2026-07-10T00:00:00Z", retryable: true, remediation: "refresh-aws-authorization" };

export function ready(request: AwsWorkerStartRequest, status = RUNNING) {
  const operation: AwsWorkerOperationSnapshot = { operationId: request.operationId, intent: request.intent, phase: "ready", message: "Ready", updatedAt: new Date().toISOString() };
  return { status: { ...status, operation }, operation };
}

export async function renderPanel(options: {
  status: AwsWorkerStatus;
  settings?: CloudRunsSettings;
  command?: (region: string, recoveryOperationId?: string) => Promise<string>;
  getStatus?: () => Promise<AwsWorkerStatus>;
  onProgress?: (listener: (operation: AwsWorkerOperationSnapshot) => void) => void;
  start?: (request: AwsWorkerStartRequest) => Promise<any>;
  stop?: () => Promise<AwsWorkerStatus>;
  remove?: () => Promise<AwsWorkerStatus>;
  onDeleted?: () => Promise<void>;
}): Promise<ReactTestRenderer> {
  const bridge = {
    getAwsWorkerStatus: options.getStatus ?? (async () => options.status),
    onAwsWorkerProgress: (listener: (operation: AwsWorkerOperationSnapshot) => void) => { options.onProgress?.(listener); return () => undefined; },
    startAwsWorker: options.start ?? (async request => ready(request)),
    stopAwsWorker: options.stop ?? (async () => options.status), deleteAwsWorker: options.remove ?? (async () => options.status),
    listMachines: async () => ({ machines: [], status: [] }), onMachinesUpdated: () => () => undefined,
    getAwsWorkerBootstrapCommand: options.command ?? (async () => "command"), openExternal: async () => undefined,
    onCloudRunSetupProgress: () => () => undefined,
    diagnoseCloudRunWorker: async () => ({ ok: true, message: "Checked", checks: [] }),
    setupCloudRunWorker: async () => ({ ok: true, message: "Set up", checks: [] })
  };
  (globalThis as any).window = { consensus: bridge, setTimeout };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => undefined } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AwsWorkerPanel settings={options.settings ?? SETTINGS} onDeleted={options.onDeleted ?? (async () => undefined)} />); await flush(); });
  return renderer;
}
export async function edit(renderer: ReactTestRenderer): Promise<void> { await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" })); await click(renderer.root.findByProps({ "data-testid": "aws-worker-size-edit" })); }
export function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance { return renderer.root.find(node => node.type === "button" && textOf(node) === label); }
export async function click(node: ReactTestInstance): Promise<void> { await act(async () => { node.props.onClick(); await flush(); }); }
export async function change(node: ReactTestInstance, value: string): Promise<void> { await act(async () => { node.props.onChange({ target: { value } }); await flush(); }); }
export function textOf(node: ReactTestInstance): string { return node.children.map(child => typeof child === "string" ? child : textOf(child as ReactTestInstance)).join(""); }
export function unmount(renderer: ReactTestRenderer): void { act(() => renderer.unmount()); }
export async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
