import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppSkillsService, parseSkillFrontmatter, stripOuterMarkdownFence } from "./appSkills";
import type { AgentHealth, ChatProviderKind } from "../../shared/types";

const FIXED_NOW = new Date("2026-05-17T12:00:00.000Z");

const CODEX_AGENT: AgentHealth = {
  kind: "codex-cli",
  label: "Codex CLI",
  installed: true,
  path: "/usr/local/bin/codex"
};

const CLAUDE_AGENT: AgentHealth = {
  kind: "claude-code",
  label: "Claude Code",
  installed: true,
  path: "/usr/local/bin/claude"
};

const MISSING_CLAUDE_AGENT: AgentHealth = {
  kind: "claude-code",
  label: "Claude Code",
  installed: false
};

test("parses participant reply skill frontmatter without stale reply-tool guidance", async () => {
  const skillPath = path.join(process.cwd(), "src/main/appSkills/app-chat-reply/SKILL.md");
  const raw = await readFile(skillPath, "utf8");
  assert.equal(raw.startsWith("````"), false);
  const stripped = stripOuterMarkdownFence(raw);
  assert.ok(stripped.startsWith("---\n"));
  const parsed = parseSkillFrontmatter(stripped);
  assert.equal(parsed.name, "app-chat-reply");
  assert.ok(parsed.description.includes("Reply to a participant request"));
  assert.match(parsed.body, /answer directly in the\s+active request thread/);
  assert.ok(parsed.body.includes("Ask for clarification"));
  assert.doesNotMatch(parsed.body, /Plain chat messages do not resume the requester/);
  assert.doesNotMatch(parsed.body, /app_chat_reply_to_participant_request/);
  assert.doesNotMatch(parsed.body, /app_chat_get_pending_requests/);
});

test("parses participant request skill frontmatter", async () => {
  const skillPath = path.join(process.cwd(), "src/main/appSkills/app-chat-request/SKILL.md");
  const raw = await readFile(skillPath, "utf8");
  const parsed = parseSkillFrontmatter(stripOuterMarkdownFence(raw));

  assert.equal(parsed.name, "app-chat-request");
  assert.ok(parsed.description.includes("participant request MCP tool"));
  assert.ok(parsed.body.includes("app_chat_request_participants"));
  assert.ok(parsed.body.includes("app_chat_get_participant_request_status"));
});

test("renders only installed providers and later adds newly detected providers", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("first body"));
    const service = serviceFor(sourceRoot, homeDir);

    const codexOnly = await service.reconcileAgents([CODEX_AGENT, MISSING_CLAUDE_AGENT]);
    assert.equal(codexOnly.find((agent) => agent.kind === "codex-cli")?.appSkillSync?.status, "synced");
    assert.equal(await exists(path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/SKILL.md")), true);
    assert.equal(await exists(path.join(homeDir, ".claude/skills/accordagents-app-chat-reply/SKILL.md")), false);

    const both = await service.reconcileAgents([CODEX_AGENT, CLAUDE_AGENT]);
    assert.equal(both.find((agent) => agent.kind === "claude-code")?.appSkillSync?.status, "synced");
    assert.equal(await exists(path.join(homeDir, ".claude/skills/accordagents-app-chat-reply/SKILL.md")), true);
  });
});

