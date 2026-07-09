import assert from "node:assert/strict";
import test from "node:test";
import { AwsWorkerAccess } from "./awsWorkerAccess";
import type { AwsWorkerInstanceInfo, Ec2Client } from "./awsWorkerLifecycle";

const INFO: AwsWorkerInstanceInfo = {
  instanceId: "i-shared",
  state: "running",
  publicIp: "198.51.100.10",
  availabilityZone: "us-east-1a"
};
const KEY = { keyName: "device-key", privateKeyPath: "/keys/device.pem", publicKeyOpenSsh: "ssh-ed25519 AAAA device" };

test("normal device key access does not invoke Instance Connect", async () => {
  let sends = 0;
  const service = new AwsWorkerAccess({ sshExec: async () => undefined });
  await service.ensureAccess({ sendSshPublicKey: async () => { sends += 1; } } as unknown as Ec2Client, INFO, KEY);
  assert.equal(sends, 0);
});

test("public-key failure enrolls the device key then verifies normal access", async () => {
  let calls = 0;
  let sends = 0;
  const commands: string[] = [];
  const service = new AwsWorkerAccess({
    wait: async () => undefined,
    sshExec: async (_worker, command) => {
      calls += 1;
      commands.push(command);
      if (calls === 1) throw new Error("Permission denied (publickey).");
    }
  });
  await service.ensureAccess({ sendSshPublicKey: async () => { sends += 1; } } as unknown as Ec2Client, INFO, KEY);
  assert.equal(sends, 1);
  assert.match(commands[1], /authorized_keys/);
  assert.equal(commands.at(-1), "true");
});

test("network failures are not misclassified as missing key access", async () => {
  let sends = 0;
  const service = new AwsWorkerAccess({
    sshExec: async () => { throw new Error("Connection timed out."); }
  });
  await assert.rejects(
    () => service.ensureAccess({ sendSshPublicKey: async () => { sends += 1; } } as unknown as Ec2Client, INFO, KEY),
    /timed out/
  );
  assert.equal(sends, 0);
});
