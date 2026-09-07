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

/** DescribeInstances has no resource-level/tag restriction. Only Start/Stop
 * can mutate resources, and only app-tagged instances in the selected region.
 * This key cannot create/terminate instances, change networking or issue SSH.
 * https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ExamplePolicies_EC2.html */
export function machinePowerPolicy(region: string): unknown {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error("Invalid AWS region.");
  return { Version: "2012-10-17", Statement: [
    { Sid: "ReadInstanceState", Effect: "Allow", Action: ["ec2:DescribeInstances"], Resource: "*" },
    { Sid: "PowerTaggedMachines", Effect: "Allow", Action: ["ec2:StartInstances", "ec2:StopInstances"], Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": region, "ec2:ResourceTag/accordagents-worker": "1" } } }
  ] };
}