test("syncs multiple bundled skills to Codex and Claude", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("reply body"));
    await writeSkill(sourceRoot, "app-chat-request", requestSkillText("request body"));
    const service = serviceFor(sourceRoot, homeDir);

    const result = await service.reconcileAgents([CODEX_AGENT, CLAUDE_AGENT]);

    assert.equal(result.find((agent) => agent.kind === "codex-cli")?.appSkillSync?.status, "synced");
    assert.equal(result.find((agent) => agent.kind === "codex-cli")?.appSkillSync?.skillCount, 2);
    assert.equal(result.find((agent) => agent.kind === "claude-code")?.appSkillSync?.status, "synced");
    assert.equal(result.find((agent) => agent.kind === "claude-code")?.appSkillSync?.skillCount, 2);
    assert.equal(await exists(path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/SKILL.md")), true);
    assert.equal(await exists(path.join(homeDir, ".codex/skills/accordagents-app-chat-request/SKILL.md")), true);
    assert.equal(await exists(path.join(homeDir, ".claude/skills/accordagents-app-chat-reply/SKILL.md")), true);
    assert.equal(await exists(path.join(homeDir, ".claude/skills/accordagents-app-chat-request/SKILL.md")), true);

    const codexRequestSkill = await readFile(path.join(homeDir, ".codex/skills/accordagents-app-chat-request/SKILL.md"), "utf8");
    const claudeRequestSkill = await readFile(path.join(homeDir, ".claude/skills/accordagents-app-chat-request/SKILL.md"), "utf8");
    assert.equal(parseSkillFrontmatter(codexRequestSkill).name, "accordagents-app-chat-request");
    assert.equal(parseSkillFrontmatter(claudeRequestSkill).name, "accordagents-app-chat-request");
  });
});

test("Codex rendering uses name and description frontmatter plus openai metadata", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("codex body"));
    const service = serviceFor(sourceRoot, homeDir);
    await service.reconcileAgents([CODEX_AGENT]);

    const skill = await readFile(path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/SKILL.md"), "utf8");
    const parsed = parseSkillFrontmatter(skill);
    assert.equal(parsed.name, "accordagents-app-chat-reply");
    assert.ok(parsed.description.length <= 1024);
    assert.match(parsed.frontmatter, /^name: accordagents-app-chat-reply$/m);
    assert.match(parsed.frontmatter, /^description: >/m);
    assert.doesNotMatch(parsed.frontmatter, /^owner:/m);

    const metadata = await readFile(path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/agents/openai.yaml"), "utf8");
    assert.match(metadata, /display_name: "accordagents-app-chat-reply"/);
    assert.match(metadata, /allow_implicit_invocation: true/);
  });
});

test("same source and render hashes do not rewrite the marker", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("stable body"));
    const service = serviceFor(sourceRoot, homeDir);
    await service.reconcileAgents([CODEX_AGENT]);
    const markerPath = path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/.accordagents-generated.json");
    const before = await readFile(markerPath, "utf8");

    const result = await service.reconcileAgents([CODEX_AGENT]);
    const after = await readFile(markerPath, "utf8");

    assert.equal(result[0].appSkillSync?.status, "skipped");
    assert.equal(after, before);
  });
});

test("updates an existing app-owned folder and recovers from an old marker", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("old body"));
    const service = serviceFor(sourceRoot, homeDir);
    await service.reconcileAgents([CODEX_AGENT]);
    const markerPath = path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/.accordagents-generated.json");
    const oldMarker = JSON.parse(await readFile(markerPath, "utf8")) as { renderHash: string };

    await writeSkill(sourceRoot, "app-chat-reply", skillText("new body"));
    await writeFile(path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/SKILL.md"), "partial crash content", "utf8");
    await service.reconcileAgents([CODEX_AGENT]);

    const skill = await readFile(path.join(homeDir, ".codex/skills/accordagents-app-chat-reply/SKILL.md"), "utf8");
    const newMarker = JSON.parse(await readFile(markerPath, "utf8")) as { renderHash: string };
    assert.ok(skill.includes("new body"));
    assert.notEqual(newMarker.renderHash, oldMarker.renderHash);
  });
});

test("does not overwrite an unmarked colliding folder", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("app body"));
    const target = path.join(homeDir, ".codex/skills/accordagents-app-chat-reply");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "user content", "utf8");

    const result = await serviceFor(sourceRoot, homeDir).reconcileAgents([CODEX_AGENT]);

    assert.equal(result[0].appSkillSync?.status, "collision");
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "user content");
  });
});

