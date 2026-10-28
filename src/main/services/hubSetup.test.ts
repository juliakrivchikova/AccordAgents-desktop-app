import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HUB_SETUP_BLOB_PREFIX, parseHubServerBlob, type HubLinkConfig, type HubSetupState } from "../../shared/hubSetup";
import { CommandError, type CommandOptions, type CommandResult } from "./command";
import { buildHubSetupCommand, hubLaunchScript } from "./hubProvisioning";
import { HubInstaller, hubActivateScript, hubCertificateScript, hubImportChatsScript, hubPrepareScript, hubServiceScript, hubServiceUnit, hubSetOwnerScript, hubStartOverScript, removeStaleHubTemp, sshQuoted, type HubLinkRequest } from "./hubInstaller";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG0eZ0lJqBq3mH5w2m7uQx0w8Y7j1o0a2n4b6c8d0e2f accordagents-hub";

function bashSyntax(script: string): void {
  execFileSync("bash", ["-n"], { input: script });
}

const NONCE = "abcdefghijklmnop1234";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILJIJwb67mBYg22EJHJ2JtfmDHgQ8J+tkl+GD0TPyfjz";

function blobFor(ip: string, extra: { nonce?: string; hostKeys?: string[] } = {}): string {
  return `${HUB_SETUP_BLOB_PREFIX}${Buffer.from(JSON.stringify({ version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip, user: "ubuntu", hostKeys: [HOST_KEY], ...extra })).toString("base64")}`;
}

test("the setup command is one bash script that names the region, this computer's key and its label", () => {
  const command = buildHubSetupCommand("eu-central-1", KEY, NONCE);
  assert.ok(command.startsWith("bash <<'ACCORDAGENTS_HUB'\n") && command.endsWith("\nACCORDAGENTS_HUB"));
  const script = command.slice("bash <<'ACCORDAGENTS_HUB'\n".length, -"\nACCORDAGENTS_HUB".length);
  bashSyntax(script);
  bashSyntax(hubLaunchScript(KEY));
  assert.match(script, /REGION=eu-central-1/);
  assert.match(script, new RegExp(`NONCE=${NONCE}`));
  assert.ok(script.includes(KEY));
  assert.match(script, /--bundle-id nano_3_0/);
  assert.match(script, /get-instance-access-details/, "a server made before lets this computer in");
  assert.throws(() => buildHubSetupCommand("eu-central-1; rm -rf /", KEY, NONCE));
  assert.throws(() => buildHubSetupCommand("us-east-1", "ssh-rsa AAAA' ; echo", NONCE));
  assert.throws(() => buildHubSetupCommand("us-east-1", KEY, "x; reboot"));
});

