import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HUB_SETUP_BLOB_PREFIX, parseHubServerBlob, type HubSetupState } from "../../shared/hubSetup";
import { CommandError, type CommandOptions, type CommandResult } from "./command";
import { buildHubSetupCommand, hubLaunchScript } from "./hubProvisioning";
import { HubInstaller, hubActivateScript, hubCertificateScript, hubImportChatsScript, hubPrepareScript, hubServiceScript, hubSetOwnerScript, hubStartOverScript, type HubLinkRequest } from "./hubInstaller";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG0eZ0lJqBq3mH5w2m7uQx0w8Y7j1o0a2n4b6c8d0e2f accordagents-hub";

function bashSyntax(script: string): void {
  execFileSync("bash", ["-n"], { input: script });
}

function blobFor(ip: string): string {
  return `${HUB_SETUP_BLOB_PREFIX}${Buffer.from(JSON.stringify({ version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip, user: "ubuntu" })).toString("base64")}`;
}

test("the setup command is one bash script that names the region and this computer's key", () => {
  const command = buildHubSetupCommand("eu-central-1", KEY);
  assert.ok(command.startsWith("bash <<'ACCORDAGENTS_HUB'\n") && command.endsWith("\nACCORDAGENTS_HUB"));
  const script = command.slice("bash <<'ACCORDAGENTS_HUB'\n".length, -"\nACCORDAGENTS_HUB".length);
  bashSyntax(script);
  bashSyntax(hubLaunchScript(KEY));
  assert.match(script, /REGION=eu-central-1/);
  assert.ok(script.includes(KEY));
  assert.match(script, /--bundle-id nano_3_0/);
  assert.match(script, /get-instance-access-details/, "a server made before lets this computer in");
  assert.throws(() => buildHubSetupCommand("eu-central-1; rm -rf /", KEY));
  assert.throws(() => buildHubSetupCommand("us-east-1", "ssh-rsa AAAA' ; echo"));
});

