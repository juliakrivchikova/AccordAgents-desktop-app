import assert from "node:assert/strict";
import test from "node:test";
import { AwsWorkerAccess } from "./awsWorkerAccess";
import { CommandError } from "./command";
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
      if (calls === 1) throw commandError("Permission denied (publickey).");
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
    wait: async () => undefined,
    sshExec: async () => { throw new Error("Connection timed out."); }
  });
  await assert.rejects(
    () => service.ensureAccess({ sendSshPublicKey: async () => { sends += 1; } } as unknown as Ec2Client, INFO, KEY),
    /timed out/
  );
  assert.equal(sends, 0);
});

test("transient SSH transport failures are retried before normal access succeeds", async () => {
  let calls = 0;
  let waits = 0;
  let sends = 0;
  const service = new AwsWorkerAccess({
    wait: async () => { waits += 1; },
    sshExec: async () => {
      calls += 1;
      if (calls < 3) throw commandError("ssh: connect to host 198.51.100.10 port 22: Connection refused");
    }
  });
  await service.ensureAccess({ sendSshPublicKey: async () => { sends += 1; } } as unknown as Ec2Client, INFO, KEY);
  assert.equal(calls, 3);
  assert.equal(waits, 2);
  assert.equal(sends, 0);
});

function commandError(stderr: string): CommandError {
  return new CommandError("ssh exited with code 255", {
    command: "ssh",
    args: [],
    stdout: "",
    stderr,
    exitCode: 255,
    timedOut: false
  });
}
