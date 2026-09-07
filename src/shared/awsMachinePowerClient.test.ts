import assert from "node:assert/strict";
import test from "node:test";
import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { AwsMachinePowerClient } from "./awsMachinePowerClient";

test("power uses only the enrolled persistent app-tagged instance and never forces Stop or terminates it", async () => {
  const config = { version: 1 as const, instanceId: "i-0123456789abcdef0",
    credentials: { accessKeyId: "AKIAFAKEMACHINEPOWER1", secretAccessKey: "synthetic-power-secret", region: "us-east-1" } };
  const client = new AwsMachinePowerClient(config); const calls: unknown[] = [];
  let state = "stopped"; let tagged = true; let root = "ebs";
  (client as any).client.send = async (command: any) => {
    calls.push(command);
    assert.deepEqual(command.input, { InstanceIds: [config.instanceId] });
    if (command instanceof DescribeInstancesCommand) return { Reservations: [{ Instances: [{ InstanceId: config.instanceId,
      State: { Name: state }, RootDeviceType: root, Tags: tagged ? [{ Key: "accordagents-worker", Value: "1" }] : [] }] }] };
    return {};
  };
  try {
    assert.equal((await client.start()).state, "pending");
    assert.ok(calls.at(-1) instanceof StartInstancesCommand);
    state = "running"; assert.equal((await client.stopAfterDrain()).state, "stopping");
    assert.ok(calls.at(-1) instanceof StopInstancesCommand);
    state = "stopping"; calls.length = 0; await client.stopAfterDrain();
    assert.equal(calls.length, 1, "an uncertain Stop retry observes the accepted state without another mutation");
    await assert.rejects(client.start(), /cannot start yet/);
    state = "running"; tagged = false;
    await assert.rejects(client.stopAfterDrain(), /app-tagged/);
    assert.ok(calls.at(-1) instanceof DescribeInstancesCommand);
    tagged = true; root = "instance-store";
    await assert.rejects(client.stopAfterDrain(), /persistent EBS/);
    assert.ok(calls.at(-1) instanceof DescribeInstancesCommand);
  } finally { client.close(); }
});
