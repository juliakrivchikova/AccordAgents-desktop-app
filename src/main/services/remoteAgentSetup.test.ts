import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./command";
import {
  DefaultRemoteAgentSetupSync,
  buildPortableAgentSetupBundle,
  remotePortableSetupActivationScript,
  sanitizeClaudeMcpServers,
  sanitizeClaudePortableSettings,
  sanitizeCodexPortableConfig
} from "./remoteAgentSetup";
import type { RemoteMirrorSyncRunner } from "./remoteMirrorSync";

test("portable bundle materializes global skills and excludes machine state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-setup-test-"));
  const homeDir = path.join(root, "home");
  const externalSkill = path.join(root, "external-skill");
  const externalNonSkill = path.join(root, "external-non-skill");
  const externalSecret = path.join(root, "outside-secret.txt");
  await mkdir(path.join(homeDir, ".codex", "skills"), { recursive: true });
  await mkdir(path.join(homeDir, ".codex", "rules"), { recursive: true });
  await mkdir(path.join(homeDir, ".claude"), { recursive: true });
  await mkdir(path.join(homeDir, ".gemini", "config", "skills", "gemini-skill"), { recursive: true });
  await mkdir(externalSkill, { recursive: true });
  await mkdir(externalNonSkill, { recursive: true });
  await writeFile(path.join(externalSkill, "SKILL.md"), "# Portable skill\n");
  await mkdir(path.join(externalSkill, "tests", "fixtures"), { recursive: true });
  await writeFile(path.join(externalSkill, "tests", "fixtures", "payload.txt"), "fixture\n");
  await writeFile(path.join(externalSkill, ".template"), "hidden asset\n");
  await writeFile(path.join(externalSkill, "auth.json"), "secret");
  await writeFile(path.join(externalSkill, "native-tool"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]));
  await writeFile(externalSecret, "outside secret");
  await writeFile(path.join(externalNonSkill, "id_rsa"), "private key");
  await symlink(externalSecret, path.join(externalSkill, "outside-secret.txt"));
  await symlink(externalSkill, path.join(homeDir, ".codex", "skills", "linked-skill"));
  await symlink(externalNonSkill, path.join(homeDir, ".codex", "skills", "not-a-skill"));
  await writeFile(path.join(homeDir, ".codex", "AGENTS.md"), "Global instructions\n");
  await writeFile(path.join(homeDir, ".codex", "rules", "default.rules"), "prefix_rule(pattern=[\"npm\"])\n");
  await writeFile(path.join(homeDir, ".claude", "CLAUDE.md"), "Claude instructions\n");
  await writeFile(
    path.join(homeDir, ".gemini", "config", "skills", "gemini-skill", "SKILL.md"),
    "# Gemini portable skill\n"
  );
  await writeFile(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    enabledPlugins: { "portable@example": true },
    theme: "dark"
  }));
  await writeFile(path.join(homeDir, ".claude.json"), JSON.stringify({
    oauthAccount: { token: "never-copy" },
    mcpServers: {
      docs: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "${DOCS_TOKEN}" } },
      local: { command: "/Users/me/bin/server" }
    }
  }));
  await writeFile(path.join(homeDir, ".codex", "config.toml"), [
    "model = \"ignored\"",
    "[mcp_servers.docs]",
    "url = \"https://example.test/mcp\"",
    "[mcp_servers.local]",
    "command = \"/Users/me/bin/server\"",
    "[plugins.\"portable@example\"]",
    "enabled = true"
  ].join("\n"));

  const bundle = await buildPortableAgentSetupBundle({ homeDir, tempDir: root });
  try {
    assert.equal(await readFile(path.join(bundle.localPath, "codex", "skills", "linked-skill", "SKILL.md"), "utf8"), "# Portable skill\n");
    assert.equal(
      await readFile(path.join(bundle.localPath, "codex", "skills", "linked-skill", "tests", "fixtures", "payload.txt"), "utf8"),
      "fixture\n"
    );
    assert.equal(
      await readFile(path.join(bundle.localPath, "codex", "skills", "linked-skill", ".template"), "utf8"),
      "hidden asset\n"
    );
    assert.deepEqual(
      await readFile(path.join(bundle.localPath, "codex", "skills", "linked-skill", "native-tool")),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00])
    );
    await assert.rejects(readFile(path.join(bundle.localPath, "codex", "skills", "linked-skill", "auth.json")));
    await assert.rejects(readFile(path.join(bundle.localPath, "codex", "skills", "linked-skill", "outside-secret.txt")));
    await assert.rejects(readFile(path.join(bundle.localPath, "codex", "skills", "not-a-skill", "id_rsa")));
    assert.ok(bundle.codexConfigOverrides?.includes("mcp_servers.docs.url=\"https://example.test/mcp\""));
    assert.ok(bundle.codexConfigOverrides?.includes("plugins.\"portable@example\".enabled=true"));
    assert.deepEqual(bundle.claudeSettings, { enabledPlugins: { "portable@example": true } });
    assert.deepEqual(bundle.claudeMcpServers, {
      docs: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "${DOCS_TOKEN}" } }
    });
    assert.ok(bundle.manifest.links.some((link) => link.root === "codex" && link.target === "skills/linked-skill"));
    assert.ok(bundle.manifest.links.some((link) => link.root === "gemini" && link.target === "skills/gemini-skill"));
    assert.equal(
      await readFile(path.join(bundle.localPath, "gemini", "skills", "gemini-skill", "SKILL.md"), "utf8"),
      "# Gemini portable skill\n"
    );
    assert.ok(bundle.manifest.totalBytes < 100 * 1024 * 1024);
  } finally {
    await bundle.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("portable bundle follows custom provider homes without copying their paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-custom-home-test-"));
  const homeDir = path.join(root, "home");
  const codexHomeDir = path.join(root, "custom-codex");
  const claudeConfigDir = path.join(root, "custom-claude");
  const geminiConfigDir = path.join(root, "custom-gemini");
  await mkdir(path.join(codexHomeDir, "skills", "codex-custom"), { recursive: true });
  await mkdir(path.join(claudeConfigDir, "skills", "claude-custom"), { recursive: true });
  await mkdir(path.join(codexHomeDir, "skills", "gstack"), { recursive: true });
  await mkdir(path.join(claudeConfigDir, "skills", "gstack"), { recursive: true });
  await mkdir(path.join(claudeConfigDir, "skills", "gstack-wrapper"), { recursive: true });
  await mkdir(path.join(geminiConfigDir, "skills", "gemini-custom"), { recursive: true });
  await writeFile(path.join(codexHomeDir, "skills", "codex-custom", "SKILL.md"), "codex\n");
  await writeFile(path.join(claudeConfigDir, "skills", "claude-custom", "SKILL.md"), "claude\n");
  await writeFile(path.join(codexHomeDir, "skills", "gstack", "SKILL.md"), "codex gstack\n");
  await writeFile(path.join(claudeConfigDir, "skills", "gstack", "SKILL.md"), "claude gstack\n");
  await writeFile(path.join(geminiConfigDir, "skills", "gemini-custom", "SKILL.md"), "gemini\n");
  await symlink(
    path.join(claudeConfigDir, "skills", "gstack", "SKILL.md"),
    path.join(claudeConfigDir, "skills", "gstack-wrapper", "SKILL.md")
  );

  const bundle = await buildPortableAgentSetupBundle({
    homeDir,
    codexHomeDir,
    claudeConfigDir,
    geminiConfigDir,
    tempDir: root
  });
  try {
    assert.equal(
      await readFile(path.join(bundle.localPath, "codex", "skills", "codex-custom", "SKILL.md"), "utf8"),
      "codex\n"
    );
    assert.equal(
      await readFile(path.join(bundle.localPath, "claude", "skills", "claude-custom", "SKILL.md"), "utf8"),
      "claude\n"
    );
    assert.equal(
      await readFile(path.join(bundle.localPath, "codex", "skills", "gstack", "SKILL.md"), "utf8"),
      "codex gstack\n"
    );
    assert.equal(
      await readFile(path.join(bundle.localPath, "claude", "skills", "gstack", "SKILL.md"), "utf8"),
      "claude gstack\n"
    );
    assert.equal(
      await readFile(path.join(bundle.localPath, "claude", "skills", "gstack-wrapper", "SKILL.md"), "utf8"),
      "claude gstack\n"
    );
    assert.equal(
      await readFile(path.join(bundle.localPath, "gemini", "skills", "gemini-custom", "SKILL.md"), "utf8"),
      "gemini\n"
    );
    assert.doesNotMatch(JSON.stringify(bundle.manifest), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await bundle.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("portable config sanitizers keep declarations but not secrets or local paths", () => {
  const codex = sanitizeCodexPortableConfig([
    "[mcp_servers.safe]",
    "command = \"npx\"",
    "args = [\"-y\", \"server\"]",
    "[mcp_servers.safe.env]",
    "API_KEY = \"secret\"",
    "[mcp_servers.secret_header]",
    "authorization = \"Bearer secret\"",
    "[mcp_servers.inline_header]",
    "http_headers = { Authorization = \"Bearer secret\" }",
    "[mcp_servers.environment_header]",
    "url = \"https://example.test/mcp\"",
    "[mcp_servers.environment_header.env_http_headers]",
    "Authorization = \"DOCS_TOKEN\"",
    "[mcp_servers.accord_agents]",
    "url = \"https://wrong.example.test/mcp\"",
    "[mcp_servers.raw_header_table]",
    "url = \"https://example.test/mcp\"",
    "[mcp_servers.raw_header_table.http_headers]",
    "Authorization = \"Bearer secret\"",
    "[mcp_servers.multiline]",
    "args = [",
    "  \"server\"",
    "]",
    "[marketplaces.local]",
    "source = \"~/plugins\"",
    "[features]",
    "js_repl = false"
  ].join("\n"));
  assert.match(codex, /mcp_servers\.safe/);
  assert.match(codex, /environment_header\.env_http_headers/);
  assert.match(codex, /\[features\]/);
  assert.doesNotMatch(codex, /API_KEY|secret_header|inline_header|raw_header_table|multiline|marketplaces\.local|wrong\.example|Bearer secret/);

  assert.deepEqual(
    sanitizeClaudePortableSettings({ enabledPlugins: { yes: true, no: false, invalid: "true" }, model: "ignored" }),
    { enabledPlugins: { no: false, yes: true } }
  );
  assert.deepEqual(sanitizeClaudeMcpServers({
    safe: { command: "npx", args: ["-y", "server"], env: { API_KEY: "secret" } },
    environmentMap: { command: "npx", env: { API_KEY: "${DOCS_TOKEN}" } },
    environmentToken: { command: "npx", args: ["server", "--token", "${DOCS_TOKEN}"] },
    local: { command: "./local-server" },
    homePath: { command: "/home/alice/bin/server" },
    homebrewPath: { command: "/opt/homebrew/bin/server" },
    rawArgument: { command: "npx", args: ["server", "--token", "raw-secret"] },
    rawCredential: { command: "npx", args: ["server", "sk-live-private-value"] },
    rawHeader: { url: "https://example.test", headers: { Authorization: "Bearer secret" } },
    rawUrl: { url: "https://example.test/mcp?token=raw-secret" }
  }), {
    environmentMap: { command: "npx", env: { API_KEY: "${DOCS_TOKEN}" } },
    environmentToken: { command: "npx", args: ["server", "--token", "${DOCS_TOKEN}"] },
    safe: { command: "npx", args: ["-y", "server"] }
  });
});

test("portable invocation configuration is bounded below worker argv limits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-config-budget-test-"));
  const homeDir = path.join(root, "home");
  await mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await writeFile(path.join(homeDir, ".codex", "config.toml"), [
    "[plugins.oversized]",
    `source = "${"x".repeat(70 * 1024)}"`
  ].join("\n"));
  try {
    await assert.rejects(
      buildPortableAgentSetupBundle({ homeDir, tempDir: root }),
      /configuration exceeds 64 KB/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote activation replaces managed setup reversibly and restores stale targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-activation-test-"));
  const sourceHome = path.join(root, "source-home");
  const workerHome = path.join(root, "worker-home");
  const remoteBundle = path.join(root, "remote", "bundle");
  const remoteState = path.join(root, "remote", "state.json");
  const skillPath = path.join(sourceHome, ".codex", "skills", "review");
  const workerSkillPath = path.join(workerHome, ".codex", "skills", "review");
  await mkdir(skillPath, { recursive: true });
  await mkdir(workerSkillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "portable\n");
  await writeFile(path.join(workerSkillPath, "SKILL.md"), "worker-original\n");

  const first = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await cp(first.localPath, remoteBundle, { recursive: true });
    await activate(remoteBundle, remoteState, workerHome);
    assert.equal((await lstat(workerSkillPath)).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(workerSkillPath, "SKILL.md"), "utf8"), "portable\n");
    assert.equal(path.resolve(path.dirname(workerSkillPath), await readlink(workerSkillPath)), path.join(remoteBundle, "codex", "skills", "review"));
  } finally {
    await first.cleanup();
  }

  await rm(skillPath, { recursive: true, force: true });
  const second = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await rm(remoteBundle, { recursive: true, force: true });
    await cp(second.localPath, remoteBundle, { recursive: true });
    await activate(remoteBundle, remoteState, workerHome);
    assert.equal((await lstat(workerSkillPath)).isDirectory(), true);
    assert.equal(await readFile(path.join(workerSkillPath, "SKILL.md"), "utf8"), "worker-original\n");
  } finally {
    await second.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote activation preserves an unmanaged dangling skill symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-dangling-link-test-"));
  const sourceHome = path.join(root, "source-home");
  const workerHome = path.join(root, "worker-home");
  const remoteBundle = path.join(root, "remote", "bundle");
  const remoteState = path.join(root, "remote", "state.json");
  const sourceSkill = path.join(sourceHome, ".codex", "skills", "review");
  const workerSkill = path.join(workerHome, ".codex", "skills", "review");
  const originalTarget = path.join(workerHome, "missing-skill");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.dirname(workerSkill), { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "portable\n");
  await symlink(originalTarget, workerSkill);

  const first = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await cp(first.localPath, remoteBundle, { recursive: true });
    await activate(remoteBundle, remoteState, workerHome);
    assert.equal(await readFile(path.join(workerSkill, "SKILL.md"), "utf8"), "portable\n");
  } finally {
    await first.cleanup();
  }

  await rm(sourceSkill, { recursive: true, force: true });
  const second = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await rm(remoteBundle, { recursive: true, force: true });
    await cp(second.localPath, remoteBundle, { recursive: true });
    await activate(remoteBundle, remoteState, workerHome);
    assert.equal((await lstat(workerSkill)).isSymbolicLink(), true);
    assert.equal(await readlink(workerSkill), originalTarget);
  } finally {
    await second.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote activation installs Gemini skills under its native global root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-gemini-activation-test-"));
  const sourceHome = path.join(root, "source-home");
  const workerHome = path.join(root, "worker-home");
  const remoteBundle = path.join(root, "remote", "bundle");
  const remoteState = path.join(root, "remote", "state.json");
  const sourceSkill = path.join(sourceHome, ".gemini", "config", "skills", "qa-proof");
  const workerSkill = path.join(workerHome, ".gemini", "config", "skills", "qa-proof");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "gemini portable\n");

  const bundle = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await cp(bundle.localPath, remoteBundle, { recursive: true });
    await activate(remoteBundle, remoteState, workerHome);
    assert.equal((await lstat(workerSkill)).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(workerSkill, "SKILL.md"), "utf8"), "gemini portable\n");
  } finally {
    await bundle.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote activation rejects unsafe prior state before touching worker files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-state-test-"));
  const sourceHome = path.join(root, "source-home");
  const workerHome = path.join(root, "worker-home");
  const remoteBundle = path.join(root, "remote", "bundle");
  const remoteState = path.join(root, "remote", "state.json");
  const victim = path.join(root, "victim.txt");
  await mkdir(path.join(sourceHome, ".codex", "skills", "review"), { recursive: true });
  await writeFile(path.join(sourceHome, ".codex", "skills", "review", "SKILL.md"), "portable\n");
  await writeFile(victim, "keep-me\n");

  const bundle = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await cp(bundle.localPath, remoteBundle, { recursive: true });
    await writeFile(remoteState, JSON.stringify({
      version: 1,
      fingerprint: "old",
      links: [{ source: path.join(remoteBundle, "manifest.json"), target: victim }]
    }));
    await assert.rejects(activate(remoteBundle, remoteState, workerHome));
    assert.equal(await readFile(victim, "utf8"), "keep-me\n");
  } finally {
    await bundle.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote activation rolls back earlier links when a later target fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-rollback-test-"));
  const sourceHome = path.join(root, "source-home");
  const workerHome = path.join(root, "worker-home");
  const remoteBundle = path.join(root, "remote", "bundle");
  const remoteState = path.join(root, "remote", "state.json");
  const sourceSkill = path.join(sourceHome, ".codex", "skills", "first");
  const workerSkills = path.join(workerHome, ".codex", "skills");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(workerSkills, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "portable\n");
  await writeFile(path.join(workerSkills, "blocked"), "not-a-directory\n");

  const bundle = await buildPortableAgentSetupBundle({ homeDir: sourceHome, tempDir: root });
  try {
    await cp(bundle.localPath, remoteBundle, { recursive: true });
    const manifestPath = path.join(remoteBundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.links.push({
      source: "codex/skills/first",
      root: "codex",
      target: "skills/blocked/child"
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await assert.rejects(activate(remoteBundle, remoteState, workerHome));
    await assert.rejects(lstat(path.join(workerSkills, "first")));
    assert.equal(await readFile(path.join(workerSkills, "blocked"), "utf8"), "not-a-directory\n");
    await assert.rejects(readFile(remoteState, "utf8"));
  } finally {
    await bundle.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote setup sync skips unchanged setup and resyncs changed setup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-portable-sync-test-"));
  const homeDir = path.join(root, "home");
  const skillDir = path.join(homeDir, ".codex", "skills", "review");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "first\n");
  let remoteManifest: Record<string, unknown> | undefined;
  let remoteState: Record<string, unknown> | undefined;
  let activations = 0;
  let uploads = 0;
  const mirrorSync: RemoteMirrorSyncRunner = {
    async syncUp(request) {
      uploads += 1;
      remoteManifest = JSON.parse(await readFile(path.join(request.localPath, "manifest.json"), "utf8"));
    },
    async syncDown() {
      throw new Error("unexpected sync down");
    }
  };
  const commandRunner = async (command: string, args: string[], options?: Parameters<typeof runCommand>[2]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (remoteCommand.includes("manifest.json") && remoteCommand.includes("state.json")) {
        return commandResult(command, args, `${JSON.stringify(remoteManifest ?? {})}\n${JSON.stringify(remoteState ?? {})}`);
      }
      if (remoteCommand.includes("node - --")) {
        assert.match(options?.input ?? "", /managed-portable-setup-target-modified/);
        activations += 1;
        remoteState = { fingerprint: remoteManifest?.fingerprint };
        return commandResult(command, args, JSON.stringify({ ok: true, fingerprint: remoteManifest?.fingerprint }));
      }
      throw new Error(`Unexpected command: ${remoteCommand}`);
  };
  const createSync = () => new DefaultRemoteAgentSetupSync({
    homeDir,
    tempDir: root,
    mirrorSync,
    commandRunner
  });
  const sync = createSync();
  try {
    const worker = { host: "worker.example", workerRoot: "/srv/worker" };
    const first = await sync.sync({ worker });
    const unchanged = await sync.sync({ worker });
    assert.equal(unchanged.fingerprint, first.fingerprint);
    assert.equal(activations, 1);

    const skillFile = path.join(skillDir, "SKILL.md");
    const originalStats = await lstat(skillFile);
    await writeFile(skillFile, "other\n");
    await utimes(skillFile, originalStats.atime, originalStats.mtime);
    const changed = await sync.sync({ worker });
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.equal(activations, 2);

    await rm(skillDir, { recursive: true, force: true });
    const removed = await sync.sync({ worker });
    assert.notEqual(removed.fingerprint, changed.fingerprint);
    assert.equal(activations, 3);

    const afterRestart = await createSync().sync({ worker });
    assert.equal(afterRestart.fingerprint, removed.fingerprint);
    assert.equal(activations, 3);
    assert.equal(uploads, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function activate(bundlePath: string, statePath: string, workerHome: string): Promise<void> {
  const result = await runCommand(process.execPath, ["-", "--", bundlePath, statePath], {
    input: remotePortableSetupActivationScript(),
    env: { ...process.env, HOME: workerHome },
    timeoutMs: 10_000
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    fingerprint: JSON.parse(await readFile(path.join(bundlePath, "manifest.json"), "utf8")).fingerprint
  });
}

function commandResult(command: string, args: string[], stdout: string) {
  return {
    command,
    args,
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false
  };
}