test("the line the command prints is read back, with whatever was pasted around it", () => {
  const server = parseHubServerBlob(`Done. Paste this line:\n${blobFor("3.14.15.92")}\n`);
  assert.deepEqual(server, { version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu" });
  assert.throws(() => parseHubServerBlob("accord-aws-v1:abc"), /accord-hub-v1/);
  assert.throws(() => parseHubServerBlob(`${HUB_SETUP_BLOB_PREFIX}${Buffer.from(JSON.stringify({ version: 1, region: "us-east-1", instanceName: "x", ip: "1.2.3.4; reboot", user: "ubuntu" })).toString("base64")}`));
});

test("every script the installer runs on the server is valid bash", () => {
  for (const script of [hubPrepareScript(), hubActivateScript("/tmp/accordagents-hub-1.0.0", "1.0.0"), hubSetOwnerScript(), hubStartOverScript("20261018"),
    hubImportChatsScript("/tmp/chats.tgz"), hubServiceScript(), hubCertificateScript("3.14.15.92")]) {
    bashSyntax(script);
  }
  assert.throws(() => hubCertificateScript("3.14.15.92 && reboot"));
});

async function fixture(t: test.TestContext, behaviour: { owner: string[]; healthFailures?: number; failOn?: RegExp }) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = path.join(dir, "payload");
  await mkdir(payload);
  await writeFile(path.join(payload, "accordagents-hub.cjs"), "#!/usr/bin/env node\n");
  await writeFile(path.join(payload, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const calls: string[] = [];
  const owners = [...behaviour.owner];
  const run = async (command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    const result = (stdout: string): CommandResult => ({ command, args, stdout, stderr: "", exitCode: 0, timedOut: false });
    if (behaviour.failOn?.test(line)) throw new CommandError("failed", { command, args, stdout: "", stderr: "E: Unable to locate package sqlite3\n", exitCode: 100, timedOut: false });
    if (command === "ssh-keygen" && args.includes("-f") && !args.includes("-R")) {
      const file = args[args.indexOf("-f") + 1];
      await writeFile(file, "PRIVATE");
      await writeFile(`${file}.pub`, `${KEY}\n`);
    }
    if (command === "ssh" && args.at(-1)?.includes("--set-owner")) {
      assert.ok(options.input?.includes("\"deviceId\":\"device-"), "the owner identity goes on stdin");
      return result(`${owners.shift()}\n`);
    }
    if (command === "ssh" && args.at(-1)?.includes("--import-chat-copy")) return result("{\"ok\":true,\"conversations\":3}\n");
    return result("");
  };
  let healthFailures = behaviour.healthFailures ?? 0;
  const fetchImpl = (async () => {
    if (healthFailures > 0) { healthFailures -= 1; throw new TypeError("fetch failed"); }
    return new Response(JSON.stringify({ ok: true, protocol: 1, hubId: "hub-1", version: "1.2.3", head: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  const links: HubLinkRequest[] = [];
  const exports: number[] = [];
  const states: HubSetupState[] = [];
  const installer = new HubInstaller({
    keyDir: path.join(dir, "keys"),
    payloadDir: () => payload,
    bundledVersion: "1.2.3",
    identity: async () => ({ originId: "device-0123456789abcdef0123456789abcdef", publicKeyDerBase64: "MCowBQYDK2VwAyEA" }),
    exportChatCopy: async () => {
      const copy = path.join(dir, "copy");
      await mkdir(copy, { recursive: true });
      await writeFile(path.join(copy, "manifest.json"), "{}");
      exports.push(1);
      return { dir: copy, pushedThrough: 42, conversations: 3, cleanup: async () => undefined };
    },
    link: async (request) => { links.push(request); },
    currentLink: async () => undefined,
    run,
    fetchImpl,
    sleep: async () => undefined
  });
  installer.onProgress((state) => states.push(state));
  return { installer, calls, links, exports, states };
}

test("a first setup installs in order, copies the chats and starts sending after them", async (t) => {
  const f = await fixture(t, { owner: ["{\"ok\":true,\"hubId\":\"hub-1\",\"alreadyOwner\":false}"], healthFailures: 2 });
  const state = await f.installer.install(blobFor("3.14.15.92"));
  assert.equal(state.status, "ready", state.message);
  assert.equal(state.url, "https://3.14.15.92");
  assert.deepEqual(f.states.map((item) => item.phase).filter((phase, index, all) => all.indexOf(phase) === index),
    ["connecting", "preparing", "uploading", "owner", "chats", "starting", "certificate", "checking", "ready"]);
  assert.equal(f.exports.length, 1);
  assert.equal(f.links.length, 1);
  assert.equal(f.links[0].pushedThrough, 42, "the hub is not sent what the copy holds");
  assert.equal(f.links[0].server.installedVersion, "1.2.3");
  assert.ok(f.calls.some((call) => call.startsWith("scp ") && call.includes("accordagents-hub.cjs")));
  assert.ok(f.calls.some((call) => call.includes("certbot certonly")));
});

test("setting up again for the same desktop keeps the hub's chats and this desktop's cursors", async (t) => {
  const f = await fixture(t, { owner: ["{\"ok\":true,\"hubId\":\"hub-1\",\"alreadyOwner\":true}"] });
  const state = await f.installer.install(blobFor("3.14.15.92"));
  assert.equal(state.status, "ready", state.message);
  assert.equal(f.exports.length, 0, "no second copy");
  assert.equal(f.links[0].pushedThrough, undefined, "the cursors stand");
});

test("a server set up from another desktop starts over for this one, the old data kept aside", async (t) => {
  const f = await fixture(t, { owner: ["{\"ok\":false,\"reason\":\"another-owner\",\"hubId\":\"hub-1\"}", "{\"ok\":true,\"hubId\":\"hub-1\",\"alreadyOwner\":false}"] });
  const state = await f.installer.install(blobFor("3.14.15.92"));
  assert.equal(state.status, "ready", state.message);
  assert.ok(f.calls.some((call) => call.includes("data.replaced-")), "kept aside, not deleted");
  assert.equal(f.exports.length, 1);
});

test("a failing step is reported at that step, in the server's own words", async (t) => {
  const f = await fixture(t, { owner: [], failOn: /apt-get/ });
  const state = await f.installer.install(blobFor("3.14.15.92"));
  assert.equal(state.status, "failed");
  assert.equal(state.phase, "preparing");
  assert.match(state.message ?? "", /Unable to locate package sqlite3/);
  assert.equal(f.links.length, 0, "nothing is linked");
});

test("a pasted line that is not the command's is refused before anything runs", async (t) => {
  const f = await fixture(t, { owner: [] });
  assert.throws(() => f.installer.install("hello"), /accord-hub-v1/);
  assert.equal(f.calls.length, 0);
});

test("the setup command runs to its line against AWS, the first time and when run again", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-command-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  // A stand-in for the AWS CLI's Lightsail calls, keeping state in files.
  await writeFile(path.join(bin, "aws"), `#!/bin/bash
S=${JSON.stringify(dir)}
args="$*"
echo "$args" >> "$S/aws.log"
case "$args" in
  *get-regions*) echo us-east-1a ;;
  *create-instances*) touch "$S/instance" ;;
  *get-instance-access-details*privateKey*) printf -- '-----BEGIN KEY-----\\nX\\n-----END KEY-----\\n' ;;
  *get-instance-access-details*certKey*) echo "ssh-ed25519-cert-v01@openssh.com AAAA" ;;
  *get-instance*state.name*) [ -f "$S/instance" ] && echo running || exit 254 ;;
  *get-instance*) [ -f "$S/instance" ] || exit 254 ;;
  *allocate-static-ip*) touch "$S/ip" ;;
  *attach-static-ip*) touch "$S/attached" ;;
  *get-static-ip*attachedTo*) [ -f "$S/attached" ] && echo accordagents-hub || echo None ;;
  *get-static-ip*ipAddress*) echo 3.14.15.92 ;;
  *get-static-ip*) [ -f "$S/ip" ] || exit 254 ;;
  *put-instance-public-ports*) ;;
  *) echo "unexpected aws $args" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
  await writeFile(path.join(bin, "ssh"), `#!/bin/bash\necho "$*" >> ${JSON.stringify(path.join(dir, "ssh.log"))}\n`, { mode: 0o755 });
  const command = buildHubSetupCommand("us-east-1", KEY);
  const runIt = () => execFileSync("zsh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANG: "C" }, encoding: "utf8" });
  const first = runIt();
  assert.deepEqual(parseHubServerBlob(first), { version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu" });
  const again = runIt();
  assert.equal(parseHubServerBlob(again).ip, "3.14.15.92");
  const log = execFileSync("cat", [path.join(dir, "aws.log")], { encoding: "utf8" });
  assert.equal(log.split("\n").filter((line) => line.includes("create-instances")).length, 1, "the server is made once");
  assert.ok(execFileSync("cat", [path.join(dir, "ssh.log")], { encoding: "utf8" }).includes(KEY), "run again, it lets this computer in");
});
