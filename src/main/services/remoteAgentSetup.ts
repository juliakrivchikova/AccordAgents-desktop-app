import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { runCommand } from "./command";
import type { CommandOptions, CommandResult } from "./command";
import { defaultRemoteMirrorSync } from "./remoteMirrorSync";
import type { RemoteMirrorSyncRunner } from "./remoteMirrorSync";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export const PORTABLE_AGENT_SETUP_VERSION = 1;
const PORTABLE_SETUP_DIRNAME = "agent-setup";
const PORTABLE_SETUP_MAX_FILES = 20_000;
const PORTABLE_SETUP_MAX_FILE_BYTES = 32 * 1024 * 1024;
const PORTABLE_SETUP_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const PORTABLE_SETUP_MAX_INVOCATION_CONFIG_BYTES = 64 * 1024;
const PORTABLE_SETUP_SYNC_TIMEOUT_MS = 10 * 60_000;
export interface PortableAgentSetupInvocation {
  fingerprint: string;
  codexConfigOverrides?: string[];
  claudeSettings?: Record<string, unknown>;
  claudeMcpServers?: Record<string, unknown>;
}

export interface RemoteAgentSetupSyncRequest {
  worker: RemoteRunWorkerTarget;
  sourceEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RemoteAgentSetupSyncRunner {
  sync(request: RemoteAgentSetupSyncRequest): Promise<PortableAgentSetupInvocation>;
}

export interface PortableAgentSetupManifestLink {
  source: string;
  root: "codex" | "agents" | "claude" | "gemini";
  target: string;
}

export interface PortableAgentSetupManifest {
  version: typeof PORTABLE_AGENT_SETUP_VERSION;
  fingerprint: string;
  fileCount: number;
  totalBytes: number;
  links: PortableAgentSetupManifestLink[];
}

export interface PortableAgentSetupBundle extends PortableAgentSetupInvocation {
  localPath: string;
  manifest: PortableAgentSetupManifest;
  cleanup(): Promise<void>;
}

interface PortableAgentSetupBuildOptions {
  homeDir?: string;
  codexHomeDir?: string;
  claudeConfigDir?: string;
  geminiConfigDir?: string;
  tempDir?: string;
}

interface PortableAgentSetupRoots {
  homeDir: string;
  codexHomeDir: string;
  claudeConfigDir: string;
  geminiConfigDir: string;
  agentsHomeDir: string;
}

interface PortableCopyBudget {
  fileCount: number;
  totalBytes: number;
}

type PortableCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

interface DefaultRemoteAgentSetupSyncOptions {
  homeDir?: string;
  codexHomeDir?: string;
  claudeConfigDir?: string;
  geminiConfigDir?: string;
  tempDir?: string;
  mirrorSync?: RemoteMirrorSyncRunner;
  commandRunner?: PortableCommandRunner;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

interface PortableSetupRemoteState {
  fingerprint?: unknown;
}

export class DefaultRemoteAgentSetupSync implements RemoteAgentSetupSyncRunner {
  private readonly mirrorSync: RemoteMirrorSyncRunner;
  private readonly commandRunner: PortableCommandRunner;
  private readonly completedByWorker = new Map<string, {
    sourceFingerprint: string;
    invocation: PortableAgentSetupInvocation;
  }>();
  private readonly chainByWorker = new Map<string, Promise<PortableAgentSetupInvocation>>();

  constructor(private readonly options: DefaultRemoteAgentSetupSyncOptions = {}) {
    this.mirrorSync = options.mirrorSync ?? defaultRemoteMirrorSync;
    this.commandRunner = options.commandRunner ?? runCommand;
  }

  sync(request: RemoteAgentSetupSyncRequest): Promise<PortableAgentSetupInvocation> {
    const workerKey = portableSetupWorkerKey(request.worker);
    const previous = this.chainByWorker.get(workerKey) ?? Promise.resolve({ fingerprint: "" });
    const next = previous
      .catch(() => ({ fingerprint: "" }))
      .then(() => this.syncWorker(workerKey, request));
    this.chainByWorker.set(workerKey, next);
    void next.finally(() => {
      if (this.chainByWorker.get(workerKey) === next) {
        this.chainByWorker.delete(workerKey);
      }
    }).catch(() => undefined);
    return next;
  }

