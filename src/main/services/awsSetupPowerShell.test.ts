import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHubServerBlob } from "../../shared/hubSetup";
import { machinePowerPolicy } from "../../shared/machinePower";
import { buildBootstrapCommand, buildScopedWorkerPolicy, parseWorkerBlob } from "./awsWorkerProvisioning";
import { buildHubSetupCommand } from "./hubProvisioning";

const skip = process.platform !== "win32" && "Windows PowerShell runs only on Windows";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILJIJwb67mBYg22EJHJ2JtfmDHgQ8J+tkl+GD0TPyfjz";
const KEY = `ssh-ed25519 ${"A".repeat(68)} accordagents-hub`;
const NONCE = "nonce-for-this-command-1";

// The AWS CLI on Windows is an .exe, and PowerShell passes arguments to an
// .exe differently from a .cmd, so the stand-in is one: node under the name
// aws.exe, answering from a module preloaded through NODE_OPTIONS.
const MOCK_AWS = String.raw`
const fs = require("node:fs");
const path = require("node:path");
if (path.basename(process.execPath).toLowerCase() === "aws.exe") {
  const dir = process.env.AWS_MOCK_DIR;
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  fs.appendFileSync(path.join(dir, "aws.log"), args.join(" ") + "\n");
  const out = (text) => fs.writeSync(1, text);
  const exit = (code, error) => { if (error) fs.writeSync(2, error); process.exit(code); };
  const after = (name) => args[args.indexOf(name) + 1];
  const document = (name) => { const value = after(name); return JSON.parse(value.startsWith("file://") ? fs.readFileSync(value.slice(7), "utf8") : value); };
  const has = (name) => fs.existsSync(path.join(dir, name));
  const touch = (name) => fs.writeFileSync(path.join(dir, name), "");
  const remove = (name) => fs.rmSync(path.join(dir, name), { force: true });
  const statePath = path.join(dir, "iam.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  for (const key of ["worker", "power", "wake", "users"]) state[key] ??= [];
  state.inline ??= {};
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
  const command = args.slice(0, 2).join(" ");
  const user = args.includes("--user-name") ? after("--user-name") : "";
  const side = user.startsWith("accordagents-wake-") ? "wake" : user.startsWith("accordagents-power-") ? "power" : "worker";
  if (args[0] === "ec2") {
    const ec2Path = path.join(dir, "ec2.json");
    if (!fs.existsSync(ec2Path)) exit(0);
    const ec2 = JSON.parse(fs.readFileSync(ec2Path, "utf8"));
    const query = args.includes("--query") ? after("--query") : "";
    if (command === "ec2 describe-regions") out(Object.keys(ec2.instances).join("\t"));
    else if (command === "ec2 describe-instances" && args.includes("--filters")) out((ec2.instances[after("--region")] ?? []).join("\t"));
    else if (command === "ec2 describe-instances" && query.includes("RootDeviceName")) out("/dev/sda1");
    else if (command === "ec2 describe-instances" && query.includes("DeviceName=='/dev/sda1'")) out("vol-1");
    else if (command === "ec2 describe-instances" && query.includes("SecurityGroups")) out(Object.keys(ec2.groups).join("\t"));
    else if (command === "ec2 describe-security-groups") out(ec2.groups[after("--group-ids")]);
    exit(0);
  }
  if (args[0] === "iam") {
    if (side !== "worker" && process.env.AWS_REFUSE === command) exit(254, "AccessDenied");
    if (command === "iam get-user") exit(state.users.includes(user) ? 0 : 254, "NoSuchEntity");
    if (command === "iam create-user") { state.users.push(user); save(); exit(0); }
    if (command === "iam list-policies") { out(state.policyArn ?? "None"); exit(0); }
    if (command === "iam create-policy") { state.policy = document("--policy-document"); state.policyArn = "arn:aws:iam::1:policy/x"; save(); out(state.policyArn); exit(0); }
    if (command === "iam list-policy-versions") exit(0);
    if (command === "iam create-policy-version") { state.policy = document("--policy-document"); save(); exit(0); }
    if (command === "iam attach-user-policy" || command === "iam delete-user-policy") exit(command === "iam attach-user-policy" ? 0 : 254);
    if (command === "iam put-user-policy") { state.inline[user] = { name: after("--policy-name"), document: document("--policy-document") }; save(); exit(0); }
    if (command === "iam list-access-keys") { out(state[side].join("\t")); exit(0); }
    if (command === "iam delete-access-key") { state[side] = state[side].filter((key) => key !== after("--access-key-id")); save(); exit(0); }
    if (command === "iam create-access-key") {
      if (state[side].length >= 2) exit(254, "LimitExceeded");
      const id = ({ wake: "AKIAWAKNEW", power: "AKIAPWRNEW", worker: "AKIAWRKNEW" })[side] + String(state[side].length).padStart(10, "0");
      state[side].push(id); save();
      out(JSON.stringify({ AccessKey: { AccessKeyId: id, SecretAccessKey: "s/+" + id } }));
      exit(0);
    }
  }
  const line = args.join(" ");
  if (line.includes("get-regions")) { out("us-east-1a"); exit(0); }
  if (line.includes("create-instances")) { state.userData = fs.readFileSync(after("--user-data").slice(7), "utf8"); save(); touch("instance"); exit(0); }
  if (line.includes("get-instance-access-details")) {
    const n = (state.access ?? 0) + 1; state.access = n; save();
    const hostKeys = has("nokeys") ? [] : [{ algorithm: "ssh-ed25519", publicKey: process.env.HOST_PUBLIC_KEY }];
    out(JSON.stringify({ privateKey: "-----BEGIN KEY-----\nPAIR-" + n + "\n-----END KEY-----\n", certKey: "ssh-ed25519-cert-v01@openssh.com PAIR-" + n, hostKeys }));
    exit(0);
  }
  if (line.includes("start-instance")) { remove("stopped"); exit(0); }
  if (line.includes("get-instance") && line.includes("state.name")) {
    if (!has("instance")) exit(254);
    if (has("stopping")) { remove("stopping"); touch("stopped"); out("stopping"); } else out(has("stopped") ? "stopped" : "running");
    exit(0);
  }
  if (line.includes("get-instance")) exit(has("instance") ? 0 : 254);
  if (line.includes("allocate-static-ip")) { touch("ip"); exit(0); }
  if (line.includes("attach-static-ip")) { touch("attached"); exit(0); }
  if (line.includes("get-static-ip") && line.includes("attachedTo")) { out(has("attached") ? "accordagents-hub" : "None"); exit(0); }
  if (line.includes("get-static-ip") && line.includes("ipAddress")) { out("3.14.15.92"); exit(0); }
  if (line.includes("get-static-ip")) exit(has("ip") ? 0 : 254);
  if (line.includes("put-instance-public-ports")) { if (!args.includes("fromPort=443,toPort=443,protocol=tcp")) exit(2, "ports were split"); exit(0); }
  exit(2, "unexpected aws " + line);
}
`;

