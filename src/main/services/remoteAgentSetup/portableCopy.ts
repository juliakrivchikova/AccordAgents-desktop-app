import { chmod, copyFile, lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./portableConfig";
import type { PortableAgentSetupManifestLink, PortableCopyBudget } from "./types";

export async function copyPortableSkillRoot(
  sourceRoot: string,
  destinationRoot: string,
  bundleRelativeRoot: string,
  targetRoot: PortableAgentSetupManifestLink["root"],
  targetPrefix: string,
  links: PortableAgentSetupManifestLink[],
  budget: PortableCopyBudget,
  skippedNames?: ReadonlySet<string>
): Promise<void> {
  assertPortableSetupNotAborted(budget.signal);
  await copyPortableLinkedDirectoryEntries(
    sourceRoot,
    destinationRoot,
    bundleRelativeRoot,
    targetRoot,
    targetPrefix,
    links,
    budget,
    true,
    skippedNames
  );
}

export async function sharedPortableDirectoryNames(leftRoot: string, rightRoot: string): Promise<Set<string>> {
  const [leftEntries, rightEntries] = await Promise.all([
    readdir(leftRoot, { withFileTypes: true }).catch(() => []),
    readdir(rightRoot, { withFileTypes: true }).catch(() => [])
  ]);
  const rightNames = new Set(rightEntries.map((entry) => entry.name));
  const shared = new Set<string>();
  for (const entry of leftEntries) {
    if (isExcludedPortableRootName(entry.name) || !rightNames.has(entry.name)) {
      continue;
    }
    const [resolvedLeft, resolvedRight] = await Promise.all([
      realpath(path.join(leftRoot, entry.name)).catch(() => undefined),
      realpath(path.join(rightRoot, entry.name)).catch(() => undefined)
    ]);
    if (
      resolvedLeft &&
      resolvedLeft === resolvedRight &&
      await stat(resolvedLeft).then((value) => value.isDirectory()).catch(() => false) &&
      await stat(path.join(resolvedLeft, "SKILL.md")).then((value) => value.isFile()).catch(() => false)
    ) {
      shared.add(entry.name);
    }
  }
  return shared;
}

export async function copyPortableLinkedDirectoryEntries(
  sourceRoot: string,
  destinationRoot: string,
  bundleRelativeRoot: string,
  targetRoot: PortableAgentSetupManifestLink["root"],
  targetPrefix: string,
  links: PortableAgentSetupManifestLink[],
  budget: PortableCopyBudget,
  directoriesOnly = false,
  skippedNames?: ReadonlySet<string>
): Promise<void> {
  assertPortableSetupNotAborted(budget.signal);
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const discovered: Array<{ name: string; sourcePath: string; allowedRoot: string; definitionPath?: string }> = [];
  for (const entry of entries) {
    assertPortableSetupNotAborted(budget.signal);
    if (isExcludedPortableRootName(entry.name) || skippedNames?.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const sourceStats = await stat(sourcePath).catch(() => undefined);
    if (!sourceStats || (directoriesOnly && !sourceStats.isDirectory())) {
      continue;
    }
    const resolvedSource = await realpath(sourcePath).catch(() => undefined);
    if (!resolvedSource) {
      continue;
    }
    const definitionPath = directoriesOnly
      ? await realpath(path.join(resolvedSource, "SKILL.md")).catch(() => undefined)
      : undefined;
    const definitionStats = definitionPath
      ? await stat(definitionPath).catch(() => undefined)
      : undefined;
    discovered.push({
      name: entry.name,
      sourcePath,
      allowedRoot: resolvedSource,
      ...(definitionStats?.isFile() ? { definitionPath } : {})
    });
  }
  const candidates = directoriesOnly
    ? portableSkillCandidates(discovered)
    : discovered;
  const allowedRoots = candidates.flatMap((candidate) => [
    candidate.allowedRoot,
    ...(candidate.definitionPath ? [candidate.definitionPath] : [])
  ]);
  for (const candidate of candidates) {
    assertPortableSetupNotAborted(budget.signal);
    const { name, sourcePath } = candidate;
    const destinationPath = path.join(destinationRoot, name);
    const copied = await copyPortableEntry(sourcePath, destinationPath, budget, new Set(), allowedRoots);
    if (!copied) {
      continue;
    }
    links.push({
      source: `${bundleRelativeRoot}/${name}`,
      root: targetRoot,
      target: `${targetPrefix}/${name}`
    });
  }
}

function portableSkillCandidates<T extends { allowedRoot: string; definitionPath?: string }>(
  discovered: T[]
): T[] {
  return discovered.filter((candidate) => candidate.definitionPath !== undefined);
}

export async function copyPortableLinkedFile(
  sourcePath: string,
  destinationPath: string,
  link: PortableAgentSetupManifestLink,
  links: PortableAgentSetupManifestLink[],
  budget: PortableCopyBudget
): Promise<void> {
  const sourceStats = await stat(sourcePath).catch(() => undefined);
  if (!sourceStats?.isFile()) {
    return;
  }
  if (await copyPortableEntry(sourcePath, destinationPath, budget, new Set())) {
    links.push(link);
  }
}

async function copyPortableEntry(
  sourcePath: string,
  destinationPath: string,
  budget: PortableCopyBudget,
  activeDirectories: Set<string>,
  allowedRoots?: ReadonlyArray<string>
): Promise<boolean> {
  assertPortableSetupNotAborted(budget.signal);
  const resolvedSource = await realpath(sourcePath).catch(() => undefined);
  if (!resolvedSource) {
    return false;
  }
  const resolvedStats = await lstat(resolvedSource).catch(() => undefined);
  if (!resolvedStats) {
    return false;
  }
  return copyPortableResolvedEntry(
    resolvedSource,
    destinationPath,
    budget,
    activeDirectories,
    allowedRoots ?? [resolvedSource]
  );
}

async function copyPortableResolvedEntry(
  sourcePath: string,
  destinationPath: string,
  budget: PortableCopyBudget,
  activeDirectories: Set<string>,
  allowedRoots: ReadonlyArray<string>
): Promise<boolean> {
  assertPortableSetupNotAborted(budget.signal);
  const sourceLstat = await lstat(sourcePath).catch(() => undefined);
  if (!sourceLstat) {
    return false;
  }
  if (sourceLstat.isSymbolicLink()) {
    const resolved = await realpath(sourcePath).catch(() => undefined);
    return resolved && allowedRoots.some((root) => isPortablePathInside(root, resolved))
      ? copyPortableResolvedEntry(resolved, destinationPath, budget, activeDirectories, allowedRoots)
      : false;
  }
  if (sourceLstat.isDirectory()) {
    const resolved = await realpath(sourcePath).catch(() => path.resolve(sourcePath));
    if (activeDirectories.has(resolved)) {
      return false;
    }
    activeDirectories.add(resolved);
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertPortableSetupNotAborted(budget.signal);
      if (isExcludedPortableNestedName(entry.name)) {
        continue;
      }
      await copyPortableResolvedEntry(
        path.join(sourcePath, entry.name),
        path.join(destinationPath, entry.name),
        budget,
        activeDirectories,
        allowedRoots
      );
    }
    activeDirectories.delete(resolved);
    return true;
  }
  if (!sourceLstat.isFile()) {
    return false;
  }
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, destinationPath);
  await chmod(destinationPath, sourceLstat.mode & 0o111 ? 0o700 : 0o600);
  budget.fileCount += 1;
  budget.totalBytes += sourceLstat.size;
  return true;
}

function isPortablePathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function writePortableFile(
  destinationPath: string,
  contents: string,
  budget: PortableCopyBudget
): Promise<void> {
  assertPortableSetupNotAborted(budget.signal);
  const size = Buffer.byteLength(contents);
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await writeFile(destinationPath, contents, { mode: 0o600 });
  budget.fileCount += 1;
  budget.totalBytes += size;
}

export function isExcludedPortableRootName(name: string): boolean {
  return name.startsWith(".");
}

export function isExcludedPortableNestedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === ".ds_store" || normalized === ".git" ||
    normalized === ".env" || normalized.startsWith(".env.") ||
    normalized === "auth.json" || normalized === "credentials.json";
}

export function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function assertPortableSetupNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The portable agent setup was aborted.", "AbortError");
  }
}
