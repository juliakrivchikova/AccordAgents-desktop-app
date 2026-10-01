import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { assertAwsMachinePowerConfig, MachinePowerRefusal, type AwsMachinePowerConfig } from "./machinePower";

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
    if (!instance) throw new MachinePowerRefusal("The paired AWS machine no longer exists.");
    if (instance.RootDeviceType !== "ebs" || !instance.Tags?.some(tag => tag.Key === "accordagents-worker" && tag.Value === "1")) {
      throw new MachinePowerRefusal("Power control requires an app-tagged AWS machine with persistent EBS storage.");
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

  /** Asks AWS whether this key may stop the machine, without stopping it
   *  (EC2 DryRun answers `DryRunOperation` exactly when the call would be
   *  allowed). Used when the key is handed over, not three hours later. */
  async assertCanStop(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.send(new StopInstancesCommand({ InstanceIds: [this.config.instanceId], DryRun: true }), {
        abortSignal: boundedSignal(signal)
      });
    } catch (error) {
      if ((error as { name?: unknown })?.name === "DryRunOperation") return;
      throw error;
    }
    throw new MachinePowerRefusal("AWS did not confirm that this key may stop the machine.");
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

/** AWS errors a key that was just created, or a policy that was just put,
 *  answers with for a few seconds before IAM has caught up. */
const KEY_PROPAGATION_ERRORS = new Set(["AuthFailure", "InvalidClientTokenId", "UnauthorizedOperation", "UnrecognizedClientException"]);

/**
 * Asks AWS, until `deadlineMs`, whether this key can read and stop the
 * machine. A key AWS rejects outright, or still rejects at the deadline, is a
 * `MachinePowerRefusal` with AWS's own reason; a deadline spent waiting on an
 * unreachable or failing AWS is an ordinary error, so the key is tried again.
 */
export async function verifyMachinePowerKey(
  client: Pick<AwsMachinePowerClient, "describe" | "assertCanStop">,
  options: { deadlineMs: number; retryMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const end = now() + options.deadlineMs;
  let last: unknown;
  for (;;) {
    const remaining = end - now();
    if (remaining <= 0) break;
    const deadline = AbortSignal.timeout(remaining);
    try {
      await client.describe(deadline);
      await client.assertCanStop(deadline);
      return;
    } catch (error) {
      // The deadline cut the call short: AWS's last real answer stands.
      if (deadline.aborted) break;
      last = error;
      if (error instanceof MachinePowerRefusal) throw error;
      if (awsClientFault(error) && !KEY_PROPAGATION_ERRORS.has(awsErrorName(error))) {
        throw new MachinePowerRefusal(`AWS refused the automatic-stop key: ${awsErrorText(error)}`);
      }
    }
    if (end - now() <= options.retryMs) break;
    await sleep(options.retryMs);
  }
  if (last !== undefined && awsClientFault(last)) {
    throw new MachinePowerRefusal(`AWS refused the automatic-stop key: ${awsErrorText(last)}`);
  }
  throw new Error(last === undefined
    ? "AWS did not answer the automatic-stop key check in time."
    : `AWS could not be reached to check the automatic-stop key: ${awsErrorText(last)}`);
}

/** AWS (or what it reported about the instance) said no to this key, as
 *  opposed to a network failure, a timeout or an AWS outage. */
export function isAwsPowerRefusal(error: unknown): boolean {
  return error instanceof MachinePowerRefusal || awsClientFault(error);
}

/** AWS answered and said no (a 4xx), as opposed to a network failure, a
 *  timeout or an AWS outage. */
function awsClientFault(error: unknown): boolean {
  return (error as { $fault?: unknown } | undefined)?.$fault === "client";
}

function awsErrorName(error: unknown): string {
  return String((error as { name?: unknown } | undefined)?.name ?? "");
}

/** AWS's code and its first sentence, without the encoded authorization blob
 *  some refusals append, so the same refusal always reads the same. */
export function awsErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const plain = message.split(/\s*Encoded authorization failure message:/i)[0].trim();
  const name = awsErrorName(error);
  return name && name !== "Error" && !plain.startsWith(name) ? `${name}: ${plain}` : plain;
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