test("the line the command prints is read back, with whatever was pasted around it", () => {
  const server = parseHubServerBlob(`Done. Paste this line:\n${blobFor("3.14.15.92", { nonce: NONCE, hostKeys: [HOST_KEY] })}\n`);
  assert.deepEqual(server, { version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu", nonce: NONCE, hostKeys: [HOST_KEY] });
  assert.throws(() => parseHubServerBlob("accord-aws-v1:abc"), /accord-hub-v1/);
  assert.throws(() => parseHubServerBlob(blobFor("1.2.3.4; reboot")));
  assert.throws(() => parseHubServerBlob(blobFor("1.2.3.4", { hostKeys: ["ssh-ed25519 AAAA\n1.2.3.4 ssh-rsa EVIL"] })));
});

test("every script the installer runs on the server is valid bash", () => {
  for (const script of [hubPrepareScript(), hubActivateScript("/home/ubuntu/accordagents-hub-1.0.0", "1.0.0"), hubSetOwnerScript(), hubStartOverScript("20261018"),
    hubImportChatsScript(), hubServiceScript(), hubCertificateScript("3.14.15.92")]) {
    bashSyntax(script);
  }
  assert.throws(() => hubCertificateScript("3.14.15.92 && reboot"));
  // Root's directories: the service writes only its data.
  assert.match(hubPrepareScript(), /install -d -o root -g root -m 755 \/var\/lib\/accordagents-hub /);
  assert.match(hubServiceScript(), /ReadWritePaths=\/var\/lib\/accordagents-hub\/data\n/);
  assert.doesNotMatch(hubPrepareScript(), /setup_22\.x \| bash/, "no script piped to a root shell");
});

async function fixture(t: test.TestContext, behaviour: { owner: string[]; healthFailures?: number; failOn?: RegExp; linked?: HubLinkConfig; reachable?: boolean; defaultRegion?: string; keyDirName?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = path.join(dir, "payload");
  await mkdir(payload);
  await writeFile(path.join(payload, "accordagents-hub.cjs"), "#!/usr/bin/env node\n");
  await writeFile(path.join(payload, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const calls: string[] = [];
  const argv: Array<{ command: string; args: string[] }> = [];
  const streamed: string[] = [];
  const owners = [...behaviour.owner];
  const control = { failOn: behaviour.failOn };
  const run = async (command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    argv.push({ command, args });
    const result = (stdout: string): CommandResult => ({ command, args, stdout, stderr: "", exitCode: 0, timedOut: false });
    if (control.failOn?.test(line)) throw new CommandError("failed", { command, args, stdout: "", stderr: "E: Unable to locate package sqlite3\n", exitCode: 100, timedOut: false });
    if (command === "ssh-keygen" && args.includes("-f") && !args.includes("-R")) {
      const file = args[args.indexOf("-f") + 1];
      await writeFile(file, "PRIVATE");
      await writeFile(`${file}.pub`, `${KEY}\n`);
    }
    if (command === "tar") await writeFile(args[args.indexOf("-czf") + 1], "archive");
    if (command === "ssh" && args.at(-1)?.includes("--set-owner")) {
      assert.ok(options.input?.includes("\"deviceId\":\"device-"), "the owner identity goes on stdin");
      return result(`${owners.shift()}\n`);
    }
    if (command === "ssh" && args.at(-1)?.includes("--import-chat-copy")) {
      if (options.inputStream) streamed.push(line);
      return result("{\"ok\":true,\"conversations\":3}\n");
    }
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
  const keyDir = path.join(dir, behaviour.keyDirName ?? "keys");
  const installer = new HubInstaller({
    keyDir,
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
    currentLink: async () => behaviour.linked,
    reachable: () => behaviour.reachable,
    defaultRegion: async () => behaviour.defaultRegion,
    run,
    fetchImpl,
    sleep: async () => undefined
  });
  installer.onProgress((state) => states.push(state));
  // A line names the command this desktop issued.
  await installer.command("us-east-1");
  const nonce = Object.keys(JSON.parse(await readFile(path.join(keyDir, "commands.json"), "utf8")))[0];
  return { installer, calls, argv, links, exports, states, streamed, nonce, keyDir, control };
}

const OWNER_NEW = "{\"ok\":true,\"hubId\":\"hub-1\",\"alreadyOwner\":false}";

test("a computer whose app folder has a space in its path (macOS: Application Support) logs in with the pinned keys", async (t) => {
  const f = await fixture(t, { owner: [OWNER_NEW], keyDirName: path.join("Library", "Application Support", "AccordAgents", "hub") });
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce, hostKeys: [HOST_KEY] }) });
  assert.equal(state.status, "ready", state.message);
  const knownHosts = path.join(f.keyDir, "known_hosts");
  assert.equal(await readFile(knownHosts, "utf8"), `3.14.15.92 ${HOST_KEY}\n`);
  const remote = f.argv.filter((call) => call.command === "ssh" || call.command === "scp");
  assert.ok(remote.length > 0);
  for (const call of remote) {
    // ssh splits an unquoted value on spaces and would read two files that
    // do not exist; the whole path goes in one quoted value.
    assert.ok(call.args.includes(`UserKnownHostsFile="${knownHosts}"`), call.args.join(" "));
  }
});

test("an ssh option value keeps quotes and backslashes in a path", () => {
  assert.equal(sshQuoted("/Users/a b/known_hosts"), "\"/Users/a b/known_hosts\"");
  assert.equal(sshQuoted("/tmp/q\"t\\b/known_hosts"), "\"/tmp/q\\\"t\\\\b/known_hosts\"");
});
const OWNER_DONE = "{\"ok\":true,\"hubId\":\"hub-1\",\"alreadyOwner\":true,\"chatsCopied\":true}";
const OWNER_HALF = "{\"ok\":true,\"hubId\":\"hub-1\",\"alreadyOwner\":true,\"chatsCopied\":false}";
const OWNER_OTHER = "{\"ok\":false,\"reason\":\"another-owner\",\"hubId\":\"hub-1\"}";

test("a first setup installs in order, streams the chats and starts sending after them", async (t) => {
  const f = await fixture(t, { owner: [OWNER_NEW], healthFailures: 2 });
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce, hostKeys: [HOST_KEY] }) });
  assert.equal(state.status, "ready", state.message);
  assert.equal(state.url, "https://3.14.15.92");
  assert.deepEqual(f.states.map((item) => item.phase).filter((phase, index, all) => all.indexOf(phase) === index),
    ["connecting", "preparing", "uploading", "owner", "chats", "starting", "certificate", "checking", "ready"]);
  assert.equal(f.exports.length, 1);
  assert.equal(f.links[0].pushedThrough, 42, "the hub is not sent what the copy holds");
  assert.equal(f.links[0].server.installedVersion, "1.2.3");
  assert.equal(f.streamed.length, 1, "the chats go on ssh's stdin, never into a file on the server");
  assert.ok(!f.calls.some((call) => call.startsWith("scp ") && call.includes("chats")));
  // Exactly the host keys AWS reported are trusted.
  assert.equal(await readFile(path.join(f.keyDir, "known_hosts"), "utf8"), `3.14.15.92 ${HOST_KEY}\n`);
  assert.ok(f.calls.filter((call) => call.startsWith("ssh ")).every((call) => call.includes("StrictHostKeyChecking=yes")));
  assert.ok(!f.calls.some((call) => call.startsWith("ssh-keyscan")));
});