test("skips malformed manifests and malformed markers", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("app body"));
    const root = path.join(homeDir, ".codex/skills");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, ".accordagents-skills.json"), "{bad json", "utf8");

    const manifestResult = await serviceFor(sourceRoot, homeDir).reconcileAgents([CODEX_AGENT]);
    assert.equal(manifestResult[0].appSkillSync?.status, "collision");
    assert.equal(await exists(path.join(root, "accordagents-app-chat-reply")), false);
  });

  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("app body"));
    const target = path.join(homeDir, ".codex/skills/accordagents-app-chat-reply");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, ".accordagents-generated.json"), "{bad json", "utf8");

    const markerResult = await serviceFor(sourceRoot, homeDir).reconcileAgents([CODEX_AGENT]);
    assert.equal(markerResult[0].appSkillSync?.status, "collision");
  });
});

test("skips symlink targets", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot, tempRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("app body"));
    const root = path.join(homeDir, ".codex/skills");
    const linkedTarget = path.join(tempRoot, "linked-target");
    await mkdir(root, { recursive: true });
    await mkdir(linkedTarget, { recursive: true });
    await symlink(linkedTarget, path.join(root, "accordagents-app-chat-reply"));

    const result = await serviceFor(sourceRoot, homeDir).reconcileAgents([CODEX_AGENT]);
    assert.equal(result[0].appSkillSync?.status, "collision");
  });
});

test("cleans removed app-owned skills and stale hidden temp dirs", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("kept body"));
    await writeSkill(sourceRoot, "old-skill", skillText("removed body"));
    const service = serviceFor(sourceRoot, homeDir);
    await service.reconcileAgents([CODEX_AGENT]);
    assert.equal(await exists(path.join(homeDir, ".codex/skills/accordagents-old-skill/SKILL.md")), true);

    await rm(path.join(sourceRoot, "old-skill"), { recursive: true, force: true });
    const staleTmp = path.join(homeDir, ".codex/skills/.accordagents-tmp-old");
    await mkdir(staleTmp, { recursive: true });
    await utimes(staleTmp, new Date("2026-05-17T10:00:00.000Z"), new Date("2026-05-17T10:00:00.000Z"));

    await service.reconcileAgents([CODEX_AGENT]);
    assert.equal(await exists(path.join(homeDir, ".codex/skills/accordagents-old-skill")), false);
    assert.equal(await exists(staleTmp), false);
  });
});

test("rejects traversal paths from stale ownership metadata", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    const root = path.join(homeDir, ".codex/skills");
    const target = path.join(root, "accordagents-old-skill");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(root, "evil"), "do not remove", "utf8");
    await writeFile(path.join(root, ".accordagents-skills.json"), JSON.stringify({
      schemaVersion: 1,
      rendererVersion: "app-skills-v1",
      owner: "accordagents",
      provider: "codex-cli",
      generatedFolders: [{
        canonicalId: "old-skill",
        folderName: "accordagents-old-skill",
        sourceHash: "old",
        renderHash: "old"
      }],
      updatedAt: FIXED_NOW.toISOString()
    }, null, 2), "utf8");
    await writeFile(path.join(target, ".accordagents-generated.json"), JSON.stringify({
      schemaVersion: 1,
      rendererVersion: "app-skills-v1",
      owner: "accordagents",
      canonicalId: "old-skill",
      folderName: "accordagents-old-skill",
      provider: "codex-cli",
      generatedFiles: ["../evil"],
      sourceHash: "old",
      renderHash: "old",
      appVersion: "test",
      updatedAt: FIXED_NOW.toISOString()
    }, null, 2), "utf8");

    const result = await serviceFor(sourceRoot, homeDir).reconcileAgents([CODEX_AGENT]);

    assert.equal(result[0].appSkillSync?.status, "collision");
    assert.equal(await readFile(path.join(root, "evil"), "utf8"), "do not remove");
  });
});

