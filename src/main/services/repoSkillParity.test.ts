import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface RuntimeSkillFile {
  executable: boolean;
  contents: string;
}

test("repo-local provider skill roots expose the same runtime payload", async () => {
  const repoRoot = process.cwd();
  const agentsRoot = path.join(repoRoot, ".agents", "skills");
  const claudeRoot = path.join(repoRoot, ".claude", "skills");
  const [agentsSkills, claudeSkills] = await Promise.all([
    skillNames(agentsRoot),
    skillNames(claudeRoot)
  ]);

  assert.deepEqual(
    agentsSkills,
    claudeSkills,
    "Codex/Gemini and Claude repo-local skill inventories diverged; add a relative bridge in the other native root"
  );
  for (const skillName of agentsSkills) {
    const [agentsPayload, claudePayload] = await Promise.all([
      runtimePayload(path.join(agentsRoot, skillName)),
      runtimePayload(path.join(claudeRoot, skillName))
    ]);
    assert.deepEqual(
      agentsPayload,
      claudePayload,
      `${skillName} has different SKILL.md, scripts, or assets across provider-native roots`
    );
    assert.ok(agentsPayload["SKILL.md"], `${skillName} does not contain SKILL.md`);
  }
});

async function skillNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryStats = await stat(path.join(root, entry.name));
    if (entryStats.isDirectory()) {
      names.push(entry.name);
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

async function runtimePayload(root: string): Promise<Record<string, RuntimeSkillFile>> {
  const result: Record<string, RuntimeSkillFile> = {};
  await visit(root, "", result);
  return result;
}

async function visit(
  root: string,
  relativePath: string,
  result: Record<string, RuntimeSkillFile>
): Promise<void> {
  const absolutePath = relativePath ? path.join(root, relativePath) : root;
  const entryStats = await stat(absolutePath);
  if (entryStats.isDirectory()) {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = relativePath ? path.join(relativePath, entry.name) : entry.name;
      if (child === "agents" || child.startsWith(`agents${path.sep}`)) {
        continue;
      }
      await visit(root, child, result);
    }
    return;
  }
  if (!entryStats.isFile()) {
    return;
  }
  result[relativePath.split(path.sep).join("/")] = {
    executable: Boolean(entryStats.mode & 0o111),
    contents: (await readFile(absolutePath)).toString("base64")
  };
}