test("a line this computer's command did not print is refused before anything runs", async (t) => {
  const f = await fixture(t, { owner: [] });
  const before = f.calls.length;
  await assert.rejects(f.installer.install({ blob: blobFor("3.14.15.92", { nonce: "zzzzzzzzzzzzzzzzzzzz" }) }), /not printed by the command/);
  await assert.rejects(f.installer.install({ blob: blobFor("3.14.15.92") }), /not printed by the command/);
  await assert.rejects(f.installer.install({ blob: "hello" }), /accord-hub-v1/);
  assert.equal(f.calls.length, before);
});

test("setting up again for the same desktop keeps the hub's chats and this desktop's cursors", async (t) => {
  const f = await fixture(t, { owner: [OWNER_DONE], linked: { url: "https://3.14.15.92", hubId: "hub-1" } });
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  assert.equal(state.status, "ready", state.message);
  assert.equal(f.exports.length, 0, "no second copy");
  assert.deepEqual(state.skipped, ["chats"]);
  assert.equal(f.links[0].pushedThrough, undefined, "the cursors stand");
});

test("a copy taken by a setup that never linked this desktop is taken again", async (t) => {
  // The import finished but the link did not: what this desktop wrote since
  // is in neither the copy on the hub nor its push cursor.
  const f = await fixture(t, { owner: [OWNER_DONE] });
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  assert.equal(state.status, "ready", state.message);
  assert.equal(f.exports.length, 1);
  assert.equal(f.links[0].pushedThrough, 42);
  const other = await fixture(t, { owner: [OWNER_DONE], linked: { url: "https://3.14.15.92", hubId: "hub-0" } });
  await other.installer.install({ blob: blobFor("3.14.15.92", { nonce: other.nonce }) });
  assert.equal(other.exports.length, 1, "linked to another hub: copied");
});

test("linked to this very hub, a copy the hub never finished is taken again", async (t) => {
  for (const owner of [OWNER_HALF, OWNER_NEW]) {
    const f = await fixture(t, { owner: [owner], linked: { url: "https://3.14.15.92", hubId: "hub-1" } });
    const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
    assert.equal(state.status, "ready", state.message);
    assert.equal(f.exports.length, 1, owner);
    assert.equal(f.links[0].pushedThrough, 42);
  }
});

