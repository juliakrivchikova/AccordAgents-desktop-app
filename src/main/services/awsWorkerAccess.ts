import type { CloudRunWorkerSettings } from "../../shared/types";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand } from "./command";
import type { AwsWorkerInstanceInfo, AwsWorkerKeyMaterial, Ec2Client } from "./awsWorkerLifecycle";

const SSH_USER = "ubuntu";
const SSH_READY_ATTEMPTS = 18;
const SSH_RETRY_DELAY_MS = 5_000;

export interface AwsWorkerAccessOptions {
  sshExec?: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
}

export class AwsWorkerAccess {
  private readonly sshExec: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;
  private readonly wait: (delayMs: number) => Promise<void>;

  constructor(options: AwsWorkerAccessOptions = {}) {
    this.sshExec = options.sshExec ?? defaultSshExec;
    this.wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async ensureAccess(client: Ec2Client, info: AwsWorkerInstanceInfo, key: AwsWorkerKeyMaterial): Promise<void> {
    if (!info.publicIp) {
      throw new Error("The AWS worker is running without a public IP address.");
    }
    const worker: CloudRunWorkerSettings = {
      host: info.publicIp,
      user: SSH_USER,
      identityFile: key.privateKeyPath,
      hostKeyAlias: `accordagents-${info.instanceId}`
    };
    let publicKeyFailure = false;
    for (let attempt = 0; attempt < SSH_READY_ATTEMPTS; attempt += 1) {
      try {
        await this.sshExec(worker, "true", 20_000);
        return;
      } catch (error) {
        if (isPublicKeyFailure(error)) {
          publicKeyFailure = true;
          break;
        }
        if (!isTransientSshFailure(error) || attempt === SSH_READY_ATTEMPTS - 1) throw error;
        await this.wait(SSH_RETRY_DELAY_MS);
      }
    }
    if (!publicKeyFailure) throw new Error("The AWS worker did not become reachable over SSH.");
    if (!client.sendSshPublicKey || !info.availabilityZone) {
      throw new Error("This device cannot enroll an SSH key for the adopted AWS worker. Re-run the AWS setup command and retry.");
    }
    const appendKey = [
      "umask 077",
      "mkdir -p ~/.ssh",
      "touch ~/.ssh/authorized_keys",
      "chmod 700 ~/.ssh",
      "chmod 600 ~/.ssh/authorized_keys",
      `grep -qxF ${shellQuotePosix(key.publicKeyOpenSsh)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuotePosix(key.publicKeyOpenSsh)} >> ~/.ssh/authorized_keys`
    ].join("; ");
    let lastError: unknown;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await client.sendSshPublicKey(info.instanceId, info.availabilityZone, SSH_USER, key.publicKeyOpenSsh);
        await this.sshExec(worker, appendKey, 20_000);
        await this.sshExec(worker, "true", 20_000);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 11) await this.wait(5_000);
      }
    }
    throw new Error(`Could not enroll this device on the AWS worker: ${errorMessage(lastError)}`);
  }
}

async function defaultSshExec(worker: CloudRunWorkerSettings, command: string, timeoutMs: number): Promise<void> {
  const target = buildCloudRunSshTarget(worker as CloudRunWorkerSettings & { host: string });
  await runCommand("ssh", [...cloudRunSshOptionArgs(worker as CloudRunWorkerSettings & { host: string }), target, command], {
    timeoutMs
  });
}

function isPublicKeyFailure(error: unknown): boolean {
  const message = commandErrorText(error).toLowerCase();
  return message.includes("permission denied (publickey)")
    || message.includes("identity file") && message.includes("not accessible")
    || message.includes("no such file") && message.includes(".pem");
}

function isTransientSshFailure(error: unknown): boolean {
  const message = commandErrorText(error).toLowerCase();
  return message.includes("connection refused")
    || message.includes("connection timed out")
    || message.includes("operation timed out")
    || message.includes("connection reset")
    || message.includes("no route to host")
    || message.includes("connection closed")
    || error instanceof CommandError && error.result.timedOut;
}

function commandErrorText(error: unknown): string {
  if (error instanceof CommandError) {
    return [error.message, error.result.stderr, error.result.stdout].filter(Boolean).join("\n");
  }
  const result = (error as { result?: { stderr?: unknown; stdout?: unknown } } | null)?.result;
  return [errorMessage(error), result?.stderr, result?.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
