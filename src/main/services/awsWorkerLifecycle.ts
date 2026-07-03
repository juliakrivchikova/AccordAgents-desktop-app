// AWS-managed Cloud Runs worker lifecycle: create / ensure-running / auto-stop /
// terminate an EC2 instance the app fully owns. The EC2 calls go through an
// injectable Ec2Client so the state machine is unit-testable with a fake and
// the real client (awsEc2Client.ts) can lazy-load the AWS SDK.

import {
  AWS_WORKER_TAG_KEY,
  AWS_WORKER_TAG_VALUE,
  buildWorkerInstanceSpec,
  ipToCidr,
  UBUNTU_2404_NAME_PATTERN,
  UBUNTU_2404_OWNER
} from "./awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";

export type AwsWorkerInstanceState =
  | "absent"
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "terminated";

export interface AwsWorkerInstanceInfo {
  instanceId: string;
  state: AwsWorkerInstanceState;
  publicIp?: string;
}

export interface Ec2Client {
  resolveUbuntuImageId(namePattern: string, owner: string): Promise<string>;
  ensureKeyPair(name: string, publicKeyMaterial: string): Promise<void>;
  ensureSecurityGroup(name: string, description: string): Promise<string>;
  authorizeSshIngress(securityGroupId: string, cidr: string): Promise<void>;
  revokeAllSshIngress(securityGroupId: string): Promise<void>;
  runInstance(spec: ReturnType<typeof buildWorkerInstanceSpec>): Promise<string>;
  describeInstance(instanceId: string): Promise<AwsWorkerInstanceInfo | undefined>;
  startInstance(instanceId: string): Promise<void>;
  stopInstance(instanceId: string): Promise<void>;
  terminateInstance(instanceId: string): Promise<void>;
}

export interface AwsWorkerKeyMaterial {
  keyName: string;
  publicKeyOpenSsh: string;
  privateKeyPath: string;
}

export interface AwsWorkerLifecycleOptions {
  createEc2Client: (credentials: AwsWorkerCredentials) => Ec2Client;
  generateKeyMaterial: () => Promise<AwsWorkerKeyMaterial>;
  currentPublicIp: () => Promise<string>;
  waitForState?: (
    poll: () => Promise<AwsWorkerInstanceInfo | undefined>,
    predicate: (info: AwsWorkerInstanceInfo | undefined) => boolean,
    timeoutMs: number
  ) => Promise<AwsWorkerInstanceInfo | undefined>;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  idleStopMs?: number;
  now?: () => number;
}

export interface AwsWorkerHandle {
  instanceId: string;
  securityGroupId: string;
  keyName: string;
  privateKeyPath: string;
  region: string;
}

const RUNNING_WAIT_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_IDLE_STOP_MS = 20 * 60_000;
const SECURITY_GROUP_NAME = "accordagents-worker-sg";

export class AwsWorkerLifecycle {
  private readonly options: Required<Pick<AwsWorkerLifecycleOptions,
    "createEc2Client" | "generateKeyMaterial" | "currentPublicIp" | "waitForState" | "idleStopMs" | "now">>
    & Pick<AwsWorkerLifecycleOptions, "logger">;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRuns = 0;

  constructor(options: AwsWorkerLifecycleOptions) {
    this.options = {
      createEc2Client: options.createEc2Client,
      generateKeyMaterial: options.generateKeyMaterial,
      currentPublicIp: options.currentPublicIp,
      waitForState: options.waitForState ?? defaultWaitForState,
      idleStopMs: options.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
      now: options.now ?? (() => Date.now()),
      logger: options.logger
    };
  }

  // First-time provisioning: resolve the Ubuntu AMI, upload an app-generated
  // key, open SSH to the caller's current IP only, and launch a tagged
  // instance. Returns the handle the app persists.
  async createWorker(credentials: AwsWorkerCredentials, instanceType?: string): Promise<AwsWorkerHandle> {
    const client = this.options.createEc2Client(credentials);
    const key = await this.options.generateKeyMaterial();
    const [imageId, securityGroupId, publicIp] = await Promise.all([
      client.resolveUbuntuImageId(UBUNTU_2404_NAME_PATTERN, UBUNTU_2404_OWNER),
      client.ensureSecurityGroup(SECURITY_GROUP_NAME, "AccordAgents Cloud Runs worker"),
      this.options.currentPublicIp()
    ]);
    await client.ensureKeyPair(key.keyName, key.publicKeyOpenSsh);
    await client.authorizeSshIngress(securityGroupId, ipToCidr(publicIp));
    const spec = buildWorkerInstanceSpec({ imageId, keyName: key.keyName, securityGroupId, instanceType });
    const instanceId = await client.runInstance(spec);
    this.log("aws-worker.created", { instanceId, securityGroupId });
    return {
      instanceId,
      securityGroupId,
      keyName: key.keyName,
      privateKeyPath: key.privateKeyPath,
      region: credentials.region
    };
  }