test("a yes to start over is for the server it was asked about", async (t) => {
  const f = await fixture(t, { owner: [OWNER_OTHER, OWNER_OTHER] });
  await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  const other = await f.installer.install({ blob: blobFor("3.14.15.93", { nonce: f.nonce }), startOver: true });
  assert.equal(other.reason, "another-owner", "asked again for the other server");
  assert.ok(!f.calls.some((call) => call.includes("data.replaced-")));
});

test("pasting a line for another server keeps the keys of the one in use", async (t) => {
  const f = await fixture(t, { owner: [], failOn: /apt-get/ });
  await writeFile(path.join(f.keyDir, "known_hosts"), `3.14.15.92 ${HOST_KEY}\n`);
  await f.installer.install({ blob: blobFor("3.14.15.93", { nonce: f.nonce }) });
  const hosts = await readFile(path.join(f.keyDir, "known_hosts"), "utf8");
  assert.ok(hosts.includes(`3.14.15.92 ${HOST_KEY}`) && hosts.includes(`3.14.15.93 ${HOST_KEY}`));
});

test("Settings is told whether the hub answers now and which region to offer", async (t) => {
  const none = await fixture(t, { owner: [], defaultRegion: "eu-west-2" });
  assert.deepEqual(await none.installer.state(), { status: "none", defaultRegion: "eu-west-2", bundledVersion: "1.2.3" });
  const down = await fixture(t, { owner: [], linked: { url: "https://3.14.15.92", hubId: "hub-1" }, reachable: false });
  const state = await down.installer.state();
  assert.equal(state.status, "ready");
  assert.equal(state.reachable, false);
});

test("the lines the User may dismiss are the server's own, and need a server", async (t) => {
  const given = { id: "given-up:a:1", text: "Some changes could not be applied." };
  const none = await fixture(t, { owner: [] });
  (none.installer as unknown as { options: Record<string, unknown> }).options.dismissableNotices = async () => [given];
  assert.equal((await none.installer.state()).dismissableNotices, undefined, "nothing is said before a server is set up");
  const linked = await fixture(t, { owner: [], linked: { url: "https://3.14.15.92", hubId: "hub-1" } });
  (linked.installer as unknown as { options: Record<string, unknown> }).options.dismissableNotices = async () => [given];
  assert.deepEqual((await linked.installer.state()).dismissableNotices, [given]);
});

test("the service is never given up on, and every hub command keeps to the server's memory", () => {
  // Read by systemd only in [Unit].
  assert.match(hubServiceUnit(), /\[Unit\][^[]*^StartLimitIntervalSec=0$/m);
  assert.match(hubServiceUnit(), /^RestartMaxDelaySec=60$/m);
  assert.match(hubSetOwnerScript(), /systemd-run .*--on-active=\d+min \/bin\/systemctl start accordagents-hub/);
  for (const script of [hubSetOwnerScript(), hubImportChatsScript()]) assert.match(script, /NODE_OPTIONS=--max-old-space-size=\d+ node /);
  assert.match(hubPrepareScript(), /^set -eo pipefail$/m);
});

test("chat copies a setup left behind are removed, and only once no setup can still be using them", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-temp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  for (const name of ["accordagents-hub-copy-old", "accordagents-hub-archive-old", "accordagents-hub-copy-new", "unrelated-old"]) {
    await mkdir(path.join(dir, name, "copy"), { recursive: true });
    if (name.endsWith("-old")) await utimes(path.join(dir, name), new Date(now - 7 * 3600_000), new Date(now - 7 * 3600_000));
  }
  assert.equal(await removeStaleHubTemp(dir, now), 2);
  assert.deepEqual((await readdir(dir)).sort(), ["accordagents-hub-copy-new", "unrelated-old"]);
});

test("a setup that failed while copying the chats copies them when run again", async (t) => {
  const f = await fixture(t, { owner: [OWNER_NEW, OWNER_HALF], failOn: /--import-chat-copy/ });
  const failed = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "chats");
  assert.ok(f.calls.some((call) => call.includes("systemctl start accordagents-hub")), "a hub that ran before runs again");
  f.control.failOn = undefined;
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  assert.equal(state.status, "ready", state.message);
  assert.equal(f.exports.length, 2, "copied on the retry");
  assert.equal(f.links.at(-1)?.pushedThrough, 42);
});

