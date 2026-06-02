import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { UserSkillsService } from "./userSkills";
import { ACCORDAGENTS_SKILL_PROOF_NAME, ACCORDAGENTS_SKILL_PROOF_OK, appOwnedSkillProofMarkdown } from "./userSkillProofs";
import type { ChatProviderKind, UserSkillSearchRequest } from "../../shared/types";

const NOW_REQUEST: UserSkillSearchRequest = {
  conversationId: "chat-1",
  query: "",
  content: "",
  limit: 50
};

test("discovers provider frontmatter names and prefers repo-local variant for the target provider", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(homeDir, ".agents/skills/personal-folder"), "qa", "Personal QA", "personal body");
    await writeSkill(path.join(repoPath, ".agents/skills/repo-folder"), "qa", "Repo QA", "repo body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search({ ...NOW_REQUEST, query: "qa" }, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      runRootByProvider: { "codex-cli": repoPath }
    });

    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].displayName, "/qa");
    assert.equal(result.skills[0].frontmatterName, "qa");
    assert.equal(result.skills[0].variants[0].scope, "repo");
    assert.notEqual(result.skills[0].variants[0].sourceKey, path.join(repoPath, ".agents/skills/repo-folder"));
  });
});

test("discovers Codex repo skills from .agents/skills and ignores .codex/skills", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    // Codex's documented convention is <repo>/.agents/skills, not <repo>/.codex/skills.
    await writeSkill(path.join(repoPath, ".agents/skills/troubleshoot"), "troubleshoot", "Troubleshoot", "body");
    await writeSkill(path.join(repoPath, ".codex/skills/legacy"), "legacy", "Legacy", "body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search({ ...NOW_REQUEST }, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      participantProviderKindById: { "codex-1": "codex-cli" },
      runRootByParticipant: { "codex-1": repoPath },
      runRootByProvider: { "codex-cli": repoPath }
    });

    assert.deepEqual(result.skills.map((skill) => skill.frontmatterName), ["troubleshoot"]);
    assert.equal(result.skills[0].capabilityState, "invocable");
  });
});

test("discovers Codex personal skills from both runtime and documented roots", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    // Codex CLI 0.135.0 still injects ~/.codex/skills; current docs list ~/.agents/skills.
    await writeSkill(path.join(homeDir, ".codex/skills/runtime-personal"), "runtime-personal", "Runtime personal", "body");
    await writeSkill(path.join(homeDir, ".agents/skills/documented-personal"), "documented-personal", "Documented personal", "body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search({ ...NOW_REQUEST }, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      participantProviderKindById: { "codex-1": "codex-cli" },
      runRootByParticipant: { "codex-1": repoPath },
      runRootByProvider: { "codex-cli": repoPath }
    });

    assert.deepEqual(result.skills.map((skill) => skill.frontmatterName), ["documented-personal", "runtime-personal"]);
    assert.equal(result.skills.every((skill) => skill.capabilityState === "invocable"), true);
  });
});

test("ranks the exact query match first so the highlighted result is correct", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    // `browse` only matches "qa" via its description; `qa` is the exact name and must rank first.
    await writeSkill(path.join(homeDir, ".agents/skills/browse"), "browse", "Browse the web for QA", "body");
    await writeSkill(path.join(homeDir, ".agents/skills/qa-only"), "qa-only", "QA only", "body");
    await writeSkill(path.join(homeDir, ".agents/skills/qa"), "qa", "QA", "body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search({ ...NOW_REQUEST, query: "qa" }, {
      repoPath,
      target: { hasClearTargets: true, participantIds: ["codex-1"], providerKinds: ["codex-cli"] },
      participantProviderKindById: { "codex-1": "codex-cli" },
      runRootByParticipant: { "codex-1": repoPath }
    });

    assert.deepEqual(result.skills.map((skill) => skill.frontmatterName), ["qa", "qa-only", "browse"]);
  });
});

