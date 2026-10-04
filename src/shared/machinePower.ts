/** Power control is independent of the relay: paired devices keep this
 * narrowly scoped key locally and contact EC2 only to wake/stop a machine. */
export interface MachinePowerCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface AwsMachinePowerConfig {
  version: 1;
  instanceId: string;
  credentials: MachinePowerCredentials;
}

export const MACHINE_IDLE_STOP_MS = 3 * 60 * 60_000;

/** How long the machine keeps asking AWS whether a handed-over key works
 *  (a new IAM key takes a few seconds to be accepted), and how long the
 *  installer waits for that answer: the second must outlast the first, or a
 *  refusal arrives as a timeout and is never recorded. */
export const MACHINE_POWER_KEY_CHECK_MS = 60_000;
export const MACHINE_POWER_HANDOVER_TIMEOUT_MS = MACHINE_POWER_KEY_CHECK_MS + 60_000;

/** The exit code `--configure-power` uses when the key itself is refused
 *  (AWS or the instance said no). Any other failure is temporary. */
export const MACHINE_POWER_REFUSED_EXIT_CODE = 3;

/** How a machine reports that AWS no longer accepts its stop key; the
 *  desktop reads it to offer setting automatic stop up again. */
export const MACHINE_STOP_KEY_REFUSED = "AWS does not accept this machine's stop key";

/** What a machine reports while its idle stop goes as intended. */
export const MACHINE_IDLE_STOPPING = "The machine is stopping after three hours idle; new turns remain queued.";
export const MACHINE_IDLE_COMPLETING = "The machine is completing its retained idle stop; new turns remain queued.";
export const MACHINE_IDLE_STOP_WITHDRAWN = "The interrupted idle-stop preparation did not commit; queued work can continue.";
export const machineIdleStoppedWarning = (state: string): string =>
  `The AWS machine is ${state} after three hours idle; queued turns run after it wakes.`;
/** Begins what a machine reports while AWS has not confirmed its stop yet. */
export const MACHINE_IDLE_STOP_UNCONFIRMED = "Idle stop is not confirmed";

/**
 * What a machine's idle-stop warning means for the User:
 * - `progress`: the stop is happening as intended;
 * - `activity`: agents are working (only runtimes before 1.11.1 report this);
 * - `refused`: AWS does not accept the stop key;
 * - `unconfirmed`: AWS has not confirmed a stop yet, and it is asked again;
 * - `fault`: the machine cannot tell whether agents are working.
 */
export function machineIdleWarningKind(warning: string): "progress" | "activity" | "refused" | "unconfirmed" | "fault" {
  if (warning.includes(MACHINE_STOP_KEY_REFUSED)) return "refused";
  if (warning === MACHINE_IDLE_STOPPING || warning === MACHINE_IDLE_COMPLETING || warning === MACHINE_IDLE_STOP_WITHDRAWN
    || /^The AWS machine is \S+ after three hours idle; queued turns run after it wakes\.$/.test(warning)) return "progress";
  if (warning.startsWith(MACHINE_IDLE_STOP_UNCONFIRMED)) return "unconfirmed";
  if (LEGACY_ACTIVITY_WARNING.test(warning)) return "activity";
  return "fault";
}

/** What runtimes before 1.11.1 reported while agents in another deployment
 *  were working: the ordinary reason to stay up, not a fault. */
const LEGACY_ACTIVITY_WARNING =
  /^The machine stays awake: (Another deployment on this machine \(.*\) is running (work|a maintenance command)\.|another deployment on this machine worked recently\.)$/;

/** A definitive no to a power key: retrying the same key cannot succeed. */
export class MachinePowerRefusal extends Error {
  override name = "MachinePowerRefusal";
}

export function assertAwsMachinePowerConfig(value: unknown): asserts value is AwsMachinePowerConfig {
  const config = value as Partial<AwsMachinePowerConfig> | undefined;
  const credentials = config?.credentials;
  if (!config || config.version !== 1 || typeof config.instanceId !== "string" || !/^i-[a-f0-9]{8,17}$/.test(config.instanceId) ||
      !credentials || typeof credentials.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(credentials.region) ||
      typeof credentials.accessKeyId !== "string" || !/^[A-Z0-9]{16,128}$/.test(credentials.accessKeyId) ||
      typeof credentials.secretAccessKey !== "string" || !credentials.secretAccessKey.trim()) {
    throw new Error("Invalid machine power configuration.");
  }
}

/** DescribeInstances has no resource-level/tag restriction, so it is held to
 * the selected region: the key lives on a machine where agents run. It can
 * still list every instance in that region, which AWS offers no way to
 * narrow. Only Start/Stop can mutate resources, and only app-tagged
 * instances in that region. This key cannot create/terminate instances,
 * change networking or issue SSH.
 * https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ExamplePolicies_EC2.html */
export function machinePowerPolicy(region: string): unknown {
  assertAwsRegion(region);
  return { Version: "2012-10-17", Statement: [
    { Sid: "ReadInstanceState", Effect: "Allow", Action: ["ec2:DescribeInstances"], Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": region } } },
    { Sid: "PowerTaggedMachines", Effect: "Allow", Action: ["ec2:StartInstances", "ec2:StopInstances"], Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": region, "ec2:ResourceTag/accordagents-worker": "1" } } }
  ] };
}

/** The phone's own key: it can start app-tagged instances in the region, and
 * nothing else; the phone never reads instance state, so it gets no Describe.
 * Stopping stays with the machine, the only party that can prove its work has
 * drained. Minted once by the setup command and never replaced by it, so a
 * phone is paired with it once. */
export function machineWakePolicy(region: string): unknown {
  assertAwsRegion(region);
  return { Version: "2012-10-17", Statement: [
    { Sid: "StartTaggedMachines", Effect: "Allow", Action: ["ec2:StartInstances"], Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": region, "ec2:ResourceTag/accordagents-worker": "1" } } }
  ] };
}

function assertAwsRegion(region: string): void {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error("Invalid AWS region.");
}
