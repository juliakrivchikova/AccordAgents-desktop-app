import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginService } from "./plugins";
import { UserSkillsService } from "./userSkills";

test("maps marketplace plugins to installed local skills when names match", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeSkill(path.join(homeDir, ".agents/skills/github"), "github", "Use GitHub", "body");
    await writeMarketplacePlugin(homeDir, "github", {
      name: "github",
      description: "GitHub tools",
      skills: [{ name: "github" }]
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list({ query: "git" });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].displayName, "github");
    assert.equal(result.plugins[0].providerKind, "codex-cli");
    assert.equal(result.plugins[0].invocation.kind, "skill-mention");
    assert.equal(result.plugins[0].providerAvailability.find((item) => item.providerKind === "codex-cli")?.status, "invocable");
    assert.equal(result.plugins[0].providerAvailability.some((item) => item.providerKind === "claude-code"), false);
  });
});

test("classifies prompt plugins as prompt insertion without provider config writes", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeMarketplacePlugin(homeDir, "writer", {
      name: "writer",
      interface: {
        displayName: "Writer",
        shortDescription: "Drafts copy",
        defaultPrompt: ["Draft a concise update."]
      }
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list();

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].invocation.kind, "prompt-insert");
    assert.equal(result.plugins[0].providerAvailability.length, 0);
  });
});

test("discovers nested Codex cache plugin manifests as bundled sources", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeCachePlugin(homeDir, ["openai-curated-remote", "github", "0.1.5"], {
      name: "github",
      description: "GitHub tools",
      interface: {
        displayName: "GitHub",
        shortDescription: "Triage PRs and issues",
        defaultPrompt: ["Inspect a GitHub pull request."]
      }
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list({ query: "git" });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].name, "github");
    assert.equal(result.plugins[0].displayName, "GitHub");
    assert.equal(result.plugins[0].sourceScope, "bundled");
    assert.equal(result.plugins[0].sourceLabel, "OpenAI plugin cache");
    assert.equal(result.plugins[0].invocation.kind, "prompt-insert");
  });
});

test("returns safe local icon assets from Codex plugin manifests", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    const pluginRoot = await writeCachePlugin(homeDir, ["openai-curated", "github", "d6169bef"], {
      name: "github",
      interface: {
        displayName: "GitHub",
        shortDescription: "Triage PRs and issues",
        composerIcon: "./assets/github-small.svg",
        logo: "./assets/logo.png",
        brandColor: "#24292F",
        defaultPrompt: ["Inspect a GitHub pull request."]
      }
    });
    await mkdir(path.join(pluginRoot, "assets"), { recursive: true });
    await writeFile(path.join(pluginRoot, "assets", "github-small.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" />", "utf8");
    await writeFile(path.join(pluginRoot, "assets", "logo.png"), "fake", "utf8");
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list({ query: "github" });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].brandColor, "#24292F");
    assert.match(result.plugins[0].iconUrl ?? "", /^file:\/\//);
    assert.match(result.plugins[0].iconUrl ?? "", /github-small\.svg$/);
  });
});

test("keeps provider-specific cards and backfills icon metadata across matching plugin names", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    const codexPluginRoot = await writeCachePlugin(homeDir, ["openai-curated-remote", "slack", "0.1.3"], {
      name: "slack",
      interface: {
        displayName: "Slack",
        composerIcon: "./assets/slack-small.svg",
        defaultPrompt: ["Summarize Slack."]
      }
    });
    await mkdir(path.join(codexPluginRoot, "assets"), { recursive: true });
    await writeFile(path.join(codexPluginRoot, "assets", "slack-small.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" />", "utf8");
    const claudePluginRoot = await writeClaudeCachePlugin(path.join(homeDir, ".claude/plugins/cache"), ["claude-plugins-official", "slack", "1.1.0"], {
      name: "slack",
      description: "Slack integration",
      version: "1.1.0"
    });
    await writeClaudeInstalledPlugins(homeDir, {
      "slack@claude-plugins-official": [{
        scope: "user",
        installPath: claudePluginRoot,
        version: "1.1.0",
        installedAt: "2026-06-20T21:23:02.048Z"
      }]
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list({ query: "slack" });

    assert.equal(result.plugins.length, 2);
    const byProvider = new Map(result.plugins.map((plugin) => [plugin.providerKind, plugin]));
    assert.deepEqual(byProvider.get("codex-cli")?.installedProviderKinds, []);
    assert.deepEqual(byProvider.get("claude-code")?.installedProviderKinds, ["claude-code"]);
    assert.equal(byProvider.get("claude-code")?.description, "Slack integration");
    assert.match(byProvider.get("codex-cli")?.iconUrl ?? "", /slack-small\.svg$/);
    assert.match(byProvider.get("claude-code")?.iconUrl ?? "", /slack-small\.svg$/);
  });
});

test("deduplicates repeated Codex cache manifests by plugin name", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    const githubManifest = {
      name: "github",
      description: "GitHub tools",
      interface: {
        displayName: "GitHub",
        shortDescription: "Triage PRs and issues",
        defaultPrompt: ["Inspect a GitHub pull request."]
      }
    };
    await writeCachePlugin(homeDir, ["openai-curated", "github", "d6169bef"], githubManifest);
    await writeCachePlugin(homeDir, ["openai-curated-remote", "github", "0.1.5"], githubManifest);
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list({ query: "github" });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].name, "github");
    assert.equal(result.plugins[0].displayName, "GitHub");
    assert.equal(result.plugins[0].sourceScope, "bundled");
    assert.equal(result.plugins[0].sourceLabel, "OpenAI plugin cache");
  });
});