test("resolveInvocableSkillsForParticipant returns name + real dir for invocable selections only", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(repoPath, ".agents/skills/troubleshoot"), "troubleshoot", "Troubleshoot", "body");
    const service = new UserSkillsService({ homeDir });
    const context = {
      repoPath,
      target: { hasClearTargets: true, participantIds: ["codex-1"], providerKinds: ["codex-cli" as ChatProviderKind] },
      participantProviderKindById: { "codex-1": "codex-cli" as ChatProviderKind },
      runRootByParticipant: { "codex-1": repoPath },
      runRootByProvider: { "codex-cli": repoPath }
    };
    const search = await service.search({ ...NOW_REQUEST, query: "troubleshoot" }, context);
    assert.equal(search.skills.length, 1);

    const resolved = await service.resolveInvocableSkillsForParticipant(search.skills, "codex-cli", context, "codex-1");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].name, "troubleshoot");
    assert.equal(resolved[0].dir, await realpath(path.join(repoPath, ".agents/skills/troubleshoot")));

    // Not invocable when the run root no longer matches the repo (discovery-only) → not resolved.
    const offRepo = await service.resolveInvocableSkillsForParticipant(search.skills, "codex-cli", {
      ...context,
      runRootByParticipant: { "codex-1": undefined },
      runRootByProvider: { "codex-cli": undefined }
    }, "codex-1");
    assert.equal(offRepo.length, 0);
  });
});

test("filters to variants available for every resolved target provider", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(homeDir, ".agents/skills/qa"), "qa", "QA", "codex body");
    await writeSkill(path.join(homeDir, ".claude/skills/qa"), "qa", "QA", "claude body");
    await writeSkill(path.join(homeDir, ".agents/skills/codex-only"), "codex-only", "Codex only", "body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1", "claude-1"],
        providerKinds: ["codex-cli", "claude-code"]
      },
      runRootByProvider: { "codex-cli": repoPath, "claude-code": repoPath }
    });

    assert.deepEqual(result.skills.map((skill) => skill.frontmatterName), ["qa"]);
    assert.deepEqual(result.skills[0].providerKinds, ["claude-code", "codex-cli"]);
    assert.equal(result.skills[0].variants.length, 2);
  });
});

test("keeps repo-local skills discovery-only when no repo run root is active", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(repoPath, ".agents/skills/repo-qa"), "qa", "Repo QA", "repo body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      runRootByProvider: { "codex-cli": undefined }
    });

    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].capabilityState, "discovery-only");
  });
});

test("marks personal skills invocable deterministically without any provider proof", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(homeDir, ".agents/skills/qa"), "qa", "QA", "body");
    const service = new UserSkillsService({ homeDir });
    const context = {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli" as ChatProviderKind]
      },
      participantProviderKindById: { "codex-1": "codex-cli" as ChatProviderKind },
      runRootByParticipant: { "codex-1": repoPath },
      runRootByProvider: { "codex-cli": repoPath }
    };

    const result = await service.search(NOW_REQUEST, context);
    assert.equal(result.skills[0].capabilityState, "invocable");
  });
});

test("keeps personal skills discovery-only until a participant is targeted", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(homeDir, ".agents/skills/qa"), "qa", "QA", "body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: false,
        providerKinds: [],
        participantIds: []
      }
    });

    // No clear target → the skill is still listed for discovery but is not selectable.
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].capabilityState, "discovery-only");
  });
});

test("the app-owned proof fixture is a harmless marker-only skill (QA reference)", () => {
  const normalizedName = ACCORDAGENTS_SKILL_PROOF_NAME.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const normalizedMarker = ACCORDAGENTS_SKILL_PROOF_OK.replace(/[^a-z0-9]/gi, "").toLowerCase();
  assert.equal(normalizedMarker.includes(normalizedName), false);
  for (const provider of ["codex-cli", "claude-code"] as ChatProviderKind[]) {
    const markdown = appOwnedSkillProofMarkdown(provider);
    assert.match(markdown, /accordagents-skill-proof/);
    assert.match(markdown, new RegExp(ACCORDAGENTS_SKILL_PROOF_OK));
  }
});

test("requires repo-local skills to be invocable for every same-provider target participant", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    await writeSkill(path.join(repoPath, ".agents/skills/repo-qa"), "qa", "Repo QA", "repo body");
    const service = new UserSkillsService({ homeDir });

    const result = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-repo", "codex-no-repo"],
        providerKinds: ["codex-cli"]
      },
      participantProviderKindById: {
        "codex-repo": "codex-cli",
        "codex-no-repo": "codex-cli"
      },
      runRootByParticipant: {
        "codex-repo": repoPath,
        "codex-no-repo": undefined
      },
      runRootByProvider: { "codex-cli": undefined }
    });

    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].capabilityState, "discovery-only");
  });
});

