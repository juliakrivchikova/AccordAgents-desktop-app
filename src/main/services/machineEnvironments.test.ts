import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { machineProfileVariables } from "../../shared/machineInstall";
import { runCommand } from "./command";
import { machineClaimEnvironmentScript, machineInstallLayout, machineServiceUnit } from "./machineInstallScripts";
import { remoteProfileCommand } from "./remoteWorkerTarget";
import { DefaultRemoteAgentSetupSync } from "./remoteAgentSetup";

const enrollment = (owner: string) => JSON.stringify({
  rendezvousId: "room-" + owner, issuer: { publicKeyDerBase64: owner },
  relaySealKeyBase64: "synthetic-secret-never-in-argv"
});
const shell = (script: string, input?: string) => runCommand("/bin/bash", ["-c", script], {
  input, primeLoginShellEnv: false, timeoutMs: 20_000
});

test("two simultaneous installers cannot enroll the same directory to different desktops", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accord-owner-race-"));
  try {
    const script = machineClaimEnvironmentScript(root);
    const results = await Promise.allSettled(["home", "work"].map(owner => shell(script, enrollment(owner))));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const saved = JSON.parse(await readFile(path.join(root, "environment-owner.json"), "utf8"));
    await shell(script, enrollment(saved.issuer));
    const loser = saved.issuer === "home" ? "work" : "home";
    await assert.rejects(shell(script, enrollment(loser)));
    assert.equal((await readdir(root)).length, 1, "no abandoned claim staging files");
    assert.ok(!script.includes("synthetic-secret"));
    assert.ok(!JSON.stringify(saved).includes("synthetic-secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy enrollment is checked before another desktop can claim its profiles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accord-owner-legacy-"));
  try {
    await writeFile(path.join(root, "enrollment.json"), enrollment("home"));
    await writeFile(path.join(root, "session.json"), "existing-session");
    await assert.rejects(shell(machineClaimEnvironmentScript(root), enrollment("work")));
    assert.deepEqual((await readdir(root)).sort(), ["enrollment.json", "session.json"]);
    assert.equal(await readFile(path.join(root, "enrollment.json"), "utf8"), enrollment("home"));
    await shell(machineClaimEnvironmentScript(root), enrollment("home"));
    assert.equal(await readFile(path.join(root, "session.json"), "utf8"), "existing-session");
    await writeFile(path.join(root, "environment-owner.json"), "{partial");
    await assert.rejects(shell(machineClaimEnvironmentScript(root), enrollment("home")));
    assert.equal(await readFile(path.join(root, "environment-owner.json"), "utf8"), "{partial");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider setup and the persistent service use the same isolated native home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accord-native-home-"));
  try {
    const home = path.join(root, "home");
    const command = remoteProfileCommand(home, "node -e 'console.log(JSON.stringify(process.env))'");
    const result = await runCommand("/bin/bash", ["-c", command], {
      env: { ...process.env, CODEX_HOME: "/shared/codex", CLAUDE_CONFIG_DIR: "/shared/claude", OTHER_LAPTOP_TOKEN: "must-not-inherit" },
      primeLoginShellEnv: false
    });
    const env = JSON.parse(result.stdout);
    for (const [key, value] of Object.entries(machineProfileVariables(home))) assert.equal(env[key], value);
    assert.equal(env.OTHER_LAPTOP_TOKEN, undefined);
    const unit = machineServiceUnit({
      layout: machineInstallLayout({ installRoot: root, userDataDir: root + "/data", serviceName: "home", serviceScope: "system" }),
      home: "/shared", profileHome: home, user: "ubuntu", nodePath: "/usr/bin/node", machineName: "Home"
    });
    for (const [key, value] of Object.entries(machineProfileVariables(home))) assert.ok(unit.includes("Environment=" + key + "=" + value + "\n"));
    assert.ok(unit.includes("Environment=ACCORD_AGENTS_MACHINE_PROFILE_HOME=" + home));
    assert.equal(remoteProfileCommand(undefined, "existing command"), "existing command", "legacy setup keeps its native credentials");
    assert.throws(() => remoteProfileCommand("/tmp/x/../shared", "true"), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two laptops synchronize only their own skills and retain native sessions on one host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accord-profile-sync-"));
  try {
    const clients = await Promise.all(["home", "work"].map(async name => {
      const source = path.join(root, name + "-laptop");
      const installRoot = path.join(root, "server", "devices", name);
      const profileHome = path.join(installRoot, "home");
      for (const native of [".codex", ".claude", ".agents"]) {
        await mkdir(path.join(source, native, "skills", name), { recursive: true });
        await writeFile(path.join(source, native, "skills", name, "SKILL.md"), name + " instructions");
      }
      await mkdir(path.join(profileHome, ".codex"), { recursive: true });
      await writeFile(path.join(profileHome, ".codex", "auth.json"), name + "-native-login");
      await writeFile(path.join(profileHome, ".codex", "history.jsonl"), name + "-native-history");
      const worker = { host: "one-shared-host", workerRoot: installRoot, profileHome };
      const makeSync = () => new DefaultRemoteAgentSetupSync({
        homeDir: source, tempDir: root,
        // Only substitute transport. The real bundle builder, shell, Node
        // activation, symlinks, state file and restart path all execute.
        commandRunner: async (_command, args, options) => shell(args.at(-1)!, options?.input),
        mirrorSync: {
          async syncUp(request) {
            assert.ok(request.remotePath.startsWith(installRoot + "/agent-setup/"));
            await cp(request.localPath, request.remotePath, { recursive: true });
          },
          async syncDown() { throw new Error("no write-back"); }
        }
      });
      return { name, source, profileHome, worker, makeSync };
    }));
    await Promise.all(clients.map(client => client.makeSync().sync({ worker: client.worker })));
    for (const client of clients) {
      for (const native of [".codex", ".claude", ".agents"]) {
        assert.deepEqual(await readdir(path.join(client.profileHome, native, "skills")), [client.name]);
        assert.equal(await readFile(path.join(client.profileHome, native, "skills", client.name, "SKILL.md"), "utf8"), client.name + " instructions");
      }
      assert.equal(await readFile(path.join(client.profileHome, ".codex", "auth.json"), "utf8"), client.name + "-native-login");
      assert.equal(await readFile(path.join(client.profileHome, ".codex", "history.jsonl"), "utf8"), client.name + "-native-history");
    }
    const [home, work] = clients;
    await writeFile(path.join(home.source, ".codex", "skills", home.name, "SKILL.md"), "updated home skill");
    await home.makeSync().sync({ worker: home.worker });
    await work.makeSync().sync({ worker: work.worker });
    assert.equal(await readFile(path.join(home.profileHome, ".codex", "skills", "home", "SKILL.md"), "utf8"), "updated home skill");
    assert.equal(await readFile(path.join(work.profileHome, ".codex", "skills", "work", "SKILL.md"), "utf8"), "work instructions");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate machine runtimes persist separate environment variables across restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accord-env-settings-"));
  const code = [
    "const path = require('node:path');",
    "const { createHeadlessPlatform, setHostPlatform } = require(process.argv[1]);",
    "const { SettingsService } = require(process.argv[2]);",
    "const dir = process.argv[3], profileHome = process.argv[4], mode = process.argv[5];",
    "setHostPlatform(createHeadlessPlatform({ userDataDir: dir }));",
    "const settings = new SettingsService({ profileHome });",
    "(async () => {",
    "if (mode !== 'restart') await settings.importMachineSettingsSnapshot({",
    "version: 1, exportedAt: new Date().toISOString(), settingsJson: '{}',",
    "agentEnvironment: [{key:'EXAMPLE_TOKEN',value:mode}, {key:'CODEX_HOME',value:'/same/laptop/path'}]",
    "});",
    "console.log(JSON.stringify(await settings.getManualAgentEnvironment()));",
    "})().catch(error => { console.error(error); process.exit(1); });"
  ].join("\n");
  const read = async (name: string, mode: string) => {
    const result = await runCommand(process.execPath, ["-e", code, path.join(__dirname, "..", "platform.js"),
      path.join(__dirname, "settings.js"), path.join(root, name, "data"), path.join(root, name, "home"), mode],
    { primeLoginShellEnv: false, timeoutMs: 15_000 });
    return JSON.parse(result.stdout);
  };
  try {
    const [home, work] = await Promise.all([read("home", "home-token"), read("work", "work-token")]);
    assert.equal(home.env.EXAMPLE_TOKEN, "home-token");
    assert.equal(work.env.EXAMPLE_TOKEN, "work-token");
    assert.equal(home.env.CODEX_HOME, path.join(root, "home", "home", ".codex"));
    assert.equal(work.env.CODEX_HOME, path.join(root, "work", "home", ".codex"));
    assert.deepEqual(await read("home", "restart"), home);
    assert.deepEqual(await read("work", "restart"), work);
    assert.ok(!(await readFile(path.join(root, "home", "data", "settings.json"), "utf8")).includes("home-token"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