// Checks, as the real one does, that the key and certificate come from one
// AWS answer and that the server's own key is listed under its address.
const MOCK_SSH = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.AWS_MOCK_DIR, "ssh.log"), JSON.stringify({ cwd: process.cwd(), args }) + "\n");
const option = (name) => (args.find((arg, index) => args[index - 1] === "-o" && arg.startsWith(name + "=")) ?? "").slice(name.length + 1);
const pair = (file) => (fs.readFileSync(file, "utf8").match(/PAIR-\d+/) ?? [""])[0];
const destination = args.find((arg) => arg.includes("@")).split("@")[1];
if (!args.includes("-n")) { console.error("stdin was not closed"); process.exit(255); }
if (option("StrictHostKeyChecking") !== "yes" || !fs.readFileSync(option("UserKnownHostsFile"), "utf8").split("\n").includes(destination + " " + process.env.HOST_KEY)) { console.error("Host key verification failed."); process.exit(255); }
if (!pair(args[args.indexOf("-i") + 1]) || pair(args[args.indexOf("-i") + 1]) !== pair(option("CertificateFile"))) { console.error("Permission denied (publickey)."); process.exit(255); }
`;

function fakeAws(): { dir: string; run: (command: string, env?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>; log: (name: string) => string[]; iam: () => Record<string, any> } {
  const dir = mkdtempSync(path.join(tmpdir(), "accordagents-ps-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  try { linkSync(process.execPath, path.join(bin, "aws.exe")); } catch { copyFileSync(process.execPath, path.join(bin, "aws.exe")); }
  writeFileSync(path.join(dir, "aws-mock.cjs"), MOCK_AWS);
  writeFileSync(path.join(dir, "ssh-mock.cjs"), MOCK_SSH);
  writeFileSync(path.join(bin, "ssh.cmd"), `@"${process.execPath}" "${path.join(dir, "ssh-mock.cjs")}" %*\r\n`);
  writeFileSync(path.join(dir, "aws.log"), "");
  writeFileSync(path.join(dir, "ssh.log"), "");
  return {
    dir,
    run: (command, env = {}) => {
      // Waiting for AWS is not waited out here.
      writeFileSync(path.join(dir, "run.ps1"), `function Start-Sleep { param($Seconds) }\n${command}\n`);
      return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "run.ps1")], {
        encoding: "utf8",
        env: {
          ...process.env, PATH: `${bin};${process.env.PATH ?? ""}`, NODE_OPTIONS: `--require ${path.join(dir, "aws-mock.cjs")}`,
          AWS_MOCK_DIR: dir, HOST_KEY, HOST_PUBLIC_KEY: HOST_KEY.split(" ")[1], ...env
        }
      });
    },
    log: (name) => readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean),
    iam: () => JSON.parse(readFileSync(path.join(dir, "iam.json"), "utf8"))
  };
}

test("on Windows the AWS setup command runs in PowerShell and prints the same result", { skip }, () => {
  const aws = fakeAws();
  try {
    const command = buildBootstrapCommand("us-east-1", "dev", {}, "win32");
    const first = aws.run(command);
    assert.equal(first.status, 0, first.stderr);
    const pasted = parseWorkerBlob(first.stdout);
    assert.equal(pasted.accessKeyId, "AKIAWRKNEW0000000000");
    assert.equal(pasted.secretAccessKey, "s/+AKIAWRKNEW0000000000");
    assert.equal(pasted.power?.accessKeyId, "AKIAPWRNEW0000000000");
    assert.equal(pasted.wake?.accessKeyId, "AKIAWAKNEW0000000000");
    assert.deepEqual(aws.iam().policy, buildScopedWorkerPolicy("us-east-1"), "the policy reaches AWS intact");
    assert.deepEqual(aws.iam().inline["accordagents-power-dev"], { name: "accordagents-machine-power", document: machinePowerPolicy("us-east-1") });
    assert.ok(!aws.log("aws.log").some((call) => call.startsWith("iam list-policy-versions")), "a new policy has no old versions to list");

    const again = aws.run(buildBootstrapCommand("us-east-1", "dev", { keepWorkerKeyId: pasted.accessKeyId, keepPowerKeyIds: [pasted.power!.accessKeyId], keepWakeKeyId: pasted.wake!.accessKeyId }, "win32"));
    assert.equal(again.status, 0, again.stderr);
    const second = parseWorkerBlob(again.stdout);
    assert.equal(second.wake, undefined, "the phones' start key is made once");
    assert.deepEqual(aws.iam().worker, ["AKIAWRKNEW0000000000", "AKIAWRKNEW0000000001"], "the key the app uses stays valid");
    assert.ok(aws.log("aws.log").some((call) => call.includes("--query Versions[?IsDefaultVersion==`false`].VersionId")),
      "the old policy versions are listed, so a rerun never hits IAM's five-version limit");

    const busy = aws.run(buildBootstrapCommand("us-east-1", "dev", { keepPowerKeyIds: aws.iam().power }, "win32"));
    assert.equal(busy.status, 0, busy.stderr);
    assert.equal(parseWorkerBlob(busy.stdout).power, undefined);
    assert.match(busy.stderr, /Both automatic-stop keys are still in use/);

    const refused = aws.run(buildBootstrapCommand("us-east-1", "other", {}, "win32"), { AWS_REFUSE: "iam put-user-policy" });
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(parseWorkerBlob(refused.stdout).power, undefined, "the connection result is still printed");
    assert.match(refused.stderr, /No new automatic-stop key was made/);
    assert.match(refused.stderr, /phone start key could not be made/);
  } finally {
    rmSync(aws.dir, { recursive: true, force: true });
  }
});

test("on Windows a worker already in the account gets its disk and own group tagged, and two of them stop the command", { skip }, () => {
  const aws = fakeAws();
  try {
    const groups = { "sg-1": "accordagents-worker-dev-sg", "sg-2": "default" };
    writeFileSync(path.join(aws.dir, "ec2.json"), JSON.stringify({ instances: { "us-east-1": ["i-1"], "eu-west-1": [] }, groups }));
    const one = aws.run(buildBootstrapCommand("us-east-1", "dev", {}, "win32"));
    assert.equal(one.status, 0, one.stderr);
    const tags = aws.log("aws.log").filter((call) => call.startsWith("ec2 create-tags"));
    assert.deepEqual(tags, [
      "ec2 create-tags --region us-east-1 --resources vol-1 --tags Key=accordagents-worker,Value=1",
      "ec2 create-tags --region us-east-1 --resources sg-1 --tags Key=accordagents-worker,Value=1"
    ]);
    writeFileSync(path.join(aws.dir, "ec2.json"), JSON.stringify({ instances: { "us-east-1": ["i-1"], "eu-west-1": ["i-2"] }, groups }));
    const two = aws.run(buildBootstrapCommand("us-east-1", "dev", {}, "win32"));
    assert.notEqual(two.status, 0);
    assert.match(two.stderr, /Multiple tagged AccordAgents workers exist/);
    assert.ok(!two.stdout.includes("accord-aws-v1:"));
  } finally {
    rmSync(aws.dir, { recursive: true, force: true });
  }
});

test("on Windows, at IAM's two-key limit, the keys in use stay and only the others go", { skip }, () => {
  const aws = fakeAws();
  try {
    writeFileSync(path.join(aws.dir, "iam.json"), JSON.stringify({
      worker: ["AKIAWORKERLIVE000001", "AKIAWORKERSTALE00001"],
      power: ["AKIAPWRHELD000000001", "AKIAPWROTHER00000001"],
      wake: ["AKIAWAKEOLD000000001", "AKIAWAKEOLD000000002"]
    }));
    const run = aws.run(buildBootstrapCommand("us-east-1", "dev", { keepWorkerKeyId: "AKIAWORKERLIVE000001", keepPowerKeyIds: ["AKIAPWRHELD000000001"] }, "win32"));
    assert.equal(run.status, 0, run.stderr);
    const iam = aws.iam();
    assert.deepEqual(iam.worker, ["AKIAWORKERLIVE000001", "AKIAWRKNEW0000000001"], "the key the app uses stays valid until the new one is pasted");
    assert.deepEqual(iam.power, ["AKIAPWRHELD000000001", "AKIAPWRNEW0000000001"], "the key the machine runs with survives the rotation");
    assert.deepEqual(iam.wake, ["AKIAWAKEOLD000000002", "AKIAWAKNEW0000000001"], "an app without its start key gets a new one");
    assert.equal(parseWorkerBlob(run.stdout).wake?.accessKeyId, "AKIAWAKNEW0000000001");
  } finally {
    rmSync(aws.dir, { recursive: true, force: true });
  }
});

test("on Windows the permission update changes only the policy and stops for a user that is not there", { skip }, () => {
  const aws = fakeAws();
  try {
    const command = buildBootstrapCommand("us-east-1", "dev", { targetUserName: "accordagents-worker-dev" }, "win32");
    const missing = aws.run(command);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Expected existing AccordAgents worker IAM user accordagents-worker-dev was not found/);
    writeFileSync(path.join(aws.dir, "iam.json"), JSON.stringify({ users: ["accordagents-worker-dev"] }));
    const updated = aws.run(command);
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /Updated AccordAgents worker permissions for accordagents-worker-dev/);
    assert.ok(!aws.log("aws.log").some((call) => call.includes("create-access-key")), "no key is made");
  } finally {
    rmSync(aws.dir, { recursive: true, force: true });
  }
});

test("on Windows the server command runs to its line: the first time, again, stopped, and with no keys reported", { skip }, () => {
  const aws = fakeAws();
  try {
    const command = buildHubSetupCommand("us-east-1", KEY, NONCE, "win32");
    const first = aws.run(command);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(parseHubServerBlob(first.stdout), { version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu", nonce: NONCE, hostKeys: [HOST_KEY] });
    assert.ok(!aws.iam().userData.includes("\r"), "the first-boot script reaches Linux with LF line ends");
    assert.match(aws.iam().userData, new RegExp(`^#!/bin/bash\nset -e\n[\\s\\S]*${KEY.split(" ")[1]}`));

    const again = aws.run(command);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(parseHubServerBlob(again.stdout).ip, "3.14.15.92");
    const login = JSON.parse(aws.log("ssh.log")[0]) as { args: string[] };
    assert.ok(login.args.at(-1)?.includes(`grep -qxF '${KEY}'`), "run again, it lets this computer in");

    writeFileSync(path.join(aws.dir, "stopped"), "");
    assert.equal(parseHubServerBlob(aws.run(command).stdout).ip, "3.14.15.92");
    assert.equal(aws.log("aws.log").filter((line) => line.includes("create-instances")).length, 1, "the server is made once");
    assert.equal(aws.log("aws.log").filter((line) => line.includes("start-instance")).length, 1, "a stopped server is started");

    writeFileSync(path.join(aws.dir, "nokeys"), "");
    const sshCalls = aws.log("ssh.log").length;
    const noKeys = aws.run(command);
    assert.notEqual(noKeys.status, 0);
    assert.match(noKeys.stderr, /has not reported the keys/);
    assert.ok(!noKeys.stdout.includes("accord-hub-v1:"), "no line is printed");
    assert.equal(aws.log("ssh.log").length, sshCalls, "nothing is logged in to");
  } finally {
    rmSync(aws.dir, { recursive: true, force: true });
  }
});