  private async syncWorker(
    workerKey: string,
    request: RemoteAgentSetupSyncRequest
  ): Promise<PortableAgentSetupInvocation> {
    const roots = resolvePortableAgentSetupRoots(this.options, request.sourceEnvironment);
    const sourceFingerprint = await computePortableAgentSetupSourceFingerprint(roots);
    const completed = this.completedByWorker.get(workerKey);
    if (completed?.sourceFingerprint === sourceFingerprint) {
      return completed.invocation;
    }
    const bundle = await buildPortableAgentSetupBundle({
      homeDir: roots.homeDir,
      codexHomeDir: roots.codexHomeDir,
      claudeConfigDir: roots.claudeConfigDir,
      geminiConfigDir: roots.geminiConfigDir,
      tempDir: this.options.tempDir
    });
    const invocation = portableInvocationFromBundle(bundle);
    try {
      const startedAt = Date.now();
      const remoteRoot = await resolvePortableSetupWorkerRoot(
        request.worker,
        request.signal,
        this.commandRunner
      );
      const setupRoot = `${remoteRoot}/${PORTABLE_SETUP_DIRNAME}`;
      const remoteBundlePath = `${setupRoot}/bundle`;
      const remoteStatePath = `${setupRoot}/state.json`;
      const remote = await readRemoteSetupState(
        request.worker,
        remoteBundlePath,
        remoteStatePath,
        request.signal,
        this.commandRunner
      );
      const bundleCurrent = remote.manifest?.fingerprint === bundle.fingerprint;
      if (!bundleCurrent) {
        await this.mirrorSync.syncUp({
          worker: request.worker,
          localPath: bundle.localPath,
          remotePath: remoteBundlePath,
          signal: request.signal,
          timeoutMs: PORTABLE_SETUP_SYNC_TIMEOUT_MS
        });
      }
      if (!bundleCurrent || remote.state?.fingerprint !== bundle.fingerprint) {
        await activateRemotePortableSetup(
          request.worker,
          remoteBundlePath,
          remoteStatePath,
          request.signal,
          this.commandRunner
        );
      }
      this.completedByWorker.set(workerKey, { sourceFingerprint, invocation });
      this.options.logger?.("remote-agent-setup.sync", {
        changed: !bundleCurrent,
        durationMs: Date.now() - startedAt,
        fileCount: bundle.manifest.fileCount,
        totalBytes: bundle.manifest.totalBytes
      });
      return invocation;
    } finally {
      await bundle.cleanup();
    }
  }
}

export async function buildPortableAgentSetupBundle(
  options: PortableAgentSetupBuildOptions = {}
): Promise<PortableAgentSetupBundle> {
  const roots = resolvePortableAgentSetupRoots(options);
  const stagingParent = options.tempDir ? path.resolve(options.tempDir) : tmpdir();
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(path.join(stagingParent, "accordagents-agent-setup-"));
  const bundleRoot = path.join(stagingRoot, "bundle");
  const links: PortableAgentSetupManifestLink[] = [];
  const budget: PortableCopyBudget = { fileCount: 0, totalBytes: 0 };
  let claudeSettings: Record<string, unknown> | undefined;
  let claudeMcpServers: Record<string, unknown> | undefined;
  try {
    await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
    const sharedGstackSource = await samePortableDirectory(
      path.join(roots.codexHomeDir, "skills", "gstack"),
      path.join(roots.claudeConfigDir, "skills", "gstack")
    );
    await copyPortableSkillRoot(
      path.join(roots.codexHomeDir, "skills"),
      path.join(bundleRoot, "codex", "skills"),
      "codex/skills",
      "codex",
      "skills",
      links,
      budget,
      sharedGstackSource ? new Set(["gstack"]) : undefined
    );
    await copyPortableSkillRoot(
      path.join(roots.agentsHomeDir, "skills"),
      path.join(bundleRoot, "agents", "skills"),
      "agents/skills",
      "agents",
      "skills",
      links,
      budget
    );
    if (sharedGstackSource) {
      links.push({ source: "claude/skills/gstack", root: "codex", target: "skills/gstack" });
    }
    await copyPortableSkillRoot(
      path.join(roots.claudeConfigDir, "skills"),
      path.join(bundleRoot, "claude", "skills"),
      "claude/skills",
      "claude",
      "skills",
      links,
      budget
    );
    await copyPortableSkillRoot(
      path.join(roots.geminiConfigDir, "skills"),
      path.join(bundleRoot, "gemini", "skills"),
      "gemini/skills",
      "gemini",
      "skills",
      links,
      budget
    );
    await copyPortableLinkedFile(
      path.join(roots.codexHomeDir, "AGENTS.md"),
      path.join(bundleRoot, "codex", "AGENTS.md"),
      { source: "codex/AGENTS.md", root: "codex", target: "AGENTS.md" },
      links,
      budget
    );
    await copyPortableLinkedFile(
      path.join(roots.claudeConfigDir, "CLAUDE.md"),
      path.join(bundleRoot, "claude", "CLAUDE.md"),
      { source: "claude/CLAUDE.md", root: "claude", target: "CLAUDE.md" },
      links,
      budget
    );
    await copyPortableLinkedDirectoryEntries(
      path.join(roots.codexHomeDir, "rules"),
      path.join(bundleRoot, "codex", "rules"),
      "codex/rules",
      "codex",
      "rules",
      links,
      budget
    );
    await copyPortableLinkedDirectoryEntries(
      path.join(roots.claudeConfigDir, "rules"),
      path.join(bundleRoot, "claude", "rules"),
      "claude/rules",
      "claude",
      "rules",
      links,
      budget
    );

    const codexConfig = await readFile(path.join(roots.codexHomeDir, "config.toml"), "utf8")
      .then(sanitizeCodexPortableConfig)
      .catch(() => "");
    const codexConfigOverrides = codexPortableConfigOverrides(codexConfig);
    claudeSettings = await readJsonRecord(path.join(roots.claudeConfigDir, "settings.json"))
      .then(sanitizeClaudePortableSettings)
      .catch(() => undefined);
    if (claudeSettings && Object.keys(claudeSettings).length > 0) {
      await writePortableFile(
        path.join(bundleRoot, "claude", "settings.json"),
        `${JSON.stringify(claudeSettings, null, 2)}\n`,
        budget
      );
    } else {
      claudeSettings = undefined;
    }

    claudeMcpServers = await readJsonRecord(path.join(roots.homeDir, ".claude.json"))
      .then((value) => sanitizeClaudeMcpServers(value.mcpServers))
      .catch(() => undefined);
    if (claudeMcpServers && Object.keys(claudeMcpServers).length > 0) {
      await writePortableFile(
        path.join(bundleRoot, "claude", "mcp.json"),
        `${JSON.stringify({ mcpServers: claudeMcpServers }, null, 2)}\n`,
        budget
      );
    } else {
      claudeMcpServers = undefined;
    }
    assertPortableInvocationConfigBudget(codexConfigOverrides, claudeSettings, claudeMcpServers);

    links.sort(comparePortableLinks);
    const fingerprint = await hashPortableBundle(bundleRoot);
    const manifest: PortableAgentSetupManifest = {
      version: PORTABLE_AGENT_SETUP_VERSION,
      fingerprint,
      fileCount: budget.fileCount,
      totalBytes: budget.totalBytes,
      links
    };
    await writeFile(
      path.join(bundleRoot, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 }
    );
    return {
      localPath: bundleRoot,
      manifest,
      fingerprint,
      ...(codexConfigOverrides.length > 0 ? { codexConfigOverrides } : {}),
      ...(claudeSettings ? { claudeSettings } : {}),
      ...(claudeMcpServers ? { claudeMcpServers } : {}),
      cleanup: () => rm(stagingRoot, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function sanitizeCodexPortableConfig(contents: string): string {
  const blocks = splitTomlTableBlocks(contents);
  const kept: string[] = [];
  const rejectedFamilies = new Set<string>();
  const candidates: Array<{ family?: string; body: string }> = [];
  for (const block of blocks) {
    const header = block.header;
    if (!header) {
      continue;
    }
    const namespace = tomlTableNamespace(header);
    if (!namespace || !["mcp_servers", "plugins", "marketplaces", "features"].includes(namespace)) {
      continue;
    }
    const tableName = unquoteTomlTableHeader(header);
    if (/^mcp_servers\.(?:accord_agents|"accord_agents")(?:\.|$)/.test(tableName)) {
      continue;
    }
    const family = tomlPortableFamily(header, namespace);
    if (namespace === "mcp_servers" && /\.env$/.test(tableName)) {
      continue;
    }
    if (namespace === "mcp_servers" && /\.(?:headers|http_headers)$/.test(tableName)) {
      if (family) {
        rejectedFamilies.add(family);
      }
      continue;
    }
    const sanitized = namespace === "mcp_servers" && /\.env_http_headers$/.test(tableName)
      ? sanitizePortableEnvironmentHeaderBlock(block.body)
      : sanitizePortableTomlBlock(block.body);
    if (!sanitized) {
      if (family) {
        rejectedFamilies.add(family);
      }
      continue;
    }
    candidates.push({ family, body: sanitized });
  }
  for (const candidate of candidates) {
    if (!candidate.family || !rejectedFamilies.has(candidate.family)) {
      kept.push(candidate.body.trimEnd());
    }
  }
  return kept.length > 0
    ? `# Generated by AccordAgents from portable user configuration.\n${kept.join("\n\n")}\n`
    : "";
}

export function sanitizeClaudePortableSettings(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.enabledPlugins)) {
    return undefined;
  }
  const enabledPlugins = Object.fromEntries(
    Object.entries(value.enabledPlugins)
      .filter(([name, enabled]) => Boolean(name.trim()) && typeof enabled === "boolean")
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return Object.keys(enabledPlugins).length > 0 ? { enabledPlugins } : undefined;
}

export function sanitizeClaudeMcpServers(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const servers: Record<string, unknown> = {};
  for (const [name, rawServer] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.trim() || !isRecord(rawServer)) {
      continue;
    }
    const server: Record<string, unknown> = {};
    for (const key of ["type", "transport", "command", "url", "cwd"] as const) {
      const field = rawServer[key];
      if (typeof field === "string" && field.trim()) {
        server[key] = field;
      }
    }
    if (Array.isArray(rawServer.args) && rawServer.args.every((item) => typeof item === "string")) {
      server.args = rawServer.args;
    }
    if (isRecord(rawServer.env)) {
      const env = Object.fromEntries(
        Object.entries(rawServer.env).filter(([envName, envValue]) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) &&
          typeof envValue === "string" &&
          isPortableEnvironmentReference(envValue)
        )
      );
      if (Object.keys(env).length > 0) {
        server.env = env;
      }
    }
    if (isRecord(rawServer.headers)) {
      const headerEntries = Object.entries(rawServer.headers);
      const headers = Object.fromEntries(
        headerEntries.filter(([, headerValue]) =>
          typeof headerValue === "string" && isPortableEnvironmentReference(headerValue)
        )
      );
      if (Object.keys(headers).length !== headerEntries.length) {
        continue;
      }
      if (Object.keys(headers).length > 0) {
        server.headers = headers;
      }
    }
    if (Object.values(server).some(containsMachineSpecificPath)) {
      continue;
    }
    if (Object.values(server).some(containsEmbeddedSecretValue)) {
      continue;
    }
    if (typeof server.command === "string" || typeof server.url === "string") {
      servers[name] = server;
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

export function codexPortableConfigOverrides(config: string): string[] {
  const overrides: string[] = [];
  let table: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line)) {
      table = unquoteTomlTableHeader(line);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (table && assignment) {
      overrides.push(`${table}.${assignment[1]}=${assignment[2]}`);
    }
  }
  return overrides;
}

function portableInvocationFromBundle(bundle: PortableAgentSetupBundle): PortableAgentSetupInvocation {
  return {
    fingerprint: bundle.fingerprint,
    ...(bundle.codexConfigOverrides ? { codexConfigOverrides: bundle.codexConfigOverrides } : {}),
    ...(bundle.claudeSettings ? { claudeSettings: bundle.claudeSettings } : {}),
    ...(bundle.claudeMcpServers ? { claudeMcpServers: bundle.claudeMcpServers } : {})
  };
}

async function copyPortableSkillRoot(
  sourceRoot: string,
  destinationRoot: string,
  bundleRelativeRoot: string,
  targetRoot: PortableAgentSetupManifestLink["root"],
  targetPrefix: string,
  links: PortableAgentSetupManifestLink[],
  budget: PortableCopyBudget,
  skippedNames?: ReadonlySet<string>
): Promise<void> {
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

async function samePortableDirectory(left: string, right: string): Promise<boolean> {
  const [resolvedLeft, resolvedRight] = await Promise.all([
    realpath(left).catch(() => undefined),
    realpath(right).catch(() => undefined)
  ]);
  if (!resolvedLeft || !resolvedRight || resolvedLeft !== resolvedRight) {
    return false;
  }
  return stat(resolvedLeft).then((value) => value.isDirectory()).catch(() => false);
}

async function copyPortableLinkedDirectoryEntries(
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
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const discovered: Array<{ name: string; sourcePath: string; allowedRoot: string; definitionPath?: string }> = [];
  for (const entry of entries) {
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
  const allowedRoots = candidates.map((candidate) => candidate.allowedRoot);
  for (const candidate of candidates) {
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
  const approvedRoots = new Set(
    discovered
      .filter((candidate) => candidate.definitionPath && isPortablePathInside(candidate.allowedRoot, candidate.definitionPath))
      .map((candidate) => candidate.allowedRoot)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of discovered) {
      if (
        !approvedRoots.has(candidate.allowedRoot) &&
        candidate.definitionPath &&
        [...approvedRoots].some((root) => isPortablePathInside(root, candidate.definitionPath as string))
      ) {
        approvedRoots.add(candidate.allowedRoot);
        changed = true;
      }
    }
  }
  return discovered.filter((candidate) => approvedRoots.has(candidate.allowedRoot));
}

async function copyPortableLinkedFile(
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
      throw new Error(`Portable agent setup contains a symlink cycle at ${sourcePath}.`);
    }
    activeDirectories.add(resolved);
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
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
  assertPortableCopyBudget(sourcePath, sourceLstat.size, budget);
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

async function writePortableFile(
  destinationPath: string,
  contents: string,
  budget: PortableCopyBudget
): Promise<void> {
  const size = Buffer.byteLength(contents);
  assertPortableCopyBudget(destinationPath, size, budget);
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await writeFile(destinationPath, contents, { mode: 0o600 });
  budget.fileCount += 1;
  budget.totalBytes += size;
}

function assertPortableCopyBudget(sourcePath: string, size: number, budget: PortableCopyBudget): void {
  if (size > PORTABLE_SETUP_MAX_FILE_BYTES) {
    throw new Error(`Portable agent setup file exceeds 32 MB: ${sourcePath}`);
  }
  if (budget.fileCount + 1 > PORTABLE_SETUP_MAX_FILES) {
    throw new Error("Portable agent setup exceeds 20,000 files.");
  }
  if (budget.totalBytes + size > PORTABLE_SETUP_MAX_TOTAL_BYTES) {
    throw new Error("Portable agent setup exceeds 100 MB.");
  }
}

function isExcludedPortableRootName(name: string): boolean {
  return name.startsWith(".");
}

function isExcludedPortableNestedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return name === ".DS_Store" || name === ".git" ||
    normalized === ".env" || normalized.startsWith(".env.") ||
    normalized === "auth.json" || normalized === "credentials.json";
}

async function hashPortableBundle(bundleRoot: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`portable-agent-setup-v${PORTABLE_AGENT_SETUP_VERSION}\0`);
  await hashPortableEntry(bundleRoot, "", hash);
  return hash.digest("hex");
}

function resolvePortableAgentSetupRoots(
  options: Pick<PortableAgentSetupBuildOptions, "homeDir" | "codexHomeDir" | "claudeConfigDir" | "geminiConfigDir">,
  sourceEnvironment?: NodeJS.ProcessEnv
): PortableAgentSetupRoots {
  const homeDir = path.resolve(options.homeDir ?? homedir());
  const useAmbientProviderHomes = options.homeDir === undefined;
  const ambientCodexHome = useAmbientProviderHomes
    ? sourceEnvironment?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim()
    : undefined;
  const ambientClaudeConfig = useAmbientProviderHomes
    ? sourceEnvironment?.CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim()
    : undefined;
  return {
    homeDir,
    codexHomeDir: path.resolve(options.codexHomeDir ?? ambientCodexHome ?? path.join(homeDir, ".codex")),
    claudeConfigDir: path.resolve(options.claudeConfigDir ?? ambientClaudeConfig ?? path.join(homeDir, ".claude")),
    geminiConfigDir: path.resolve(options.geminiConfigDir ?? path.join(homeDir, ".gemini", "config")),
    agentsHomeDir: path.join(homeDir, ".agents")
  };
}

async function computePortableAgentSetupSourceFingerprint(roots: PortableAgentSetupRoots): Promise<string> {
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
      true
    );
  }
  for (const entry of files) {
    await hashPortableSourceEntry(
      entry.source,
      entry.logical,
      hash,
      new Set()
    );
  }
  const codexConfig = await readFile(path.join(roots.codexHomeDir, "config.toml"), "utf8")
    .then(sanitizeCodexPortableConfig)
    .catch(() => "");
  const claudeSettings = await readJsonRecord(path.join(roots.claudeConfigDir, "settings.json"))
    .then(sanitizeClaudePortableSettings)
    .catch(() => undefined);
  const claudeMcpServers = await readJsonRecord(path.join(roots.homeDir, ".claude.json"))
    .then((value) => sanitizeClaudeMcpServers(value.mcpServers))
    .catch(() => undefined);
  hash.update(`codex-config\0${codexConfig}\0`);
  hash.update(`claude-settings\0${JSON.stringify(claudeSettings ?? {})}\0`);
  hash.update(`claude-mcp\0${JSON.stringify(claudeMcpServers ?? {})}\0`);
  return hash.digest("hex");
}

async function hashPortableSourceEntry(
  sourcePath: string,
  logicalPath: string,
  hash: ReturnType<typeof createHash>,
  activeDirectories: Set<string>,
  rootEntries = false
): Promise<void> {
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
    await hashPortableSourceEntry(resolved, logicalPath, hash, activeDirectories, rootEntries);
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
      const excluded = rootEntries
        ? isExcludedPortableRootName(entry.name)
        : isExcludedPortableNestedName(entry.name);
      if (!excluded) {
        await hashPortableSourceEntry(
          path.join(sourcePath, entry.name),
          `${logicalPath}/${entry.name}`,
          hash,
          activeDirectories,
          false
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
  hash: ReturnType<typeof createHash>
): Promise<void> {
  const absolutePath = relativePath ? path.join(root, relativePath) : root;
  const entryStats = await lstat(absolutePath);
  if (entryStats.isDirectory()) {
    if (relativePath) {
      hash.update(`dir\0${relativePath}\0`);
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await hashPortableEntry(root, relativePath ? `${relativePath}/${entry.name}` : entry.name, hash);
    }
    return;
  }
  if (!entryStats.isFile()) {
    return;
  }
  hash.update(`file\0${relativePath}\0${entryStats.mode & 0o111}\0`);
  hash.update(await readFile(absolutePath));
  hash.update("\0");
}

function splitTomlTableBlocks(contents: string): Array<{ header?: string; body: string }> {
  const lines = contents.split(/\r?\n/);
  const blocks: Array<{ header?: string; body: string }> = [];
  let header: string | undefined;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push({ header, body: current.join("\n") });
    }
  };
  for (const line of lines) {
    if (/^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line)) {
      flush();
      header = line.trim();
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function unquoteTomlTableHeader(header: string): string {
  return header.replace(/^\s*\[\[?/, "").replace(/\]\]?\s*(?:#.*)?$/, "").trim();
}

function tomlTableNamespace(header: string): string | undefined {
  return unquoteTomlTableHeader(header).match(/^([A-Za-z0-9_-]+)/)?.[1];
}

function tomlPortableFamily(header: string, namespace: string): string | undefined {
  const table = unquoteTomlTableHeader(header);
  if (namespace === "features") {
    return "features";
  }
  const suffix = table.slice(namespace.length + 1);
  if (!suffix) {
    return namespace;
  }
  const first = suffix.startsWith('"')
    ? suffix.match(/^"(?:\\.|[^"])*"/)?.[0]
    : suffix.split(".")[0];
  return first ? `${namespace}.${first}` : namespace;
}

function sanitizePortableTomlBlock(block: string): string | undefined {
  const result: string[] = [];
  for (const line of block.split("\n")) {
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) {
      if (/^\s*(?:\[|#|$)/.test(line)) {
        result.push(line);
        continue;
      }
      return undefined;
    }
    const key = assignment[1].toLowerCase();
    const rawValue = assignment[2];
    if (!isCompletePortableTomlValue(rawValue)) {
      return undefined;
    }
    if (key === "env") {
      if (rawValue.trim().startsWith("{") && rawValue.trim().endsWith("}")) {
        continue;
      }
      return undefined;
    }
    if (key === "headers" || key === "http_headers") {
      return undefined;
    }
    if (isSensitiveConfigKey(key) && !key.endsWith("_env_var") && !key.endsWith("_env_vars")) {
      if (!isPortableEnvironmentReference(rawValue)) {
        return undefined;
      }
    }
    if (containsMachineSpecificPath(rawValue)) {
      return undefined;
    }
    if (containsEmbeddedSecret(rawValue)) {
      return undefined;
    }
    result.push(line);
  }
  return result.join("\n").trim() ? result.join("\n") : undefined;
}

function sanitizePortableEnvironmentHeaderBlock(block: string): string | undefined {
  const result: string[] = [];
  for (const line of block.split("\n")) {
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) {
      result.push(line);
      continue;
    }
    const environmentName = assignment[2].trim().replace(/^['"]|['"]$/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
      return undefined;
    }
    result.push(line);
  }
  return result.join("\n").trim() ? result.join("\n") : undefined;
}

function isCompletePortableTomlValue(value: string): boolean {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "[") {
      squareDepth += 1;
    } else if (character === "]") {
      squareDepth -= 1;
    } else if (character === "{") {
      curlyDepth += 1;
    } else if (character === "}") {
      curlyDepth -= 1;
    }
    if (squareDepth < 0 || curlyDepth < 0) {
      return false;
    }
  }
  return !quote && !escaped && squareDepth === 0 && curlyDepth === 0;
}

function assertPortableInvocationConfigBudget(
  codexOverrides: string[],
  claudeSettings: Record<string, unknown> | undefined,
  claudeMcpServers: Record<string, unknown> | undefined
): void {
  const values = [
    ...codexOverrides,
    ...(claudeSettings ? [JSON.stringify(claudeSettings)] : []),
    ...(claudeMcpServers ? [JSON.stringify({ mcpServers: claudeMcpServers })] : [])
  ];
  const totalBytes = values.reduce((total, value) => total + Buffer.byteLength(value), 0);
  if (totalBytes > PORTABLE_SETUP_MAX_INVOCATION_CONFIG_BYTES) {
    throw new Error("Portable agent configuration exceeds 64 KB.");
  }
}

function isSensitiveConfigKey(key: string): boolean {
  return /(?:^|_)(?:api_?key|authorization|bearer|credential|password|secret|token)(?:$|_)/i.test(key);
}

function isPortableEnvironmentReference(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized);
}

function containsMachineSpecificPath(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsMachineSpecificPath);
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsMachineSpecificPath);
  }
  if (typeof value !== "string") {
    return false;
  }
  return /(?:^|["'\s=])\/(?!usr\/bin\/env(?:["'\s]|$))/.test(value) ||
    /(?:^|["'\s=])[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|["'\s=])(?:~\/|\.\.?\/)/.test(value) ||
    /\.app\/Contents\//.test(value);
}

function containsEmbeddedSecret(value: string): boolean {
  return /https?:\/\/[^/"'\s]+:[^@/"'\s]+@/i.test(value) ||
    /(?:bearer\s+[A-Za-z0-9]|(?:api[_-]?key|password|secret|token)[=:]\s*["']?(?!\$\{?)[^\s"'}]+)/i.test(value) ||
    /--(?:api[_-]?key|password|secret|token)(?:=|["'\s])/i.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/.test(value);
}

function containsEmbeddedSecretValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (
        typeof item === "string" &&
        /^--(?:api[_-]?key|password|secret|token)$/i.test(item) &&
        typeof value[index + 1] === "string" &&
        !isPortableEnvironmentReference(value[index + 1] as string)
      ) {
        return true;
      }
      if (containsEmbeddedSecretValue(item)) {
        return true;
      }
    }
    return false;
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsEmbeddedSecretValue);
  }
  return typeof value === "string" &&
    !isPortableEnvironmentReference(value) &&
    containsEmbeddedSecret(value);
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function comparePortableLinks(left: PortableAgentSetupManifestLink, right: PortableAgentSetupManifestLink): number {
  return `${left.root}/${left.target}`.localeCompare(`${right.root}/${right.target}`);
}

function portableSetupWorkerKey(worker: RemoteRunWorkerTarget): string {
  return JSON.stringify({
    host: worker.hostKeyAlias?.trim() || worker.host,
    user: worker.user,
    port: worker.port,
    identityFile: worker.identityFile,
    sshPath: worker.sshPath,
    workerRoot: worker.workerRoot
  });
}

async function resolvePortableSetupWorkerRoot(
  worker: RemoteRunWorkerTarget,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<string> {
  const requested = worker.workerRoot?.trim() || "~/.accordagents/remote-runs";
  if (requested.startsWith("/")) {
    return requested.replace(/\/+$/g, "") || "/";
  }
  const relative = requested === "~" ? "" : requested.startsWith("~/") ? requested.slice(2) : requested;
  const command = relative
    ? `printf '%s' "$HOME"/${shellQuotePosix(relative)}`
    : `printf '%s' "$HOME"`;
  const result = await commandRunner(
    worker.sshPath?.trim() || "ssh",
    [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), command],
    { timeoutMs: 30_000, signal }
  );
  const resolved = result.stdout.trim();
  if (!resolved.startsWith("/")) {
    throw new Error(`Remote worker path did not resolve to an absolute path: ${requested}`);
  }
  return resolved.replace(/\/+$/g, "") || "/";
}

async function readRemoteSetupState(
  worker: RemoteRunWorkerTarget,
  remoteBundlePath: string,
  remoteStatePath: string,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<{ manifest?: PortableAgentSetupManifest; state?: PortableSetupRemoteState }> {
  const manifestPath = `${remoteBundlePath}/manifest.json`;
  const command = [
    `test -f ${shellQuotePosix(manifestPath)} && cat ${shellQuotePosix(manifestPath)} || printf '{}'`,
    `printf '\\n'`,
    `test -f ${shellQuotePosix(remoteStatePath)} && cat ${shellQuotePosix(remoteStatePath)} || printf '{}'`
  ].join("; ");
  const result = await commandRunner(
    worker.sshPath?.trim() || "ssh",
    [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), command],
    { timeoutMs: 30_000, signal }
  );
  const [manifestLine = "{}", stateLine = "{}"] = result.stdout.trim().split(/\r?\n/);
  return {
    manifest: parseJsonRecord(manifestLine) as unknown as PortableAgentSetupManifest,
    state: parseJsonRecord(stateLine)
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function activateRemotePortableSetup(
  worker: RemoteRunWorkerTarget,
  remoteBundlePath: string,
  remoteStatePath: string,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<void> {
  const command = [
    "umask 077; node - --",
    shellQuotePosix(remoteBundlePath),
    shellQuotePosix(remoteStatePath)
  ].join(" ");
  const result = await commandRunner(
    worker.sshPath?.trim() || "ssh",
    [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), command],
    { input: remotePortableSetupActivationScript(), timeoutMs: 60_000, signal }
  );
  const parsed = parseJsonRecord(result.stdout.trim());
  if (parsed?.ok !== true || parsed.fingerprint === undefined) {
    throw new Error("Remote portable agent setup activation failed.");
  }
}

export function remotePortableSetupActivationScript(): string {
  return String.raw`const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bundleRoot = path.resolve(process.argv[3]);
const statePath = path.resolve(process.argv[4]);
const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.links) || typeof manifest.fingerprint !== "string") {
  throw new Error("invalid-portable-setup-manifest");
}
const home = os.homedir();
const roots = {
  codex: path.resolve(process.env.CODEX_HOME || path.join(home, ".codex")),
  agents: path.resolve(path.join(home, ".agents")),
  claude: path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
  gemini: path.resolve(path.join(home, ".gemini", "config"))
};
const setupRoot = path.dirname(statePath);
const backupRoot = path.join(setupRoot, "backups");
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const previous = readJson(statePath);
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const insideAnyRoot = (candidate) => Object.values(roots).some((root) => inside(root, candidate));
const previousLinks = new Map();
for (const link of Array.isArray(previous.links) ? previous.links : []) {
  if (!link || typeof link !== "object" || typeof link.source !== "string" || typeof link.target !== "string") {
    throw new Error("invalid-portable-setup-state-link");
  }
  const source = path.resolve(link.source);
  const target = path.resolve(link.target);
  const backup = typeof link.backup === "string" ? path.resolve(link.backup) : undefined;
  if (!inside(setupRoot, source) || !insideAnyRoot(target) || (backup && !inside(backupRoot, backup))) {
    throw new Error("unsafe-portable-setup-state-link");
  }
  if (previousLinks.has(target)) {
    throw new Error("duplicate-portable-setup-state-target");
  }
  previousLinks.set(target, { source, target, ...(backup ? { backup } : {}) });
}
const plannedTargets = new Set();
const planned = manifest.links.map((link) => {
  if (!roots[link.root] || typeof link.source !== "string" || typeof link.target !== "string") {
    throw new Error("invalid-portable-setup-link");
  }
  const source = path.resolve(bundleRoot, link.source);
  const target = path.resolve(roots[link.root], link.target);
  if (!inside(bundleRoot, source) || !inside(roots[link.root], target) || !fs.existsSync(source)) {
    throw new Error("unsafe-portable-setup-link");
  }
  if (plannedTargets.has(target)) {
    throw new Error("duplicate-portable-setup-target");
  }
  plannedTargets.add(target);
  return { source, target };
});
for (const old of previousLinks.values()) {
  let current;
  try { current = fs.lstatSync(old.target); } catch { continue; }
  if (!current.isSymbolicLink() || fs.readlinkSync(old.target) !== old.source) {
    throw new Error("managed-portable-setup-target-modified:" + old.target);
  }
}
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const temporary = statePath + ".tmp-" + process.pid;
const undo = [];
const pathEntryExists = (target) => {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code !== "ENOENT") { throw error; } return false; }
};
const unlinkIfPresent = (target) => {
  try { fs.unlinkSync(target); return true; } catch (error) { if (error.code !== "ENOENT") { throw error; } return false; }
};
try {
  const nextTargets = new Set(planned.map((link) => link.target));
  for (const old of previousLinks.values()) {
    if (nextTargets.has(old.target)) { continue; }
    if (unlinkIfPresent(old.target)) {
      undo.push(() => fs.symlinkSync(old.source, old.target, fs.statSync(old.source).isDirectory() ? "dir" : "file"));
    }
    if (old.backup && pathEntryExists(old.backup) && !pathEntryExists(old.target)) {
      fs.mkdirSync(path.dirname(old.target), { recursive: true, mode: 0o700 });
      fs.renameSync(old.backup, old.target);
      undo.push(() => fs.renameSync(old.target, old.backup));
    }
  }
  const nextStateLinks = [];
  for (const link of planned) {
    const old = previousLinks.get(link.target);
    let backup = old && old.backup;
    if (!old && pathEntryExists(link.target)) {
      backup = path.join(backupRoot, crypto.createHash("sha256").update(link.target).digest("hex"));
      if (pathEntryExists(backup)) { throw new Error("portable-setup-backup-conflict:" + backup); }
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      fs.renameSync(link.target, backup);
      undo.push(() => fs.renameSync(backup, link.target));
    }
    fs.mkdirSync(path.dirname(link.target), { recursive: true, mode: 0o700 });
    if (unlinkIfPresent(link.target) && old) {
      undo.push(() => fs.symlinkSync(old.source, old.target, fs.statSync(old.source).isDirectory() ? "dir" : "file"));
    }
    fs.symlinkSync(link.source, link.target, fs.statSync(link.source).isDirectory() ? "dir" : "file");
    undo.push(() => unlinkIfPresent(link.target));
    nextStateLinks.push({ source: link.source, target: link.target, ...(backup ? { backup } : {}) });
  }
  const nextState = { version: 1, fingerprint: manifest.fingerprint, links: nextStateLinks };
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(nextState) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, statePath);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch {}
  for (const rollback of undo.reverse()) {
    try { rollback(); } catch {}
  }
  throw error;
}
process.stdout.write(JSON.stringify({ ok: true, fingerprint: manifest.fingerprint }));
`;
}