test("marks Codex config and remote plugins as installed", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeCodexConfig(homeDir, [
      "github@openai-curated",
      "browser@openai-bundled",
      "playwright@claude-plugins-official"
    ]);
    await writeCachePlugin(homeDir, ["openai-curated", "github", "d6169bef"], {
      name: "github",
      interface: {
        displayName: "GitHub",
        defaultPrompt: ["Inspect a GitHub pull request."]
      }
    });
    await writeCachePlugin(homeDir, ["openai-bundled", "browser", "1.0.0"], {
      name: "browser",
      interface: {
        displayName: "Browser",
        defaultPrompt: ["Open a browser."]
      }
    });
    await writeClaudeCachePlugin(path.join(homeDir, ".codex/plugins/cache"), ["claude-plugins-official", "playwright", "local"], {
      name: "playwright",
      description: "Browser automation"
    });
    await writeCodexRemoteInstall(homeDir, ["openai-curated-remote", "slack"]);
    await writeCachePlugin(homeDir, ["openai-curated-remote", "slack", "0.1.2"], {
      name: "slack",
      interface: {
        displayName: "Slack",
        defaultPrompt: ["Summarize Slack."]
      }
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list();
    const byName = new Map(result.plugins.map((plugin) => [plugin.name, plugin]));

    assert.deepEqual(byName.get("github")?.installedProviderKinds, ["codex-cli"]);
    assert.deepEqual(byName.get("browser")?.installedProviderKinds, ["codex-cli"]);
    assert.deepEqual(byName.get("playwright")?.installedProviderKinds, ["codex-cli"]);
    assert.deepEqual(byName.get("slack")?.installedProviderKinds, ["codex-cli"]);
    assert.equal(byName.get("slack")?.installRecords[0]?.sourceLabel, "Codex remote install");
  });
});

test("marks Claude installed plugins from installed_plugins.json", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeClaudeInstalledPlugins(homeDir, {
      "skill-creator@claude-plugins-official": [{
        scope: "user",
        installPath: path.join(homeDir, ".claude/plugins/cache/claude-plugins-official/skill-creator/unknown"),
        version: "unknown",
        installedAt: "2026-07-06T20:07:33.422Z"
      }],
      "playwright@claude-plugins-official": [{
        scope: "user",
        installPath: path.join(homeDir, ".claude/plugins/cache/claude-plugins-official/playwright/unknown"),
        version: "unknown",
        installedAt: "2026-07-06T20:07:33.413Z"
      }],
      "slack@claude-plugins-official": [{
        scope: "user",
        installPath: path.join(homeDir, ".claude/plugins/cache/claude-plugins-official/slack/1.1.0"),
        version: "1.1.0",
        installedAt: "2026-06-20T21:23:02.048Z"
      }]
    });
    await writeClaudeCachePlugin(path.join(homeDir, ".claude/plugins/cache"), ["claude-plugins-official", "skill-creator", "unknown"], {
      name: "skill-creator",
      description: "Create Claude skills"
    });
    await writeClaudeCachePlugin(path.join(homeDir, ".claude/plugins/cache"), ["claude-plugins-official", "playwright", "unknown"], {
      name: "playwright",
      description: "Browser automation"
    });
    await writeClaudeCachePlugin(path.join(homeDir, ".claude/plugins/cache"), ["claude-plugins-official", "slack", "1.0.0"], {
      name: "slack",
      description: "Old Slack integration",
      version: "1.0.0"
    });
    await writeClaudeCachePlugin(path.join(homeDir, ".claude/plugins/cache"), ["claude-plugins-official", "slack", "1.1.0"], {
      name: "slack",
      description: "Slack integration",
      version: "1.1.0"
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list();
    const byName = new Map(result.plugins.map((plugin) => [plugin.name, plugin]));

    assert.deepEqual(byName.get("skill-creator")?.installedProviderKinds, ["claude-code"]);
    assert.deepEqual(byName.get("playwright")?.installedProviderKinds, ["claude-code"]);
    assert.deepEqual(byName.get("slack")?.installedProviderKinds, ["claude-code"]);
    assert.equal(byName.get("slack")?.displayName, "Slack");
    assert.equal(byName.get("slack")?.description, "Slack integration");
    assert.equal(byName.get("slack")?.installRecords[0]?.version, "1.1.0");
  });
});