test("a server another desktop set up is started over only when the User says so, its data kept aside", async (t) => {
  const f = await fixture(t, { owner: [OWNER_OTHER, OWNER_OTHER, OWNER_NEW] });
  const asked = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  assert.equal(asked.status, "failed");
  assert.equal(asked.reason, "another-owner");
  assert.ok(!f.calls.some((call) => call.includes("data.replaced-")), "nothing moved without her yes");
  assert.ok(f.calls.some((call) => call.includes("systemctl start accordagents-hub")), "the other computer's hub runs again while she decides");
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }), startOver: true });
  assert.equal(state.status, "ready", state.message);
  assert.ok(f.calls.some((call) => call.includes("data.replaced-")), "kept aside, not deleted");
  assert.equal(f.exports.length, 1);
});

test("a server whose keys AWS did not report is never trusted on the first key it shows", async (t) => {
  const f = await fixture(t, { owner: [OWNER_NEW] });
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce, hostKeys: [] }) });
  assert.equal(state.status, "failed");
  assert.match(state.message ?? "", /does not know the server's keys/);
  assert.ok(!f.calls.some((call) => call.startsWith("ssh ") || call.startsWith("scp ")), "nothing is sent to it");
  // An update keeps only the keys pinned at setup.
  const server = { version: 1 as const, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu", installedVersion: "1.0.0" };
  const update = await fixture(t, { owner: [OWNER_DONE], linked: { url: "https://3.14.15.92", hubId: "hub-1", server } });
  assert.equal((await update.installer.install({})).status, "failed");
  assert.ok(!update.calls.some((call) => call.startsWith("ssh ") || call.startsWith("scp ")));
  // A server record from settings is the only source of these fields: one
  // that is not an address is not used at all.
  const forged = await fixture(t, { owner: [], linked: { url: "https://3.14.15.92", hubId: "hub-1", server: { ...server, user: "-oProxyCommand=x" } } });
  await assert.rejects(forged.installer.install({}), /No server is set up/);
});

test("a failing step is reported at that step, in the server's own words", async (t) => {
  const f = await fixture(t, { owner: [], failOn: /apt-get/ });
  const state = await f.installer.install({ blob: blobFor("3.14.15.92", { nonce: f.nonce }) });
  assert.equal(state.status, "failed");
  assert.equal(state.phase, "preparing");
  assert.match(state.message ?? "", /Unable to locate package sqlite3/);
  assert.equal(f.links.length, 0, "nothing is linked");
});

