import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { PORTABLE_AGENT_SETUP_VERSION } from "./constants";
import { assertPortableSetupNotAborted, isExcludedPortableNestedName, isExcludedPortableRootName } from "./portableCopy";
import type { PortableAgentSetupPreparedInvocation, PortableAgentSetupRoots } from "./types";

export async function hashPortableBundle(bundleRoot: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`portable-agent-setup-v${PORTABLE_AGENT_SETUP_VERSION}\0`);
  await hashPortableEntry(bundleRoot, "", hash, signal);
  return hash.digest("hex");
}

export async function computePortableAgentSetupSourceFingerprint(
  roots: PortableAgentSetupRoots,
  signal?: AbortSignal,
  preparedInvocation: PortableAgentSetupPreparedInvocation = {}
): Promise<string> {
  assertPortableSetupNotAborted(signal);
  const hash = createHash("sha256");
  hash.update(`portable-agent-setup-source-v${PORTABLE_AGENT_SETUP_VERSION}\0`);
  const directories = [
    { source: path.join(roots.codexHomeDir, "skills"), logical: "codex/skills" },
    { source: path.join(roots.agentsHomeDir, "skills"), logical: "agents/skills" },
    { source: path.join(roots.claudeConfigDir, "skills"), logical: "claude/skills" },
    { source: path.join(roots.geminiConfigDir, "skills"), logical: "gemini/skills" },
    { source: path.join(roots.codexHomeDir, "rules"), logical: "codex/rules" },
    { source: path.join(roots.claudeConfigDir, "rules"), logical: "claude/rules" }
  ];
  const files = [
    { source: path.join(roots.codexHomeDir, "AGENTS.md"), logical: "codex/AGENTS.md" },
    { source: path.join(roots.claudeConfigDir, "CLAUDE.md"), logical: "claude/CLAUDE.md" }
  ];
  for (const entry of directories) {
    await hashPortableSourceEntry(
      entry.source,
      entry.logical,
      hash,
      new Set(),
      true,
      signal
    );
  }
  for (const entry of files) {
    await hashPortableSourceEntry(
      entry.source,
      entry.logical,
      hash,
      new Set(),
      false,
      signal
    );
  }
  hash.update(`invocation\0${JSON.stringify(preparedInvocation)}\0`);
  return hash.digest("hex");
}

async function hashPortableSourceEntry(
  sourcePath: string,
  logicalPath: string,
  hash: ReturnType<typeof createHash>,
  activeDirectories: Set<string>,
  rootEntries = false,
  signal?: AbortSignal
): Promise<void> {
  assertPortableSetupNotAborted(signal);
  const sourceLstat = await lstat(sourcePath).catch(() => undefined);
  if (!sourceLstat) {
    hash.update(`missing\0${logicalPath}\0`);
    return;
  }
  if (sourceLstat.isSymbolicLink()) {
    const resolved = await realpath(sourcePath).catch(() => undefined);
    if (!resolved) {
      hash.update(`broken-link\0${logicalPath}\0`);
      return;
    }
    await hashPortableSourceEntry(resolved, logicalPath, hash, activeDirectories, rootEntries, signal);
    return;
  }
  if (sourceLstat.isDirectory()) {
    const resolved = await realpath(sourcePath).catch(() => path.resolve(sourcePath));
    if (activeDirectories.has(resolved)) {
      hash.update(`cycle\0${logicalPath}\0`);
      return;
    }
    activeDirectories.add(resolved);
    hash.update(`dir\0${logicalPath}\0${sourceLstat.mtimeMs}\0${sourceLstat.ctimeMs}\0${sourceLstat.ino}\0`);
    const entries = await readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertPortableSetupNotAborted(signal);
      const excluded = rootEntries
        ? isExcludedPortableRootName(entry.name)
        : isExcludedPortableNestedName(entry.name);
      if (!excluded) {
        await hashPortableSourceEntry(
          path.join(sourcePath, entry.name),
          `${logicalPath}/${entry.name}`,
          hash,
          activeDirectories,
          false,
          signal
        );
      }
    }
    activeDirectories.delete(resolved);
    return;
  }
  if (sourceLstat.isFile()) {
    hash.update(
      `file\0${logicalPath}\0${sourceLstat.size}\0${sourceLstat.mtimeMs}\0${sourceLstat.ctimeMs}\0${sourceLstat.ino}\0${sourceLstat.mode & 0o7777}\0`
    );
  }
}

async function hashPortableEntry(
  root: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  signal?: AbortSignal
): Promise<void> {
  assertPortableSetupNotAborted(signal);
  const absolutePath = relativePath ? path.join(root, relativePath) : root;
  const entryStats = await lstat(absolutePath);
  if (entryStats.isDirectory()) {
    if (relativePath) {
      hash.update(`dir\0${relativePath}\0`);
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await hashPortableEntry(
        root,
        relativePath ? `${relativePath}/${entry.name}` : entry.name,
        hash,
        signal
      );
    }
    return;
  }
  if (!entryStats.isFile()) {
    return;
  }
  hash.update(`file\0${relativePath}\0${entryStats.mode & 0o111}\0`);
  hash.update(await readFile(absolutePath, { signal }));
  hash.update("\0");
}