test("shows installed Codex plugins even when manifest cache is missing", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeCodexConfig(homeDir, [
      "local-tool",
      "github@openai-curated"
    ]);
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list();
    const byName = new Map(result.plugins.map((plugin) => [plugin.name, plugin]));

    assert.equal(result.plugins.length, 2);
    assert.equal(byName.get("local-tool")?.displayName, "Local Tool");
    assert.equal(byName.get("local-tool")?.description, "Installed plugin");
    assert.equal(byName.get("local-tool")?.providerKind, "codex-cli");
    assert.equal(byName.get("local-tool")?.sourceScope, "personal");
    assert.deepEqual(byName.get("local-tool")?.installedProviderKinds, ["codex-cli"]);
    assert.equal(byName.get("local-tool")?.invocation.kind, "mcp-passive");
    assert.equal(byName.get("local-tool")?.providerAvailability[0]?.status, "invocable");
    assert.equal(byName.get("github")?.sourceScope, "bundled");
  });
});

test("shows installed Claude plugins even when manifest cache is missing", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeClaudeInstalledPlugins(homeDir, {
      "slack@claude-plugins-official": [{
        scope: "user",
        installPath: path.join(homeDir, ".claude/plugins/cache/claude-plugins-official/slack/1.1.0"),
        version: "1.1.0",
        installedAt: "2026-06-20T21:23:02.048Z"
      }]
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list({ query: "slack" });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].name, "slack");
    assert.equal(result.plugins[0].displayName, "Slack");
    assert.equal(result.plugins[0].description, "Installed plugin");
    assert.equal(result.plugins[0].providerKind, "claude-code");
    assert.equal(result.plugins[0].sourceScope, "bundled");
    assert.deepEqual(result.plugins[0].installedProviderKinds, ["claude-code"]);
    assert.equal(result.plugins[0].installRecords[0]?.version, "1.1.0");
    assert.equal(result.plugins[0].providerAvailability[0]?.status, "invocable");
  });
});

test("keeps MCP-only plugins settings-only until setup exists", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    await writeMarketplacePlugin(homeDir, "issue-tools", {
      name: "issue-tools",
      description: "Issue tracker connector",
      mcpServers: {
        issues: {
          command: "issue-mcp"
        }
      }
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list();

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].invocation.kind, "mcp-passive");
    assert.equal(result.plugins[0].providerAvailability.every((item) => item.status === "needs-setup"), true);
  });
});

test("records malformed plugin manifests as diagnostics", async () => {
  await withTempWorkspace(async ({ homeDir }) => {
    const pluginRoot = path.join(homeDir, ".agents/plugins/broken");
    await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "{broken", "utf8");
    await writeJson(path.join(homeDir, ".agents/plugins/marketplace.json"), {
      plugins: [{ name: "broken", source: { path: "broken" } }]
    });
    const userSkills = new UserSkillsService({ homeDir });
    const service = new PluginService({ homeDir, userSkills, now: fixedNow });

    const result = await service.list();

    assert.equal(result.plugins.length, 0);
    assert.equal(result.diagnostics.errors.some((message) => message.includes("broken")), true);
  });
});

async function withTempWorkspace(run: (workspace: { tempRoot: string; homeDir: string }) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-plugins-"));
  const homeDir = path.join(tempRoot, "home");
  await mkdir(homeDir, { recursive: true });
  try {
    await run({ tempRoot, homeDir });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeMarketplacePlugin(homeDir: string, name: string, manifest: Record<string, unknown>): Promise<void> {
  const pluginRoot = path.join(homeDir, ".agents/plugins", name);
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), manifest);
  await writeJson(path.join(homeDir, ".agents/plugins/marketplace.json"), {
    plugins: [{ name, source: { path: name } }]
  });
}

async function writeCachePlugin(homeDir: string, segments: string[], manifest: Record<string, unknown>): Promise<string> {
  const pluginRoot = path.join(homeDir, ".codex/plugins/cache", ...segments);
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), manifest);
  return pluginRoot;
}

async function writeClaudeCachePlugin(cacheRoot: string, segments: string[], manifest: Record<string, unknown>): Promise<string> {
  const pluginRoot = path.join(cacheRoot, ...segments);
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeJson(path.join(pluginRoot, ".claude-plugin/plugin.json"), manifest);
  return pluginRoot;
}

async function writeCodexConfig(homeDir: string, pluginKeys: string[]): Promise<void> {
  const content = pluginKeys
    .map((key) => [`[plugins."${key}"]`, "enabled = true", ""].join("\n"))
    .join("\n");
  await mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await writeFile(path.join(homeDir, ".codex", "config.toml"), content, "utf8");
}

async function writeCodexRemoteInstall(homeDir: string, segments: string[]): Promise<void> {
  const pluginRoot = path.join(homeDir, ".codex/plugins/cache", ...segments);
  await writeJson(path.join(pluginRoot, ".codex-remote-plugin-install.json"), {
    schema_version: 1,
    remote_plugin_id: `plugin_${segments.join("_")}`
  });
}

async function writeClaudeInstalledPlugins(
  homeDir: string,
  plugins: Record<string, Array<Record<string, unknown>>>
): Promise<void> {
  await writeJson(path.join(homeDir, ".claude/plugins/installed_plugins.json"), {
    version: 2,
    plugins
  });
}

async function writeSkill(folder: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
    ""
  ].join("\n"), "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function fixedNow(): Date {
  return new Date("2026-07-06T00:00:00.000Z");
}
