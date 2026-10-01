import assert from "node:assert/strict";
import test from "node:test";
import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { AwsMachinePowerClient, awsErrorText, verifyMachinePowerKey } from "./awsMachinePowerClient";
import { MachinePowerRefusal } from "./machinePower";

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

test("checking the stop key asks AWS as a dry run and never stops the machine", async () => {
  const config = { version: 1 as const, instanceId: "i-0123456789abcdef0",
    credentials: { accessKeyId: "AKIAFAKEMACHINEPOWER1", secretAccessKey: "synthetic-power-secret", region: "us-east-1" } };
  const client = new AwsMachinePowerClient(config); const calls: any[] = [];
  let answer: Error | undefined;
  (client as any).client.send = async (command: any) => {
    calls.push(command);
    if (answer) throw answer;
    return {};
  };
  const named = (name: string) => Object.assign(new Error(name), { name });
  try {
    answer = named("DryRunOperation");
    await client.assertCanStop();
    assert.ok(calls[0] instanceof StopInstancesCommand);
    assert.deepEqual(calls[0].input, { InstanceIds: [config.instanceId], DryRun: true }, "only ever a dry run");
    answer = named("UnauthorizedOperation");
    await assert.rejects(client.assertCanStop(), /UnauthorizedOperation/);
    answer = undefined;
    await assert.rejects(client.assertCanStop(), /did not confirm/, "a dry run AWS did not answer as one is not a yes");
  } finally { client.close(); }
});

function awsError(name: string, message: string, fault: "client" | "server" = "client"): Error {
  return Object.assign(new Error(message), { name, $fault: fault });
}

/** A fake clock: sleeping advances it, so the 60 s deadline costs nothing. */
function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

test("a new stop key is retried while IAM catches up, then accepted", async () => {
  const time = clock();
  let calls = 0;
  await verifyMachinePowerKey({
    describe: async () => { calls++; if (calls < 3) throw awsError("AuthFailure", "AWS was not able to validate the provided access credentials"); return { instanceId: "i-1", state: "running" }; },
    assertCanStop: async () => undefined
  }, { deadlineMs: 60_000, retryMs: 5_000, ...time });
  assert.equal(calls, 3);
});

test("a key AWS still refuses at the deadline is refused with AWS's reason, not the timeout", async () => {
  const time = clock();
  const error = await verifyMachinePowerKey({
    describe: async () => ({ instanceId: "i-1", state: "running" }),
    assertCanStop: async () => { throw awsError("UnauthorizedOperation", "You are not authorized to perform this operation. Encoded authorization failure message: abc123"); }
  }, { deadlineMs: 60_000, retryMs: 5_000, ...time }).catch((caught: unknown) => caught);
  assert.ok(error instanceof MachinePowerRefusal);
  assert.equal(error.message, "AWS refused the automatic-stop key: UnauthorizedOperation: You are not authorized to perform this operation.");
  assert.ok(time.now() < 60_000, "the check ends inside its deadline");
});

test("a refusal that waiting cannot fix is reported at once", async () => {
  for (const failure of [new MachinePowerRefusal("Power control requires an app-tagged AWS machine with persistent EBS storage."),
    awsError("InvalidInstanceID.NotFound", "The instance ID 'i-1' does not exist")]) {
    const time = clock();
    let calls = 0;
    const error = await verifyMachinePowerKey({
      describe: async () => { calls++; throw failure; },
      assertCanStop: async () => undefined
    }, { deadlineMs: 60_000, retryMs: 5_000, ...time }).catch((caught: unknown) => caught);
    assert.ok(error instanceof MachinePowerRefusal, String(error));
    assert.equal(calls, 1);
    assert.equal(time.now(), 0, "no time is spent waiting while the runtime is drained");
  }
});

test("an AWS that cannot be reached is not a refusal of the key", async () => {
  for (const failure of [Object.assign(new Error("getaddrinfo ENOTFOUND ec2.us-east-1.amazonaws.com"), { code: "ENOTFOUND" }),
    awsError("InternalError", "An internal error has occurred", "server")]) {
    const time = clock();
    const error = await verifyMachinePowerKey({
      describe: async () => { throw failure; },
      assertCanStop: async () => undefined
    }, { deadlineMs: 60_000, retryMs: 5_000, ...time }).catch((caught: unknown) => caught);
    assert.ok(error instanceof Error && !(error instanceof MachinePowerRefusal), String(error));
    assert.match((error as Error).message, /could not be reached/);
  }
});

test("AWS's refusal text drops the encoded blob, so the same refusal always reads the same", () => {
  assert.equal(awsErrorText(awsError("UnauthorizedOperation", "You are not authorized. Encoded authorization failure message: x1")),
    awsErrorText(awsError("UnauthorizedOperation", "You are not authorized. Encoded authorization failure message: y2")));
  assert.equal(awsErrorText(new Error("plain")), "plain");
});

test("a check AWS never answers is temporary, and a deadline does not hide AWS's last refusal", async () => {
  const hang = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })));
  });
  const silent = await verifyMachinePowerKey({ describe: hang, assertCanStop: async () => undefined },
    { deadlineMs: 50, retryMs: 5 }).catch((caught: unknown) => caught);
  assert.ok(silent instanceof Error && !(silent instanceof MachinePowerRefusal), String(silent));
  assert.match((silent as Error).message, /did not answer the automatic-stop key check in time/);
  let calls = 0;
  const refusedThenHung = await verifyMachinePowerKey({
    describe: async (signal?: AbortSignal) => { calls++; if (calls === 1) throw awsError("AuthFailure", "AWS was not able to validate the provided access credentials"); return hang(signal); },
    assertCanStop: async () => undefined
  }, { deadlineMs: 80, retryMs: 5 }).catch((caught: unknown) => caught);
  assert.ok(refusedThenHung instanceof MachinePowerRefusal, String(refusedThenHung));
  assert.match((refusedThenHung as Error).message, /AuthFailure/);
});
