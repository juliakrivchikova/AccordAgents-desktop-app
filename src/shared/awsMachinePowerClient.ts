import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { assertAwsMachinePowerConfig, type AwsMachinePowerConfig } from "./machinePower";

export interface AwsMachineState {
  instanceId: string;
  state: string;
}

/** The same SDK request/signing path works in the PWA and a headless machine.
 * There is no relay endpoint here, and this client never provisions resources
 * or touches SSH. The configured IAM key must use machinePowerPolicy. */
export class AwsMachinePowerClient {
  private readonly client: EC2Client;
  private readonly config: AwsMachinePowerConfig;

  constructor(config: AwsMachinePowerConfig) {
    assertAwsMachinePowerConfig(config);
    this.config = structuredClone(config);
    this.client = new EC2Client({ region: config.credentials.region, credentials: config.credentials, maxAttempts: 1 });
  }

  close(): void { this.client.destroy(); }

  async describe(signal?: AbortSignal): Promise<AwsMachineState> {
    const result = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [this.config.instanceId] }), {
      abortSignal: boundedSignal(signal)
    });
    const instance = result.Reservations?.flatMap(reservation => reservation.Instances ?? [])
      .find(candidate => candidate.InstanceId === this.config.instanceId);
    if (!instance) throw new Error("The paired AWS machine no longer exists.");
    if (instance.RootDeviceType !== "ebs" || !instance.Tags?.some(tag => tag.Key === "accordagents-worker" && tag.Value === "1")) {
      throw new Error("Power control requires an app-tagged AWS machine with persistent EBS storage.");
    }
    return { instanceId: this.config.instanceId, state: instance.State?.Name ?? "unknown" };
  }

  async start(signal?: AbortSignal): Promise<AwsMachineState> {
    const before = await this.describe(signal);
    if (before.state === "running" || before.state === "pending") return before;
    if (before.state !== "stopped") throw new Error(`The AWS machine is ${before.state}; it cannot start yet.`);
    await this.client.send(new StartInstancesCommand({ InstanceIds: [this.config.instanceId] }), { abortSignal: boundedSignal(signal) });
    return { ...before, state: "pending" };
  }

  /** Only the home runtime calls this after its verified idle drain. A PWA
   * Stop-response action must continue to send the durable native Stop event. */
  async stopAfterDrain(signal?: AbortSignal): Promise<AwsMachineState> {
    const before = await this.describe(signal);
    if (before.state === "stopped" || before.state === "stopping") return before;
    if (before.state !== "running") throw new Error(`The AWS machine is ${before.state}; idle stop cannot proceed.`);
    await this.client.send(new StopInstancesCommand({ InstanceIds: [this.config.instanceId] }), { abortSignal: boundedSignal(signal) });
    return { ...before, state: "stopping" };
  }
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
