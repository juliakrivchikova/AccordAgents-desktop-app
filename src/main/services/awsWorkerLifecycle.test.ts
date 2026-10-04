import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT } from "../../shared/cloudRuns";
import { machinePowerPolicy } from "../../shared/machinePower";
import {
  AWS_WORKER_BLOB_PREFIX,
  AWS_WORKER_TAG_KEY,
  buildBootstrapCommand,
  buildScopedWorkerPolicy,
  buildWorkerCloudInit,
  buildWorkerInstanceSpec,
  encodeWorkerBlob,
  ipToCidr,
  parseWorkerBlob
} from "./awsWorkerProvisioning";
import { AwsWorkerLifecycle } from "./awsWorkerLifecycle";
import type { AwsWorkerHandle, AwsWorkerInstanceInfo, Ec2Client } from "./awsWorkerLifecycle";

const CREDS = { accessKeyId: "AKIAEXAMPLE0001XYZ", secretAccessKey: "secretzzz", region: "us-east-1" };

test("worker blob round-trips and validates", () => {
  const blob = encodeWorkerBlob(CREDS);
  assert.ok(blob.startsWith(AWS_WORKER_BLOB_PREFIX));
  assert.deepEqual(parseWorkerBlob(blob), CREDS);
  assert.deepEqual(parseWorkerBlob(blob.slice(AWS_WORKER_BLOB_PREFIX.length)), CREDS);
});

test("the blob carries the machine's stop key; an older blob without one is still a valid connection", () => {
  const withPower = { ...CREDS, power: { accessKeyId: "AKIAPOWER0000000001", secretAccessKey: "power-secret" } };
  assert.deepEqual(parseWorkerBlob(encodeWorkerBlob(withPower)), withPower);
  assert.equal(parseWorkerBlob(encodeWorkerBlob(CREDS)).power, undefined);
  const damaged = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ ...CREDS, power: { accessKeyId: "AKIAPOWER0000000001" } })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(damaged), /damaged automatic-stop key/);
  const notAKey = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ ...CREDS, power: "yes" })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(notAKey), /damaged automatic-stop key/);
  const withWake = { ...withPower, wake: { accessKeyId: "AKIAWAKE00000000001", secretAccessKey: "wake-secret" } };
  assert.deepEqual(parseWorkerBlob(encodeWorkerBlob(withWake)), withWake, "the phone's start key travels in the same result");
  const damagedWake = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ ...CREDS, wake: { secretAccessKey: "s" } })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(damagedWake), /damaged phone start key/);
});

test("worker blob rejects malformed or incomplete input", () => {
  assert.throws(() => parseWorkerBlob("not-base64!!!"), /not valid|missing/);
  const missing = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ region: "us-east-1" })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(missing), /missing required fields/);
  const badKey = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ accessKeyId: "nope", secretAccessKey: "s", region: "us-east-1" })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(badKey), /access key/);
});