  // Bring the worker up for a run: start it if stopped, wait for running, then
  // re-resolve its (changed-on-each-start) public IP and re-open SSH ingress
  // to the caller's current IP. Returns the reachable public IP.
  async ensureRunning(credentials: AwsWorkerCredentials, handle: AwsWorkerHandle): Promise<string> {
    const client = this.options.createEc2Client(credentials);
    let info = await client.describeInstance(handle.instanceId);
    if (!info || info.state === "terminated") {
      throw new Error("The AWS worker instance no longer exists. Create a new worker.");
    }
    if (info.state === "stopped" || info.state === "stopping") {
      this.log("aws-worker.starting", { instanceId: handle.instanceId });
      if (info.state === "stopping") {
        await this.options.waitForState(
          () => client.describeInstance(handle.instanceId),
          (current) => current?.state === "stopped",
          RUNNING_WAIT_TIMEOUT_MS
        );
      }
      await client.startInstance(handle.instanceId);
    }
    info = await this.options.waitForState(
      () => client.describeInstance(handle.instanceId),
      (current) => current?.state === "running" && Boolean(current.publicIp),
      RUNNING_WAIT_TIMEOUT_MS
    );
    if (!info?.publicIp) {
      throw new Error("The AWS worker started but no public IP was assigned.");
    }
    // Ingress is rebuilt from scratch: a laptop that changed networks would
    // otherwise be locked out, and stale allow rules from an old IP linger.
    await client.revokeAllSshIngress(handle.securityGroupId);
    await client.authorizeSshIngress(handle.securityGroupId, ipToCidr(await this.options.currentPublicIp()));
    this.log("aws-worker.running", { instanceId: handle.instanceId, publicIp: info.publicIp });
    return info.publicIp;
  }

  // Ref-counted idle tracking: the app calls these around each remote run. When
  // the last run ends, an idle timer stops the instance to save cost; a new run
  // arriving first cancels it.
  runStarted(): void {
    this.activeRuns += 1;
    this.clearIdleTimer();
  }

  runEnded(credentials: AwsWorkerCredentials, handle: AwsWorkerHandle): void {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns > 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.stopIfIdle(credentials, handle);
    }, this.options.idleStopMs);
  }

  private async stopIfIdle(credentials: AwsWorkerCredentials, handle: AwsWorkerHandle): Promise<void> {
    if (this.activeRuns > 0) {
      return;
    }
    try {
      const client = this.options.createEc2Client(credentials);
      const info = await client.describeInstance(handle.instanceId);
      if (info?.state === "running") {
        await client.stopInstance(handle.instanceId);
        this.log("aws-worker.idle-stopped", { instanceId: handle.instanceId });
      }
    } catch (error) {
      this.log("aws-worker.idle-stop.error", {
        instanceId: handle.instanceId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async deleteWorker(credentials: AwsWorkerCredentials, handle: AwsWorkerHandle): Promise<void> {
    this.clearIdleTimer();
    const client = this.options.createEc2Client(credentials);
    await client.terminateInstance(handle.instanceId);
    this.log("aws-worker.terminated", { instanceId: handle.instanceId });
  }

  async stopWorker(credentials: AwsWorkerCredentials, handle: AwsWorkerHandle): Promise<void> {
    this.clearIdleTimer();
    this.activeRuns = 0;
    const client = this.options.createEc2Client(credentials);
    const info = await client.describeInstance(handle.instanceId);
    if (info?.state === "running" || info?.state === "pending") {
      await client.stopInstance(handle.instanceId);
      this.log("aws-worker.stopped", { instanceId: handle.instanceId });
    }
  }

  async describe(credentials: AwsWorkerCredentials, handle: AwsWorkerHandle): Promise<AwsWorkerInstanceInfo | undefined> {
    return this.options.createEc2Client(credentials).describeInstance(handle.instanceId);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.options.logger?.(event, { tag: `${AWS_WORKER_TAG_KEY}=${AWS_WORKER_TAG_VALUE}`, ...payload });
  }
}

async function defaultWaitForState(
  poll: () => Promise<AwsWorkerInstanceInfo | undefined>,
  predicate: (info: AwsWorkerInstanceInfo | undefined) => boolean,
  timeoutMs: number
): Promise<AwsWorkerInstanceInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  let info = await poll();
  while (!predicate(info)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the AWS worker instance to reach the expected state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    info = await poll();
  }
  return info;
}