test("without a line, the server this desktop uses is updated (its host key kept)", async (t) => {
  const server = { version: 1 as const, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu", installedVersion: "1.0.0" };
  const f = await fixture(t, { owner: [OWNER_DONE], linked: { url: "https://3.14.15.92", hubId: "hub-1", server } });
  await writeFile(path.join(f.keyDir, "known_hosts"), `3.14.15.92 ${HOST_KEY}\n`);
  const state = await f.installer.install({});
  assert.equal(state.status, "ready", state.message);
  assert.equal(f.links[0].server.installedVersion, "1.2.3");
  assert.ok(!f.calls.some((call) => call.startsWith("ssh-keyscan")), "the pinned key stays");
});

test("the setup command runs to its line against AWS: the first time, again, and with the server stopped", async (t) => {
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
  *get-instance-access-details*) n=$(( $(cat "$S/access" 2>/dev/null || echo 0) + 1 )); echo $n > "$S/access"
    keys='{"algorithm":"ssh-ed25519","publicKey":"AAAAC3NzaC1lZDI1NTE5AAAAILJIJwb67mBYg22EJHJ2JtfmDHgQ8J+tkl+GD0TPyfjz"}'; [ -f "$S/nokeys" ] && keys=""
    printf '{"privateKey":"%s","certKey":"%s","hostKeys":[%s]}' "-----BEGIN KEY-----\\\\nPAIR-$n\\\\n-----END KEY-----\\\\n" "ssh-ed25519-cert-v01@openssh.com PAIR-$n" "$keys" ;;
  *start-instance*) rm -f "$S/stopped" ;;
  *get-instance*state.name*) [ -f "$S/instance" ] || exit 254
    if [ -f "$S/stopping" ]; then rm "$S/stopping"; touch "$S/stopped"; echo stopping; elif [ -f "$S/stopped" ]; then echo stopped; else echo running; fi ;;
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
  // The key and its certificate must come from one AWS answer to log in,
  // and, checking strictly like the real one, the server's own key must be
  // listed under its address.
  await writeFile(path.join(bin, "ssh"), `#!/bin/bash
echo "$*" >> ${JSON.stringify(path.join(dir, "ssh.log"))}
key=""; cert=""; nostdin=""; hosts=""; strict=""; dest=""
while [ $# -gt 0 ]; do case "$1" in
  -n) nostdin=1 ;;
  -i) key=$2; shift ;;
  -o) case "$2" in CertificateFile=*) cert=\${2#CertificateFile=} ;; UserKnownHostsFile=*) hosts=\${2#UserKnownHostsFile=} ;; StrictHostKeyChecking=*) strict=\${2#StrictHostKeyChecking=} ;; esac; shift ;;
  *@*) dest=\${1#*@}; break ;;
esac; shift; done
if [ "$strict" = yes ] && ! grep -qxF "$dest ${HOST_KEY}" "$hosts"; then
  echo "No ED25519 host key is known for $dest and you have requested strict checking." >&2; exit 255
fi
k=$(grep -o 'PAIR-[0-9]*' "$key"); c=$(grep -o 'PAIR-[0-9]*' "$cert")
[ -n "$k" ] && [ "$k" = "$c" ] || { echo "Permission denied (publickey)." >&2; exit 255; }
# Like the real one: without -n, whatever is on stdin is sent to the server.
[ -n "$nostdin" ] || cat > /dev/null
`, { mode: 0o755 });
  // Waiting for AWS is not waited out here.
  await writeFile(path.join(bin, "sleep"), "#!/bin/sh\n", { mode: 0o755 });
  const command = buildHubSetupCommand("us-east-1", KEY, NONCE);
  const runIt = () => execFileSync("zsh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANG: "C" }, encoding: "utf8" });
  const first = runIt();
  assert.deepEqual(parseHubServerBlob(first), { version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "3.14.15.92", user: "ubuntu", nonce: NONCE, hostKeys: [HOST_KEY] });
  const again = runIt();
  assert.equal(parseHubServerBlob(again).ip, "3.14.15.92");
  const sshLog = execFileSync("cat", [path.join(dir, "ssh.log")], { encoding: "utf8" });
  assert.ok(sshLog.includes(KEY), "run again, it lets this computer in");
  assert.ok(sshLog.includes("StrictHostKeyChecking=yes"), "the server's key AWS reported is checked");
  await writeFile(path.join(dir, "stopped"), "");
  assert.equal(parseHubServerBlob(runIt()).ip, "3.14.15.92");
  const log = execFileSync("cat", [path.join(dir, "aws.log")], { encoding: "utf8" });
  assert.equal(log.split("\n").filter((line) => line.includes("create-instances")).length, 1, "the server is made once");
  assert.equal(log.split("\n").filter((line) => line.includes("start-instance")).length, 1, "a stopped server is started");
  // Still stopping when the command looks: started once it has stopped.
  await writeFile(path.join(dir, "stopping"), "");
  assert.equal(parseHubServerBlob(runIt()).ip, "3.14.15.92");
  const started = execFileSync("cat", [path.join(dir, "aws.log")], { encoding: "utf8" }).split("\n").filter((line) => line.includes("start-instance")).length;
  assert.equal(started, 2);
  // AWS that reports no keys for the server: no line, nothing logged in to.
  await writeFile(path.join(dir, "nokeys"), "");
  const sshCalls = execFileSync("cat", [path.join(dir, "ssh.log")], { encoding: "utf8" }).split("\n").length;
  assert.throws(() => execFileSync("zsh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANG: "C" }, encoding: "utf8", stdio: "pipe" }),
    (error: { stderr?: string; stdout?: string }) => /has not reported the keys/.test(error.stderr ?? "") && !(error.stdout ?? "").includes(HUB_SETUP_BLOB_PREFIX));
  assert.equal(execFileSync("cat", [path.join(dir, "ssh.log")], { encoding: "utf8" }).split("\n").length, sshCalls);
});