test("scoped policy limits state changes to tagged instances in-region", () => {
  const policy = buildScopedWorkerPolicy("eu-west-1") as {
    Statement: Array<{ Sid: string; Action: string[]; Resource: string | string[]; Condition: Record<string, Record<string, string | string[]>> }>;
  };
  const run = policy.Statement.find((statement) => statement.Sid === "RunTaggedWorkerResources");
  assert.ok(run);
  assert.deepEqual(run.Action, ["ec2:RunInstances"]);
  assert.equal(run.Condition.StringEquals[`aws:RequestTag/${AWS_WORKER_TAG_KEY}`], "1");
  assert.deepEqual(run.Condition["ForAllValues:StringEquals"]["aws:TagKeys"], [AWS_WORKER_TAG_KEY, "Name"]);
  const tags = policy.Statement.find((statement) => statement.Sid === "TagWorkerResourcesAtCreation");
  assert.ok(tags);
  assert.deepEqual(tags.Condition.StringEquals["ec2:CreateAction"], ["RunInstances", "CreateSecurityGroup", "ImportKeyPair"]);
  assert.ok(Array.isArray(tags.Resource));
  assert.equal(policy.Statement.some((statement) => statement.Action.includes("ec2:CreateTags") && statement.Resource === "*"), false);
  const manage = policy.Statement.find((statement) => statement.Sid === "ManageTaggedInstances");
  assert.ok(manage);
  assert.deepEqual(manage.Action.sort(), ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances"]);
  assert.equal(manage.Condition.StringEquals[`ec2:ResourceTag/${AWS_WORKER_TAG_KEY}`], "1");
  const discover = policy.Statement.find((statement) => statement.Sid === "DiscoverWorkers");
  assert.ok(discover);
  assert.ok(discover.Action.includes("ec2:DescribeRegions"));
  assert.equal(discover.Resource, "*");
});

test("bootstrap command creates a scoped user and prints a paste blob", () => {
  const command = buildBootstrapCommand("us-east-1", "abc123");
  assert.match(command, /aws iam get-user --user-name "\$USER"/);
  assert.match(command, /aws iam create-user --user-name "\$USER"/);
  assert.match(command, /aws iam create-policy --policy-name "\$USER"/);
  assert.match(command, /aws iam create-policy-version/);
  assert.match(command, /aws iam attach-user-policy/);
  assert.doesNotMatch(command, /aws iam put-user-policy --user-name "\$USER"/, "the worker's policy is too large to be inline");
  assert.match(command, /POWER_USER=accordagents-power-abc123/);
  assert.match(command, /aws iam put-user-policy --user-name "\$POWER_USER" --policy-name accordagents-machine-power/);
  assert.match(command, /aws iam list-access-keys/);
  assert.match(command, /aws iam delete-access-key/);
  assert.match(command, /aws iam create-access-key/);
  assert.match(command, /accordagents-worker-abc123/);
  assert.match(command, /ROOT_VOLUME/);
  assert.match(command, /Multiple tagged AccordAgents workers/);
  assert.match(command, new RegExp(AWS_WORKER_BLOB_PREFIX));
  const syntax = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.throws(() => buildBootstrapCommand("us-east-1", "bad;rm -rf"), /Invalid suffix/);
});

test("bootstrap command reuses IAM resources and rotates policy versions and keys at their quotas", () => {
  const directory = mkdtempSync(join(tmpdir(), "accordagents-aws-bootstrap-"));
  const awsPath = join(directory, "aws");
  const statePath = join(directory, "state.json");
  const mockAws = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.AWS_MOCK_STATE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : {
      userExists: false,
      keys: [],
      nextKey: 1,
      createUserCalls: 0,
      policyArn: null,
      policyVersions: [],
      nextPolicyVersion: 1,
      policyUpdates: 0,
      policyAttachments: 0
    };
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
const valueAfter = (name) => args[args.indexOf(name) + 1];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (command === "ec2 describe-regions") process.exit(0);
const userName = args.includes("--user-name") ? valueAfter("--user-name") : "";
if (userName.startsWith("accordagents-power-")) {
  state.power = state.power ?? { exists: false, createUserCalls: 0, keys: [], nextKey: 1, policies: [] };
  const power = state.power;
  if (command === "iam get-user") process.exit(power.exists ? 0 : 254);
  if (command === "iam create-user") { power.exists = true; power.createUserCalls += 1; save(); process.exit(0); }
  if (command === "iam put-user-policy") {
    power.policies.push({ name: valueAfter("--policy-name"), document: JSON.parse(valueAfter("--policy-document")) });
    save();
    process.exit(0);
  }
  if (command === "iam list-access-keys") { process.stdout.write(power.keys.join("\t")); process.exit(0); }
  if (command === "iam delete-access-key") { power.keys = power.keys.filter((key) => key !== valueAfter("--access-key-id")); save(); process.exit(0); }
  if (command === "iam create-access-key") {
    if (power.keys.length >= 2) { process.stderr.write("LimitExceeded"); process.exit(254); }
    const accessKeyId = "AKIAPWR" + String(power.nextKey++).padStart(13, "0");
    power.keys.push(accessKeyId);
    save();
    process.stdout.write(JSON.stringify({ AccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: "power-secret-" + accessKeyId } }));
    process.exit(0);
  }
  process.stderr.write("Unexpected mock AWS command for the stop-key user: " + args.join(" "));
  process.exit(2);
}
if (command === "iam get-user") {
  if (!state.userExists) process.exit(254);
  process.stdout.write("{}");
  process.exit(0);
}
if (command === "iam create-user") {
  if (state.userExists) {
    process.stderr.write("EntityAlreadyExists");
    process.exit(254);
  }
  state.userExists = true;
  state.createUserCalls += 1;
  save();
  process.exit(0);
}
if (command === "iam list-policies") {
  process.stdout.write(state.policyArn ?? "None");
  process.exit(0);
}
if (command === "iam create-policy") {
  if (state.policyArn) {
    process.stderr.write("EntityAlreadyExists");
    process.exit(254);
  }
  state.policyArn = "arn:aws:iam::123456789012:policy/accordagents-worker-rerun";
  state.policyVersions = [{ id: "v1", isDefault: true }];
  state.nextPolicyVersion = 2;
  state.policyUpdates += 1;
  save();
  process.stdout.write(state.policyArn);
  process.exit(0);
}
if (command === "iam list-policy-versions") {
  process.stdout.write(state.policyVersions
    .filter((version) => !version.isDefault)
    .map((version) => version.id)
    .join("\\t"));
  process.exit(0);
}
if (command === "iam delete-policy-version") {
  const versionId = valueAfter("--version-id");
  state.policyVersions = state.policyVersions.filter((version) => version.id !== versionId);
  save();
  process.exit(0);
}
if (command === "iam create-policy-version") {
  if (state.policyVersions.length >= 5) {
    process.stderr.write("LimitExceeded");
    process.exit(254);
  }
  state.policyVersions = state.policyVersions.map((version) => ({ ...version, isDefault: false }));
  state.policyVersions.push({ id: "v" + state.nextPolicyVersion++, isDefault: true });
  state.policyUpdates += 1;
  save();
  process.exit(0);
}
if (command === "iam attach-user-policy") {
  state.policyAttachments += 1;
  save();
  process.exit(0);
}
if (command === "iam delete-user-policy") {
  process.exit(254);
}
if (command === "iam put-user-policy") {
  process.stderr.write("Inline policy API must not be used");
  process.exit(2);
}
if (command === "iam list-access-keys") {
  process.stdout.write(state.keys.join("\\t"));
  process.exit(0);
}
if (command === "iam delete-access-key") {
  const keyId = valueAfter("--access-key-id");
  state.keys = state.keys.filter((candidate) => candidate !== keyId);
  save();
  process.exit(0);
}
if (command === "iam create-access-key") {
  if (state.keys.length >= 2) {
    process.stderr.write("LimitExceeded");
    process.exit(254);
  }
  const accessKeyId = "AKIA" + String(state.nextKey++).padStart(16, "0");
  state.keys.push(accessKeyId);
  save();
  process.stdout.write(JSON.stringify({
    AccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: "secret-" + accessKeyId }
  }));
  process.exit(0);
}
process.stderr.write("Unexpected mock AWS command: " + args.join(" "));
process.exit(2);
`;

  try {
    writeFileSync(awsPath, mockAws, { mode: 0o755 });
    chmodSync(awsPath, 0o755);
    let command = buildBootstrapCommand("us-east-1", "rerun");
    const run = () => spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        AWS_MOCK_STATE: statePath,
        PATH: `${directory}:${process.env.PATH ?? ""}`
      }
    });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(AWS_WORKER_BLOB_PREFIX));
    const pasted = (output: string) => parseWorkerBlob(output.trim().split("\n").pop() ?? "");
    const firstBlob = pasted(first.stdout);
    assert.deepEqual(firstBlob.power, { accessKeyId: "AKIAPWR0000000000001", secretAccessKey: "power-secret-AKIAPWR0000000000001" },
      "one run prints both keys in one result");
    const firstPower = (JSON.parse(readFileSync(statePath, "utf8")) as { power: { createUserCalls: number; keys: string[]; policies: Array<{ name: string; document: unknown }> } }).power;
    assert.equal(firstPower.createUserCalls, 1);
    assert.deepEqual(firstPower.policies, [{ name: "accordagents-machine-power", document: machinePowerPolicy("us-east-1") }]);
    const firstState = JSON.parse(readFileSync(statePath, "utf8")) as {
      userExists: boolean;
      keys: string[];
      nextKey: number;
      createUserCalls: number;
      policyArn: string;
      policyVersions: Array<{ id: string; isDefault: boolean }>;
      nextPolicyVersion: number;
      policyUpdates: number;
      policyAttachments: number;
    };
    assert.equal(firstState.userExists, true);
    assert.equal(firstState.createUserCalls, 1);
    assert.equal(firstState.policyUpdates, 1);
    assert.equal(firstState.policyAttachments, 1);
    assert.deepEqual(firstState.policyVersions, [{ id: "v1", isDefault: true }]);
    assert.equal(firstState.keys.length, 1);

    writeFileSync(statePath, JSON.stringify({
      ...firstState,
      keys: [...firstState.keys, "AKIAOLD000000000002"],
      nextKey: 3,
      policyVersions: [
        { id: "v1", isDefault: true },
        { id: "v2", isDefault: false },
        { id: "v3", isDefault: false },
        { id: "v4", isDefault: false },
        { id: "v5", isDefault: false }
      ],
      nextPolicyVersion: 6
    }));
    // The app still runs with the first key: it stays valid, the other goes.
    command = buildBootstrapCommand("us-east-1", "rerun", { keepWorkerKeyId: firstState.keys[0] });
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, new RegExp(AWS_WORKER_BLOB_PREFIX));
    const secondPower = (JSON.parse(readFileSync(statePath, "utf8")) as { power: { createUserCalls: number; keys: string[] } }).power;
    assert.equal(secondPower.createUserCalls, 1, "the stop-key user is reused");
    assert.deepEqual(secondPower.keys, ["AKIAPWR0000000000001", "AKIAPWR0000000000002"],
      "the machine's current stop key stays valid until it is handed the new one");
    assert.equal(pasted(second.stdout).power?.accessKeyId, "AKIAPWR0000000000002");
    const secondState = JSON.parse(readFileSync(statePath, "utf8")) as typeof firstState;
    assert.equal(secondState.createUserCalls, 1);
    assert.equal(secondState.policyUpdates, 2);
    assert.equal(secondState.policyAttachments, 2);
    assert.deepEqual(secondState.policyVersions, [
      { id: "v1", isDefault: false },
      { id: "v6", isDefault: true }
    ]);
    assert.deepEqual(secondState.keys, [firstState.keys[0], "AKIA0000000000000003"],
      "the key the app uses stays valid until the new one is pasted");
    command = buildBootstrapCommand("us-east-1", "rerun");
    const third = run();
    assert.equal(third.status, 0, third.stderr);
    const thirdPower = (JSON.parse(readFileSync(statePath, "utf8")) as { power: { keys: string[] } }).power;
    assert.deepEqual(thirdPower.keys, ["AKIAPWR0000000000002", "AKIAPWR0000000000003"], "at the IAM quota the oldest key goes, never the previous one");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const SHELLS = ["bash", ...(spawnSync("zsh", ["-c", "true"]).status === 0 ? ["zsh"] : [])];

for (const shell of SHELLS) {
  test(`the setup command keeps every key in use and never costs the connection (${shell})`, () => {
    const directory = mkdtempSync(join(tmpdir(), "accordagents-aws-power-"));
    const log = join(directory, "calls.log");
    const state = join(directory, "keys.json");
    // A minimal AWS with IAM's two-key limit; the stop-key side can be refused.
    writeFileSync(join(directory, "aws"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_LOG, args.join(" ") + "\\n");
const user = args.includes("--user-name") ? args[args.indexOf("--user-name") + 1] : "";
const power = user.startsWith("accordagents-power-");
const wake = user.startsWith("accordagents-wake-");
const keys = JSON.parse(fs.readFileSync(process.env.AWS_KEYS, "utf8"));
keys.wake = keys.wake || [];
const save = () => fs.writeFileSync(process.env.AWS_KEYS, JSON.stringify(keys));
const command = args.slice(0, 2).join(" ");
if ((power || wake) && process.env.AWS_REFUSE_POWER === command) { process.stderr.write("AccessDenied"); process.exit(254); }
if (command === "iam list-policies") { process.stdout.write("arn:aws:iam::1:policy/x"); process.exit(0); }
if (command === "iam list-policy-versions") process.exit(0);
if (command === "iam delete-user-policy") process.exit(254);
const side = wake ? "wake" : power ? "power" : "worker";
if (command === "iam list-access-keys") { process.stdout.write(keys[side].join("\\t")); process.exit(0); }
if (command === "iam delete-access-key") {
  const id = args[args.indexOf("--access-key-id") + 1];
  keys[side] = keys[side].filter(k => k !== id);
  save(); process.exit(0);
}
if (command === "iam create-access-key") {
  const list = keys[side];
  if (list.length >= 2) { process.stderr.write("LimitExceeded"); process.exit(254); }
  const id = ({ wake: "AKIAWAKNEW", power: "AKIAPWRNEW", worker: "AKIAWRKNEW" })[side] + String(list.length).padStart(10, "0");
  list.push(id);
  save(); process.stdout.write(JSON.stringify({ AccessKey: { AccessKeyId: id, SecretAccessKey: "s-" + id } })); process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
    const run = (refuse: string, keys: { worker: string[]; power: string[]; wake?: string[] }, options: { keepWorkerKeyId?: string; keepPowerKeyIds?: string[]; keepWakeKeyId?: string } = {}) => {
      writeFileSync(state, JSON.stringify(keys));
      writeFileSync(log, "");
      const result = spawnSync(shell, ["-c", buildBootstrapCommand("us-east-1", "dev", options)], {
        encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, AWS_LOG: log, AWS_KEYS: state, AWS_REFUSE_POWER: refuse }
      });
      const pasted = result.status === 0 ? parseWorkerBlob(result.stdout.trim().split("\n").pop() ?? "") : undefined;
      return { result, pasted, keys: JSON.parse(readFileSync(state, "utf8")) as { worker: string[]; power: string[]; wake: string[] }, calls: readFileSync(log, "utf8").trim().split("\n") };
    };
    try {
      const refused = run("iam put-user-policy", { worker: ["AKIAWORKEROLD0000001"], power: [] }, { keepWorkerKeyId: "AKIAWORKEROLD0000001" });
      assert.equal(refused.result.status, 0, refused.result.stderr);
      assert.equal(refused.pasted?.power, undefined, "the connection result is still printed");
      assert.match(refused.result.stderr, /No new automatic-stop key was made/);
      assert.deepEqual(refused.keys.worker, ["AKIAWORKEROLD0000001", "AKIAWRKNEW0000000001"],
        "the app's current key stays valid until the printed one is pasted");
      assert.ok(!refused.calls.some((call) => call.startsWith("iam delete-access-key")), "nothing in use is deleted");
      assert.ok(refused.calls.some((call) => call.includes("--query Versions[?IsDefaultVersion==`false`].VersionId")),
        "the old policy versions are listed, so a rerun never hits IAM's five-version limit");

      const kept = run("", { worker: [], power: ["AKIAPWRHELD000000001", "AKIAPWRNEVERTAKEN001"] }, { keepPowerKeyIds: ["AKIAPWRHELD000000001"] });
      assert.equal(kept.result.status, 0, kept.result.stderr);
      assert.deepEqual(kept.keys.power, ["AKIAPWRHELD000000001", "AKIAPWRNEW0000000001"], "the key the machine runs with survives the rotation");
      assert.equal(kept.pasted?.power?.accessKeyId, "AKIAPWRNEW0000000001");

      const oldest = run("", { worker: [], power: ["AKIAPWROLDEST0000001", "AKIAPWRNEWER00000001"] });
      assert.deepEqual(oldest.keys.power, ["AKIAPWRNEWER00000001", "AKIAPWRNEW0000000001"], "with nothing to keep the oldest goes");

      const busy = run("", { worker: [], power: ["AKIAPWRHELD000000001", "AKIAPWRPENDING000001"] },
        { keepPowerKeyIds: ["AKIAPWRHELD000000001", "AKIAPWRPENDING000001"] });
      assert.equal(busy.result.status, 0, busy.result.stderr);
      assert.equal(busy.pasted?.power, undefined);
      assert.match(busy.result.stderr, /Both automatic-stop keys are still in use/);
      assert.deepEqual(busy.keys.power, ["AKIAPWRHELD000000001", "AKIAPWRPENDING000001"], "neither key in use is deleted");

      // The phone's start key is made once and then left alone.
      const firstWake = run("", { worker: [], power: [], wake: [] });
      assert.equal(firstWake.pasted?.wake?.accessKeyId, "AKIAWAKNEW0000000000");
      assert.deepEqual(firstWake.keys.wake, ["AKIAWAKNEW0000000000"]);
      const keptWake = run("", { worker: [], power: [], wake: ["AKIAWAKEHELD00000001"] }, { keepWakeKeyId: "AKIAWAKEHELD00000001" });
      assert.equal(keptWake.result.status, 0, keptWake.result.stderr);
      assert.equal(keptWake.pasted?.wake, undefined, "a rerun makes no new start key while the app's still exists");
      assert.deepEqual(keptWake.keys.wake, ["AKIAWAKEHELD00000001"], "and never deletes the one phones hold");
      assert.ok(!keptWake.calls.some((call) => call.startsWith("iam put-user-policy --user-name accordagents-wake-")),
        "nor rewrites its policy");
      assert.doesNotMatch(keptWake.result.stderr, /phone start key could not be made/);
      const lostWake = run("", { worker: [], power: [], wake: ["AKIAWAKEOLD000000001", "AKIAWAKEOLD000000002"] });
      assert.equal(lostWake.pasted?.wake?.accessKeyId, "AKIAWAKNEW0000000001", "an app without its start key gets a new one");
      const refusedWake = run("iam put-user-policy", { worker: [], power: [], wake: [] });
      assert.equal(refusedWake.result.status, 0, refusedWake.result.stderr);
      assert.match(refusedWake.result.stderr, /phone start key could not be made/);

      const stale = run("", { worker: ["AKIAWORKERLIVE000001", "AKIAWORKERSTALE00001"], power: [] }, { keepWorkerKeyId: "AKIAWORKERLIVE000001" });
      assert.equal(stale.result.status, 0, stale.result.stderr);
      assert.deepEqual(stale.keys.worker, ["AKIAWORKERLIVE000001", "AKIAWRKNEW0000000001"], "at the quota the superseded app key goes, never the live one");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("the setup command only ever names well-formed keys and still connects where the stop key cannot be scoped", () => {
  const command = buildBootstrapCommand("us-east-1", "dev", {
    keepWorkerKeyId: "AKIA0000000000000001;touch /tmp/x",
    keepPowerKeyIds: ["$(id)", "AKIAPWRHELD000000001\nrm", "akiapwrlower00000001"]
  });
  assert.match(command, /^KEEP_WORKER_KEY=$/m);
  assert.match(command, /^KEEP_POWER_KEYS=''$/m);
  assert.doesNotMatch(command, /touch \/tmp\/x|\$\(id\)|\nrm\n/);
  const appOnly = buildBootstrapCommand("eu-west-1", "dev", { machineKeys: false });
  assert.doesNotMatch(appOnly, /POWER_USER=|WAKE_USER=/, "a command for another instance's region leaves its keys alone");
  assert.equal(spawnSync("bash", ["-n"], { input: appOnly, encoding: "utf8" }).status, 0);
  const unscoped = buildBootstrapCommand("eusc-de-east-1", "dev");
  assert.doesNotMatch(unscoped, /POWER_USER=/, "a region the stop-key policy cannot name gets no stop key");
  assert.match(unscoped, /Paste this into AccordAgents/);
  assert.equal(spawnSync("bash", ["-n"], { input: unscoped, encoding: "utf8" }).status, 0);
});

test("cloud-init and instance spec carry the toolchain and tag", () => {
  const init = buildWorkerCloudInit();
  assert.match(init, /@openai\/codex/);
  assert.match(init, /apparmor_restrict_unprivileged_userns=0/);
  assert.doesNotMatch(init, /accordagents-mtu\.service/);
  assert.doesNotMatch(init, /ip link set dev "\$IF" mtu 1200/);
  const spec = buildWorkerInstanceSpec({ imageId: "ami-1", rootDeviceName: "/dev/sda1", keyName: "k", securityGroupId: "sg-1" });
  assert.equal(spec.instanceType, "t3.small");
  assert.equal(spec.rootVolumeSizeGb, AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT);
  assert.equal(
    buildWorkerInstanceSpec({
      imageId: "ami-1",
      rootDeviceName: "/dev/sda1",
      keyName: "k",
      securityGroupId: "sg-1",
      rootVolumeSizeGb: 64
    }).rootVolumeSizeGb,
    64
  );
  assert.equal(spec.tagKey, AWS_WORKER_TAG_KEY);
  assert.equal(Buffer.from(spec.userData, "base64").toString("utf8"), init);
});

test("ipToCidr validates and appends /32", () => {
  assert.equal(ipToCidr("203.0.113.4"), "203.0.113.4/32");
  assert.throws(() => ipToCidr("999.1.1.1"), /valid IPv4/);
  assert.throws(() => ipToCidr("not-an-ip"), /valid IPv4/);
});

class FakeEc2Client implements Ec2Client {
  state: AwsWorkerInstanceInfo;
  readonly ingressCidrs = new Set<string>();
  readonly keyPairs = new Set<string>();
  readonly importedKeyPairs: string[] = [];
  readonly deletedKeyPairs: string[] = [];
  readonly securityGroupNames: string[] = [];
  readonly deletedSecurityGroups: string[] = [];
  readonly revokedSecurityGroups: string[] = [];
  readonly authorizedSecurityGroups: string[] = [];
  lastRunSpec: Parameters<Ec2Client["runInstance"]>[0] | undefined;
  terminateError: Error | undefined;
  revokedCount = 0;
  startCount = 0;
  stopCount = 0;

  constructor(initial?: Partial<AwsWorkerInstanceInfo>) {
    this.state = { instanceId: "i-123", state: "running", publicIp: "1.1.1.1", ...initial };
  }

  async resolveUbuntuImage(): Promise<{ imageId: string; rootDeviceName: string }> {
    return { imageId: "ami-ubuntu", rootDeviceName: "/dev/sda1" };
  }
  async keyPairExists(name: string): Promise<boolean> {
    return this.keyPairs.has(name);
  }
  async importKeyPair(name: string): Promise<void> {
    this.importedKeyPairs.push(name);
    this.keyPairs.add(name);
  }
  async deleteKeyPair(name: string): Promise<void> {
    this.deletedKeyPairs.push(name);
    this.keyPairs.delete(name);
  }
  async ensureSecurityGroup(name: string): Promise<string> {
    this.securityGroupNames.push(name);
    return "sg-123";
  }
  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    this.deletedSecurityGroups.push(securityGroupId);
  }
  async authorizeSshIngress(sg: string, cidr: string): Promise<void> {
    this.authorizedSecurityGroups.push(sg);
    this.ingressCidrs.add(cidr);
  }
  async revokeAllSshIngress(securityGroupId: string): Promise<void> {
    this.revokedSecurityGroups.push(securityGroupId);
    this.revokedCount += 1;
    this.ingressCidrs.clear();
  }
  async runInstance(spec: Parameters<Ec2Client["runInstance"]>[0]): Promise<string> {
    this.lastRunSpec = spec;
    return "i-123";
  }
  async describeInstance(): Promise<AwsWorkerInstanceInfo | undefined> {
    return this.state;
  }
  async startInstance(): Promise<void> {
    this.startCount += 1;
    this.state = { ...this.state, state: "running", publicIp: "2.2.2.2" };
  }
  async stopInstance(): Promise<void> {
    this.stopCount += 1;
    this.state = { ...this.state, state: "stopped", publicIp: undefined };
  }
  async terminateInstance(): Promise<void> {
    if (this.terminateError) {
      throw this.terminateError;
    }
    this.state = { ...this.state, state: "terminated", publicIp: undefined };
  }
}

function lifecycleWith(client: FakeEc2Client, overrides = {}): AwsWorkerLifecycle {
  return new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "aa-key", publicKeyOpenSsh: "ssh-ed25519 AAAA", privateKeyPath: "/tmp/aa-key" }),
    currentPublicIp: async () => "203.0.113.9",
    waitForState: async (poll, predicate) => {
      const info = await poll();
      if (!predicate(info)) {
        throw new Error("predicate not satisfied in test");
      }
      return info;
    },
    ...overrides
  });
}

const HANDLE: AwsWorkerHandle = {
  instanceId: "i-123",
  securityGroupId: "sg-123",
  keyName: "aa-key",
  privateKeyPath: "/tmp/aa-key",
  region: "us-east-1"
};

test("createWorker provisions key, security group, ingress and instance", async () => {
  const client = new FakeEc2Client();
  const handle = await lifecycleWith(client).createWorker(CREDS, { rootVolumeSizeGb: 64 });
  assert.equal(handle.instanceId, "i-123");
  assert.equal(handle.securityGroupId, "sg-123");
  assert.deepEqual(client.importedKeyPairs, ["aa-key"]);
  assert.deepEqual(client.securityGroupNames, ["aa-key-sg"]);
  assert.equal(client.lastRunSpec?.keyName, "aa-key");
  assert.ok(client.ingressCidrs.has("203.0.113.9/32"));
  assert.equal(client.lastRunSpec?.rootDeviceName, "/dev/sda1");
  assert.equal(client.lastRunSpec?.rootVolumeSizeGb, 64);
});

test("createWorker reuses an existing local/AWS key without re-importing it", async () => {
  const client = new FakeEc2Client();
  client.keyPairs.add("aa-key");
  await lifecycleWith(client, {
    generateKeyMaterial: async () => ({ keyName: "aa-key", publicKeyOpenSsh: "ssh-ed25519 AAAA", privateKeyPath: "/tmp/aa-key", reused: true })
  }).createWorker(CREDS);
  assert.deepEqual(client.importedKeyPairs, []);
});

test("createWorker rotates fresh key material when AWS reports a duplicate key pair", async () => {
  const client = new FakeEc2Client();
  const deletedLocalKeys: string[] = [];
  const keys = [
    { keyName: "accordagents-worker-dup", publicKeyOpenSsh: "ssh-ed25519 AAAA", privateKeyPath: "/tmp/dup", reused: false },
    { keyName: "accordagents-worker-new", publicKeyOpenSsh: "ssh-ed25519 BBBB", privateKeyPath: "/tmp/new", reused: false }
  ];
  client.importKeyPair = async (name: string): Promise<void> => {
    client.importedKeyPairs.push(name);
    if (name === "accordagents-worker-dup") {
      const error = new Error("duplicate") as Error & { name: string };
      error.name = "InvalidKeyPair.Duplicate";
      throw error;
    }
    client.keyPairs.add(name);
  };
  const handle = await lifecycleWith(client, {
    generateKeyMaterial: async (options?: { rotate?: boolean }) => keys[options?.rotate ? 1 : 0],
    deleteKeyMaterial: async (keyName: string) => {
      deletedLocalKeys.push(keyName);
    }
  }).createWorker(CREDS);
  assert.equal(handle.keyName, "accordagents-worker-new");
  assert.deepEqual(client.importedKeyPairs, ["accordagents-worker-dup", "accordagents-worker-new"]);
  assert.deepEqual(deletedLocalKeys, ["accordagents-worker-dup"]);
});

test("ensureRunning starts a stopped instance and rebuilds ingress to the current IP", async () => {
  const client = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  const info = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(client.startCount, 1);
  assert.equal(info.publicIp, "2.2.2.2");
  assert.equal(client.revokedCount, 0);
  assert.deepEqual(client.revokedSecurityGroups, []);
  assert.deepEqual([...client.ingressCidrs], ["203.0.113.9/32"]);
});

test("without starting, a stopped instance is left stopped and a running one still gets this device's SSH access", async () => {
  const stopped = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  await assert.rejects(lifecycleWith(stopped).ensureRunning(CREDS, HANDLE, "device", { start: false }), /is stopped, so nothing was started/);
  assert.equal(stopped.startCount, 0);
  const stopping = new FakeEc2Client({ state: "stopping", publicIp: undefined });
  await assert.rejects(lifecycleWith(stopping).ensureRunning(CREDS, HANDLE, "device", { start: false }), /is stopping/);
  assert.equal(stopping.startCount, 0, "a stop under way is not undone");
  const running = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const info = await lifecycleWith(running).ensureRunning(CREDS, HANDLE, "device", { start: false });
  assert.equal(info.publicIp, "1.1.1.1");
  assert.deepEqual([...running.ingressCidrs], ["203.0.113.9/32"], "a laptop on a new network can still reach the machine");
});

test("ensureRunning permits an EC2 root-volume state that is not known yet", async () => {
  const client = new FakeEc2Client({
    state: "running",
    publicIp: "1.1.1.1",
    rootVolumeBackedByEbs: undefined
  });
  const ip = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(ip.publicIp, "1.1.1.1");
  assert.equal(client.revokedCount, 0);
});

test("ensureRunning rejects an explicitly instance-store-backed root volume", async () => {
  const client = new FakeEc2Client({
    state: "running",
    publicIp: "1.1.1.1",
    rootVolumeBackedByEbs: false
  });
  await assert.rejects(
    () => lifecycleWith(client).ensureRunning(CREDS, HANDLE),
    /not backed by persistent EBS storage/
  );
  assert.equal(client.revokedCount, 0);
});

test("ensureRunning on a running instance does not start again but still refreshes ingress", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "5.5.5.5" });
  const info = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(client.startCount, 0);
  assert.equal(info.publicIp, "5.5.5.5");
  assert.equal(client.revokedCount, 0);
});

test("ensureRunning refuses a terminated instance", async () => {
  const client = new FakeEc2Client({ state: "terminated", publicIp: undefined });
  await assert.rejects(() => lifecycleWith(client).ensureRunning(CREDS, HANDLE), /no longer exists/);
});

test("shared workers stop only after the last local ref ends and the worker gate authorizes", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 15,
    authorizeAutomaticStop: async () => ({
      renew: async () => undefined,
      release: async () => undefined
    }),
    now: () => 0
  });
  // Two overlapping runs: the first ending must NOT stop the instance.
  lifecycle.runStarted();
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.stopCount, 0);
  // A new run cancels any pending idle timer.
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  // Last run ends → idle timer stops it.
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.stopCount, 1);
});

test("automatic stop fails closed while worker work is registered, then retries once idle", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let attempts = 0;
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 10,
    idleStopRetryMs: 10,
    authorizeAutomaticStop: async () => {
      attempts += 1;
      return attempts === 1
        ? undefined
        : { renew: async () => undefined, release: async () => undefined };
    }
  });

  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(client.stopCount, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.stopCount, 1);
  assert.equal(attempts, 2);
});

test("with automatic stop switched off this desktop neither stops the instance nor keeps asking", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let enabled = false; let asked = 0; let authorized = 0;
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 10,
    idleStopRetryMs: 10,
    automaticStopEnabled: async () => { asked++; return enabled; },
    authorizeAutomaticStop: async () => { authorized++; return { renew: async () => undefined, release: async () => undefined }; }
  });
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.stopCount, 0);
  assert.equal(asked, 1, "a switch left off is not polled every minute");
  assert.equal(authorized, 0);
  enabled = true;
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.stopCount, 1, "the next run that ends arms it again");
});

test("automatic stop releases its worker lease when a local run starts during authorization", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let authorizationRequested = false;
  let authorize!: (value: { renew(): Promise<void>; release(): Promise<void> }) => void;
  const authorization = new Promise<{ renew(): Promise<void>; release(): Promise<void> }>((resolve) => {
    authorize = resolve;
  });
  let releases = 0;
  const lifecycle = lifecycleWith(client, {
    idleStopMs: 5,
    authorizeAutomaticStop: async () => {
      authorizationRequested = true;
      return authorization;
    }
  });

  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  for (let attempt = 0; attempt < 20 && !authorizationRequested; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(authorizationRequested, true);
  lifecycle.runStarted();
  authorize({
    renew: async () => undefined,
    release: async () => { releases += 1; }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(client.stopCount, 0);
  assert.equal(releases, 1);
});

test("automatic stop retains its drain lease until AWS reports the instance stopped", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let finishStopping!: () => void;
  const stopping = new Promise<void>((resolve) => { finishStopping = resolve; });
  client.stopInstance = async () => {
    client.stopCount += 1;
    client.state = { ...client.state, state: "stopping" };
  };
  let releases = 0;
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 5,
    authorizeAutomaticStop: async () => ({
      renew: async () => undefined,
      release: async () => { releases += 1; }
    }),
    waitForState: async (poll, predicate) => {
      let info = await poll();
      if (!predicate(info)) {
        await stopping;
        client.state = { ...client.state, state: "stopped", publicIp: undefined };
        info = await poll();
      }
      assert.equal(predicate(info), true);
      return info;
    }
  });

  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  for (let attempt = 0; attempt < 50 && client.stopCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(client.stopCount, 1);
  assert.equal(client.state.state, "stopping");
  assert.equal(releases, 0);
  finishStopping();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(client.state.state, "stopped");
  assert.equal(releases, 0, "successful automatic stop keeps the durable drain marker for next-boot clearing");
});

test("deleteWorker terminates the instance and cleans up key material and security group", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const deletedLocalKeys: string[] = [];
  await lifecycleWith(client, {
    deleteKeyMaterial: async (keyName: string) => {
      deletedLocalKeys.push(keyName);
    }
  }).deleteWorker(CREDS, HANDLE);
  assert.equal(client.state.state, "terminated");
  assert.deepEqual(client.deletedKeyPairs, ["aa-key"]);
  assert.deepEqual(deletedLocalKeys, ["aa-key"]);
  assert.deepEqual(client.deletedSecurityGroups, ["sg-123"]);
});

test("deleteWorker retains every access resource when termination fails", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  client.terminateError = new Error("AccessDenied");
  const result = await lifecycleWith(client).deleteWorker(CREDS, HANDLE);
  assert.equal(result.terminateFailed, "AccessDenied");
  assert.equal(client.state.state, "running");
  assert.equal(result.terminationConfirmed, false);
  assert.deepEqual(client.deletedKeyPairs, []);
  assert.deepEqual(client.deletedSecurityGroups, []);
});

test("deleteWorker treats an unverified termination wait as fatal and skips cleanup", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const result = await lifecycleWith(client, {
    waitForState: async () => { throw new Error("wait timed out"); }
  }).deleteWorker(CREDS, HANDLE);
  assert.equal(result.terminationConfirmed, false);
  assert.equal(result.terminateFailed, "wait timed out");
  assert.deepEqual(client.deletedKeyPairs, []);
  assert.deepEqual(client.deletedSecurityGroups, []);
});

test("deleteWorker waits up to three minutes before first security group cleanup", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let observedTimeout = 0;
  await lifecycleWith(client, {
    waitForState: async (_poll: () => Promise<AwsWorkerInstanceInfo | undefined>, _predicate: (info: AwsWorkerInstanceInfo | undefined) => boolean, timeoutMs: number) => {
      observedTimeout = timeoutMs;
      return { instanceId: "i-123", state: "terminated" };
    }
  }).deleteWorker(CREDS, HANDLE);
  assert.equal(observedTimeout, 3 * 60_000);
});

test("stopWorker stops a running instance without terminating it", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  await lifecycleWith(client).stopWorker(CREDS, HANDLE);
  assert.equal(client.stopCount, 1);
  assert.equal(client.state.state, "stopped");
});

test("stopWorker is a no-op for an already stopped instance", async () => {
  const client = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  await lifecycleWith(client).stopWorker(CREDS, HANDLE);
  assert.equal(client.stopCount, 0);
  assert.equal(client.state.state, "stopped");
});