test("public app skill keeps its frontmatter name, strips visibility, and marks marker+manifest public", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "accord", publicSkillText("accord body"));
    await serviceFor(sourceRoot, homeDir).reconcileAgents([CLAUDE_AGENT]);

    const skillsRoot = path.join(homeDir, ".claude", "skills");
    const folder = path.join(skillsRoot, "accordagents-accord");
    const skillMd = await readFile(path.join(folder, "SKILL.md"), "utf8");
    const parsed = parseSkillFrontmatter(skillMd);
    assert.equal(parsed.name, "accord");
    assert.doesNotMatch(skillMd, /visibility:/);

    const marker = JSON.parse(await readFile(path.join(folder, ".accordagents-generated.json"), "utf8"));
    assert.equal(marker.visibility, "public");
    assert.equal(marker.folderName, "accordagents-accord");

    const manifest = JSON.parse(await readFile(path.join(skillsRoot, ".accordagents-skills.json"), "utf8"));
    const entry = manifest.generatedFolders.find((item: { folderName: string }) => item.folderName === "accordagents-accord");
    assert.equal(entry.visibility, "public");
  });
});

test("public app skill renders the public name in Codex SKILL.md and openai.yaml", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "accord", publicSkillText("accord body"));
    await serviceFor(sourceRoot, homeDir).reconcileAgents([CODEX_AGENT]);

    const folder = path.join(homeDir, ".codex", "skills", "accordagents-accord");
    const skillMd = await readFile(path.join(folder, "SKILL.md"), "utf8");
    assert.equal(parseSkillFrontmatter(skillMd).name, "accord");

    const openaiYaml = await readFile(path.join(folder, "agents", "openai.yaml"), "utf8");
    assert.match(openaiYaml, /display_name: "accord"/);
    assert.doesNotMatch(openaiYaml, /accordagents-accord/);
  });
});

test("internal app skill is renamed to the generated name and marked internal", async () => {
  await withTempWorkspace(async ({ homeDir, sourceRoot }) => {
    await writeSkill(sourceRoot, "app-chat-reply", skillText("reply body"));
    await serviceFor(sourceRoot, homeDir).reconcileAgents([CLAUDE_AGENT]);

    const folder = path.join(homeDir, ".claude", "skills", "accordagents-app-chat-reply");
    const parsed = parseSkillFrontmatter(await readFile(path.join(folder, "SKILL.md"), "utf8"));
    assert.equal(parsed.name, "accordagents-app-chat-reply");

    const marker = JSON.parse(await readFile(path.join(folder, ".accordagents-generated.json"), "utf8"));
    assert.equal(marker.visibility, "internal");
  });
});

async function withTempWorkspace(run: (workspace: { tempRoot: string; homeDir: string; sourceRoot: string }) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-app-skills-test-"));
  const homeDir = path.join(tempRoot, "home");
  const sourceRoot = path.join(tempRoot, "source");
  await mkdir(homeDir, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  try {
    await run({ tempRoot, homeDir, sourceRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function serviceFor(sourceRoot: string, homeDir: string): AppSkillsService {
  return new AppSkillsService({
    sourceRoot,
    homeDir,
    appVersion: "test",
    now: () => FIXED_NOW,
    tmpMaxAgeMs: 60_000
  });
}

async function writeSkill(sourceRoot: string, id: string, content: string): Promise<void> {
  const dir = path.join(sourceRoot, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}

function skillText(body: string): string {
  return [
    "---",
    "name: app-chat-reply",
    "description: >",
    "  Reply to a participant request that was addressed to your handle.",
    "---",
    "",
    "# Reply",
    "",
    body,
    ""
  ].join("\n");
}

function publicSkillText(body: string): string {
  return [
    "---",
    "name: accord",
    "visibility: public",
    "description: >",
    "  Facilitate a skeptical multi-participant accord discussion.",
    "---",
    "",
    "# Accord",
    "",
    body,
    ""
  ].join("\n");
}

function requestSkillText(body: string): string {
  return [
    "---",
    "name: app-chat-request",
    "description: >",
    "  Ask another AccordAgents chat participant using the participant request MCP tool.",
    "---",
    "",
    "# Request",
    "",
    body,
    ""
  ].join("\n");
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath, fsConstants.F_OK).then(() => true, () => false);
}