test("hides AccordAgents internal generated skills by ownership marker", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    const generated = path.join(homeDir, ".agents/skills/internal-skill");
    await writeSkill(generated, "accordagents-app-chat-request", "Internal", "body");
    await writeFile(path.join(generated, ".accordagents-generated.json"), JSON.stringify({ owner: "accordagents" }), "utf8");
    const service = new UserSkillsService({ homeDir });

    const search = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      runRootByProvider: { "codex-cli": repoPath }
    });
    const diagnostics = await service.diagnostics(repoPath);

    assert.equal(search.skills.length, 0);
    assert.equal(diagnostics.hiddenInternalCount, 1);
  });
});

test("discovers symlinked Codex skill folders", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath, tempRoot }) => {
    const outside = path.join(tempRoot, "outside-skill");
    await writeSkill(outside, "outside", "Outside", "body");
    await mkdir(path.join(homeDir, ".codex/skills"), { recursive: true });
    await symlink(outside, path.join(homeDir, ".codex/skills/outside-link"));
    const service = new UserSkillsService({ homeDir });

    const diagnostics = await service.diagnostics(repoPath);
    const search = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      runRootByProvider: { "codex-cli": repoPath }
    });

    assert.deepEqual(search.skills.map((skill) => skill.frontmatterName), ["outside"]);
    assert.equal(diagnostics.unsafeSymlinkCount, 0);
  });
});

test("discovers symlinked Claude SKILL.md files", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath, tempRoot }) => {
    const outside = path.join(tempRoot, "outside-skill");
    await writeSkill(outside, "qa", "QA", "body");
    const claudeSkillFolder = path.join(homeDir, ".claude/skills/qa");
    await mkdir(claudeSkillFolder, { recursive: true });
    await symlink(path.join(outside, "SKILL.md"), path.join(claudeSkillFolder, "SKILL.md"));
    const service = new UserSkillsService({ homeDir });

    const diagnostics = await service.diagnostics(repoPath);
    const search = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["claude-1"],
        providerKinds: ["claude-code"]
      },
      runRootByProvider: { "claude-code": repoPath }
    });

    assert.deepEqual(search.skills.map((skill) => skill.frontmatterName), ["qa"]);
    assert.equal(diagnostics.unsafeSymlinkCount, 0);
  });
});

test("counts broken symlinked skill folders without exposing them as visible skills", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath, tempRoot }) => {
    await mkdir(path.join(homeDir, ".codex/skills"), { recursive: true });
    await symlink(path.join(tempRoot, "missing-skill"), path.join(homeDir, ".codex/skills/missing-link"));
    const service = new UserSkillsService({ homeDir });

    const diagnostics = await service.diagnostics(repoPath);
    const search = await service.search(NOW_REQUEST, {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["codex-1"],
        providerKinds: ["codex-cli"]
      },
      runRootByProvider: { "codex-cli": repoPath }
    });

    assert.equal(search.skills.length, 0);
    assert.equal(diagnostics.unsafeSymlinkCount, 1);
  });
});

test("revalidates selected skill content hashes before a participant run", async () => {
  await withTempWorkspace(async ({ homeDir, repoPath }) => {
    const folder = path.join(homeDir, ".claude/skills/qa");
    await writeSkill(folder, "qa", "QA", "old body");
    const service = new UserSkillsService({ homeDir });
    const context = {
      repoPath,
      target: {
        hasClearTargets: true,
        participantIds: ["claude-1"],
        providerKinds: ["claude-code" as ChatProviderKind]
      },
      participantProviderKindById: { "claude-1": "claude-code" as ChatProviderKind },
      runRootByParticipant: { "claude-1": repoPath },
      runRootByProvider: { "claude-code": repoPath }
    };
    const search = await service.search({ ...NOW_REQUEST, query: "qa" }, context);
    assert.equal(search.skills.length, 1);

    await writeSkill(folder, "qa", "QA", "new body");
    const validation = await service.validateMentionForParticipant(search.skills[0], "claude-code", context);

    assert.equal(validation.ok, false);
    if (!validation.ok) {
      assert.match(validation.message, /changed since it was selected/);
    }
  });
});

async function withTempWorkspace(run: (workspace: { tempRoot: string; homeDir: string; repoPath: string }) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-user-skills-"));
  const homeDir = path.join(tempRoot, "home");
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(homeDir, { recursive: true });
  await mkdir(repoPath, { recursive: true });
  try {
    await run({ tempRoot, homeDir, repoPath });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
