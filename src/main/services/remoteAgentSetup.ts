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
import { CLI_AGENT_RUN_TIMEOUT_MAX_MS } from "../../shared/cliAgentRunSettings";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand } from "./command";
import type { CommandOptions, CommandResult } from "./command";
import { defaultRemoteMirrorSync } from "./remoteMirrorSync";
import type { RemoteMirrorSyncRunner } from "./remoteMirrorSync";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export const PORTABLE_AGENT_SETUP_VERSION = 1;
const PORTABLE_SETUP_DIRNAME = "agent-setup";
const PORTABLE_SETUP_MAX_INVOCATION_CONFIG_BYTES = 64 * 1024;
const PORTABLE_SETUP_MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const PORTABLE_SETUP_MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const PORTABLE_SETUP_LARGE_FILE_COUNT = 50_000;
const PORTABLE_SETUP_LARGE_TOTAL_BYTES = 256 * 1024 * 1024;
const PORTABLE_SETUP_SYNC_TIMEOUT_MS = 10 * 60_000;
const PORTABLE_SETUP_RETENTION_MS = CLI_AGENT_RUN_TIMEOUT_MAX_MS + (24 * 60 * 60_000);
export interface PortableAgentSetupInvocation {
  fingerprint: string;
  codexConfigOverrides?: string[];
  claudeMcpServers?: Record<string, unknown>;
  advisories?: string[];
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
  sourceFingerprint: string;
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
  signal?: AbortSignal;
  sourceFingerprint?: string;
  preparedInvocation?: PortableAgentSetupPreparedInvocation;
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
  signal?: AbortSignal;
}

interface PortableAgentSetupPreparedInvocation {
  codexConfigOverrides?: string[];
  claudeMcpServers?: Record<string, unknown>;
  advisories?: string[];
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
  sourceFingerprint?: unknown;
}

export class DefaultRemoteAgentSetupSync implements RemoteAgentSetupSyncRunner {
  private readonly mirrorSync: RemoteMirrorSyncRunner;
  private readonly commandRunner: PortableCommandRunner;
  private readonly chainByWorker = new Map<string, Promise<PortableAgentSetupInvocation>>();
  private readonly setupRootByWorker = new Map<string, string>();
  private readonly preparedInvocationByRoots = new Map<string, {
    sourceStats: string;
    invocation: PortableAgentSetupPreparedInvocation;
  }>();

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
    const preparedInvocation = await this.prepareInvocation(roots, request.signal);
    const sourceFingerprint = await computePortableAgentSetupSourceFingerprint(
      roots,
      request.signal,
      preparedInvocation
    );
    const startedAt = Date.now();
    let setupRoot = this.setupRootByWorker.get(workerKey);
    if (!setupRoot) {
      setupRoot = await resolvePortableSetupRoot(request.worker, request.signal, this.commandRunner);
      this.setupRootByWorker.set(workerKey, setupRoot);
    }
    const remote = await readRemoteSetupState(
      request.worker,
      setupRoot,
      request.signal,
      this.commandRunner
    );
    if (
      remote.state?.sourceFingerprint === sourceFingerprint &&
      typeof remote.state.fingerprint === "string" &&
      remote.manifest?.version === PORTABLE_AGENT_SETUP_VERSION &&
      remote.manifest.fingerprint === remote.state.fingerprint &&
      remote.manifest.sourceFingerprint === sourceFingerprint
    ) {
      const invocation = portableInvocationFromPrepared(
        remote.state.fingerprint,
        preparedInvocation,
        remote.manifest
      );
      this.options.logger?.("remote-agent-setup.sync", {
        changed: false,
        durationMs: Date.now() - startedAt,
        fileCount: remote.manifest.fileCount,
        totalBytes: remote.manifest.totalBytes
      });
      return invocation;
    }
    const bundle = await buildPortableAgentSetupBundle({
      homeDir: roots.homeDir,
      codexHomeDir: roots.codexHomeDir,
      claudeConfigDir: roots.claudeConfigDir,
      geminiConfigDir: roots.geminiConfigDir,
      tempDir: this.options.tempDir,
      signal: request.signal,
      sourceFingerprint,
      preparedInvocation
    });
    const invocation = portableInvocationFromBundle(bundle);
    try {
      // Provider homes are deliberately shared, just like the user's local
      // global skill directories: an edit becomes visible to an in-flight CLI
      // when that CLI next reads SKILL.md rather than being frozen per run.
      const remoteBundlePath = `${setupRoot}/bundles/${bundle.fingerprint}`;
      const remoteStatePath = `${setupRoot}/state.json`;
      const bundleCurrent = remote.manifest?.version === PORTABLE_AGENT_SETUP_VERSION &&
        remote.manifest.fingerprint === bundle.fingerprint;
      if (!bundleCurrent) {
        await this.mirrorSync.syncUp({
          worker: request.worker,
          localPath: bundle.localPath,
          remotePath: remoteBundlePath,
          signal: request.signal,
          timeoutMs: PORTABLE_SETUP_SYNC_TIMEOUT_MS,
          contentMode: "exact"
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

  private async prepareInvocation(
    roots: PortableAgentSetupRoots,
    signal?: AbortSignal
  ): Promise<PortableAgentSetupPreparedInvocation> {
    const rootsKey = JSON.stringify({
      codexHomeDir: roots.codexHomeDir,
      homeDir: roots.homeDir
    });
    const sourceStats = await portableInvocationSourceStats(roots, signal);
    const cached = this.preparedInvocationByRoots.get(rootsKey);
    if (cached?.sourceStats === sourceStats) {
      return cached.invocation;
    }
    const invocation = await preparePortableAgentSetupInvocation(roots, signal);
    this.preparedInvocationByRoots.set(rootsKey, { sourceStats, invocation });
    if (this.preparedInvocationByRoots.size > 8) {
      const oldest = this.preparedInvocationByRoots.keys().next().value as string | undefined;
      if (oldest && oldest !== rootsKey) {
        this.preparedInvocationByRoots.delete(oldest);
      }
    }
    return invocation;
  }
}

export async function buildPortableAgentSetupBundle(
  options: PortableAgentSetupBuildOptions = {}
): Promise<PortableAgentSetupBundle> {
  const roots = resolvePortableAgentSetupRoots(options);
  const preparedInvocation = options.preparedInvocation ??
    await preparePortableAgentSetupInvocation(roots, options.signal);
  const sourceFingerprint = options.sourceFingerprint ??
    await computePortableAgentSetupSourceFingerprint(roots, options.signal, preparedInvocation);
  const stagingParent = options.tempDir ? path.resolve(options.tempDir) : tmpdir();
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(path.join(stagingParent, "accordagents-agent-setup-"));
  const bundleRoot = path.join(stagingRoot, "bundle");
  const links: PortableAgentSetupManifestLink[] = [];
  const budget: PortableCopyBudget = { fileCount: 0, totalBytes: 0, signal: options.signal };
  try {
    assertPortableSetupNotAborted(options.signal);
    await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
    const sharedClaudeSkillNames = await sharedPortableDirectoryNames(
      path.join(roots.codexHomeDir, "skills"),
      path.join(roots.claudeConfigDir, "skills")
    );
    await copyPortableSkillRoot(
      path.join(roots.codexHomeDir, "skills"),
      path.join(bundleRoot, "codex", "skills"),
      "codex/skills",
      "codex",
      "skills",
      links,
      budget,
      sharedClaudeSkillNames
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
    await copyPortableSkillRoot(
      path.join(roots.claudeConfigDir, "skills"),
      path.join(bundleRoot, "claude", "skills"),
      "claude/skills",
      "claude",
      "skills",
      links,
      budget
    );
    for (const skillName of sharedClaudeSkillNames) {
      const claudeSource = `claude/skills/${skillName}`;
      if (links.some((link) => link.root === "claude" && link.source === claudeSource)) {
        links.push({ source: claudeSource, root: "codex", target: `skills/${skillName}` });
      }
    }
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

    assertPortableSetupNotAborted(options.signal);
    const codexConfigOverrides = preparedInvocation.codexConfigOverrides ?? [];
    const claudeMcpServers = preparedInvocation.claudeMcpServers;
    if (claudeMcpServers && Object.keys(claudeMcpServers).length > 0) {
      await writePortableFile(
        path.join(bundleRoot, "claude", "mcp.json"),
        `${JSON.stringify({ mcpServers: claudeMcpServers }, null, 2)}\n`,
        budget
      );
    }
    const advisories = [
      ...(preparedInvocation.advisories ?? []),
      ...portableAgentSetupScaleAdvisories(budget.fileCount, budget.totalBytes)
    ];
    const bundledInvocation: PortableAgentSetupPreparedInvocation = {
      ...preparedInvocation,
      ...(advisories.length > 0 ? { advisories } : {})
    };
    await writePortableFile(
      path.join(bundleRoot, "invocation.json"),
      `${JSON.stringify(bundledInvocation, null, 2)}\n`,
      budget
    );

    links.sort(comparePortableLinks);
    const fingerprint = await hashPortableBundle(bundleRoot, options.signal);
    const manifest: PortableAgentSetupManifest = {
      version: PORTABLE_AGENT_SETUP_VERSION,
      fingerprint,
      sourceFingerprint,
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
      ...(claudeMcpServers ? { claudeMcpServers } : {}),
      ...(advisories.length > 0 ? { advisories } : {}),
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
    if (!namespace || !["mcp_servers", "features"].includes(namespace)) {
      continue;
    }
    const tableName = unquoteTomlTableHeader(header);
    if (/^mcp_servers\.(?:accord_agents|"accord_agents")(?:\.|$)/.test(tableName)) {
      continue;
    }
    const family = tomlPortableFamily(header, namespace);
    if (namespace === "mcp_servers" && /\.env$/.test(tableName)) {
      if (family) {
        rejectedFamilies.add(family);
      }
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
  const lines = config.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line)) {
      table = unquoteTomlTableHeader(line);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (table && assignment) {
      let rawValue = assignment[2];
      while (!isCompletePortableTomlValue(rawValue) && index + 1 < lines.length) {
        index += 1;
        rawValue += `\n${lines[index]}`;
      }
      if (isCompletePortableTomlValue(rawValue)) {
        overrides.push(`${table}.${assignment[1]}=${rawValue}`);
      }
    }
  }
  return overrides;
}

function portableInvocationFromBundle(bundle: PortableAgentSetupBundle): PortableAgentSetupInvocation {
  return portableInvocationFromPrepared(bundle.fingerprint, bundle);
}

function portableInvocationFromPrepared(
  fingerprint: string,
  prepared: PortableAgentSetupPreparedInvocation,
  manifest?: Pick<PortableAgentSetupManifest, "fileCount" | "totalBytes">
): PortableAgentSetupInvocation {
  const advisories = [
    ...(prepared.advisories ?? []),
    ...(manifest
      ? portableAgentSetupScaleAdvisories(manifest.fileCount, manifest.totalBytes)
      : [])
  ];
  return {
    fingerprint,
    ...(prepared.codexConfigOverrides ? { codexConfigOverrides: prepared.codexConfigOverrides } : {}),
    ...(prepared.claudeMcpServers ? { claudeMcpServers: prepared.claudeMcpServers } : {}),
    ...(advisories.length > 0 ? { advisories: [...new Set(advisories)] } : {})
  };
}

export function portableAgentSetupScaleAdvisories(fileCount: number, totalBytes: number): string[] {
  if (fileCount < PORTABLE_SETUP_LARGE_FILE_COUNT && totalBytes < PORTABLE_SETUP_LARGE_TOTAL_BYTES) {
    return [];
  }
  const sizeMiB = Math.ceil(totalBytes / (1024 * 1024));
  return [
    `Portable cloud setup contains ${fileCount.toLocaleString("en-US")} files (${sizeMiB.toLocaleString("en-US")} MiB); the initial worker upload may take longer than usual.`
  ];
}

async function preparePortableAgentSetupInvocation(
  roots: PortableAgentSetupRoots,
  signal?: AbortSignal
): Promise<PortableAgentSetupPreparedInvocation> {
  assertPortableSetupNotAborted(signal);
  const advisories: string[] = [];
  const codexSource = await readPortableConfigText(
    path.join(roots.codexHomeDir, "config.toml"),
    PORTABLE_SETUP_MAX_CODEX_CONFIG_BYTES,
    "Codex config.toml",
    advisories,
    signal
  );
  let codexConfigOverrides = codexPortableConfigOverrides(
    codexSource ? sanitizeCodexPortableConfig(codexSource) : ""
  );
  if (portableConfigBytes(codexConfigOverrides) > PORTABLE_SETUP_MAX_INVOCATION_CONFIG_BYTES) {
    codexConfigOverrides = [];
    advisories.push("Codex MCP and feature configuration was not forwarded because its safe command-line form exceeds 64 KB.");
  }
  const claudeMcpSource = await readPortableJsonRecord(
    path.join(roots.homeDir, ".claude.json"),
    PORTABLE_SETUP_MAX_CLAUDE_CONFIG_BYTES,
    "Claude .claude.json",
    advisories,
    signal
  );
  let claudeMcpServers = sanitizeClaudeMcpServers(claudeMcpSource?.mcpServers);
  if (portableConfigBytes(
    claudeMcpServers ? [JSON.stringify({ mcpServers: claudeMcpServers })] : []
  ) > PORTABLE_SETUP_MAX_INVOCATION_CONFIG_BYTES) {
    claudeMcpServers = undefined;
    advisories.push("Claude MCP configuration was not forwarded because its safe command-line form exceeds 64 KB.");
  }
  return {
    ...(codexConfigOverrides.length > 0 ? { codexConfigOverrides } : {}),
    ...(claudeMcpServers ? { claudeMcpServers } : {}),
    ...(advisories.length > 0 ? { advisories } : {})
  };
}

function portableConfigBytes(values: readonly string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value), 0);
}

async function portableInvocationSourceStats(
  roots: PortableAgentSetupRoots,
  signal?: AbortSignal
): Promise<string> {
  const records = [];
  for (const filePath of [
    path.join(roots.codexHomeDir, "config.toml"),
    path.join(roots.homeDir, ".claude.json")
  ]) {
    assertPortableSetupNotAborted(signal);
    const fileStats = await lstat(filePath).catch(() => undefined);
    records.push(fileStats?.isFile()
      ? [fileStats.size, fileStats.mtimeMs, fileStats.ctimeMs, fileStats.ino]
      : null);
  }
  return JSON.stringify(records);
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

async function sharedPortableDirectoryNames(leftRoot: string, rightRoot: string): Promise<Set<string>> {
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

async function writePortableFile(
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

function isExcludedPortableRootName(name: string): boolean {
  return name.startsWith(".");
}

function isExcludedPortableNestedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === ".ds_store" || normalized === ".git" ||
    normalized === ".env" || normalized.startsWith(".env.") ||
    normalized === "auth.json" || normalized === "credentials.json";
}

async function hashPortableBundle(bundleRoot: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`portable-agent-setup-v${PORTABLE_AGENT_SETUP_VERSION}\0`);
  await hashPortableEntry(bundleRoot, "", hash, signal);
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

async function computePortableAgentSetupSourceFingerprint(
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
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) {
      if (/^\s*(?:\[|#|$)/.test(line)) {
        result.push(line);
        continue;
      }
      return undefined;
    }
    const key = assignment[1].toLowerCase();
    const assignmentLines = [line];
    let rawValue = assignment[2];
    while (!isCompletePortableTomlValue(rawValue) && index + 1 < lines.length) {
      index += 1;
      assignmentLines.push(lines[index]);
      rawValue += `\n${lines[index]}`;
    }
    if (!isCompletePortableTomlValue(rawValue)) {
      return undefined;
    }
    if (key === "env") {
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
    result.push(...assignmentLines);
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

async function readPortableConfigText(
  filePath: string,
  maximumBytes: number,
  label: string,
  advisories: string[],
  signal?: AbortSignal
): Promise<string | undefined> {
  assertPortableSetupNotAborted(signal);
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  if (!fileStats.isFile()) {
    return undefined;
  }
  if (fileStats.size > maximumBytes) {
    advisories.push(`${label} was not forwarded because it exceeds ${Math.floor(maximumBytes / (1024 * 1024)) || maximumBytes / 1024} MB.`);
    return undefined;
  }
  return readFile(filePath, { encoding: "utf8", signal });
}

async function readPortableJsonRecord(
  filePath: string,
  maximumBytes: number,
  label: string,
  advisories: string[],
  signal?: AbortSignal
): Promise<Record<string, unknown> | undefined> {
  const contents = await readPortableConfigText(filePath, maximumBytes, label, advisories, signal);
  if (contents === undefined) {
    return undefined;
  }
  try {
    const value = JSON.parse(contents) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    advisories.push(`${label} was not forwarded because it is not valid JSON.`);
    return undefined;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function assertPortableSetupNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The portable agent setup was aborted.", "AbortError");
  }
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

async function resolvePortableSetupRoot(
  worker: RemoteRunWorkerTarget,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<string> {
  const requested = worker.workerRoot?.trim() || "~/.accordagents/remote-runs";
  const sharedRequested = requested.replace(/\/+$/g, "").replace(/\/devices\/[^/]+$/, "") || "/";
  if (sharedRequested.startsWith("/")) {
    return path.posix.join(sharedRequested, PORTABLE_SETUP_DIRNAME);
  }
  const relative = sharedRequested === "~"
    ? ""
    : sharedRequested.startsWith("~/")
      ? sharedRequested.slice(2)
      : sharedRequested;
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
  return path.posix.join(resolved.replace(/\/+$/g, "") || "/", PORTABLE_SETUP_DIRNAME);
}

async function readRemoteSetupState(
  worker: RemoteRunWorkerTarget,
  setupRoot: string,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<{ manifest?: PortableAgentSetupManifest; state?: PortableSetupRemoteState }> {
  const statePath = `${setupRoot}/state.json`;
  const script = String.raw`const fs=require("fs"),path=require("path");const root=path.resolve(process.argv[1]);const statePath=path.join(root,"state.json");let state={};try{state=JSON.parse(fs.readFileSync(statePath,"utf8"))}catch{}let manifest={};if(typeof state.fingerprint==="string"&&/^[a-f0-9]{64}$/.test(state.fingerprint)){try{manifest=JSON.parse(fs.readFileSync(path.join(root,"bundles",state.fingerprint,"manifest.json"),"utf8"))}catch{}}process.stdout.write(JSON.stringify({marker:"portable-agent-setup-probe-v1",state,manifest}));`;
  const command = `node -e ${shellQuotePosix(script)} ${shellQuotePosix(setupRoot)}`;
  const result = await commandRunner(
    worker.sshPath?.trim() || "ssh",
    [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), command],
    { timeoutMs: 30_000, signal }
  );
  const probe = parseJsonRecord(result.stdout.trim());
  if (probe?.marker !== "portable-agent-setup-probe-v1") {
    return {};
  }
  return {
    manifest: isRecord(probe.manifest)
      ? probe.manifest as unknown as PortableAgentSetupManifest
      : undefined,
    state: isRecord(probe.state) ? probe.state : undefined
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
  let result: CommandResult;
  try {
    result = await commandRunner(
      worker.sshPath?.trim() || "ssh",
      [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), command],
      { input: remotePortableSetupActivationScript(), timeoutMs: 60_000, signal }
    );
  } catch (error) {
    if (error instanceof CommandError) {
      throw new Error(`Remote portable agent setup activation failed: ${portableSetupCommandErrorDetail(error)}`);
    }
    throw error;
  }
  const parsed = parseJsonRecord(result.stdout.trim());
  if (parsed?.ok !== true || parsed.fingerprint === undefined) {
    throw new Error("Remote portable agent setup activation failed.");
  }
}

function portableSetupCommandErrorDetail(error: CommandError): string {
  if (error.result.timedOut) {
    return "timed out";
  }
  const detail = error.result.stderr.trim() || error.result.stdout.trim();
  return detail ? detail.slice(0, 2000) : `exit code ${error.result.exitCode ?? "unknown"}`;
}

export function remotePortableSetupActivationScript(): string {
  return String.raw`const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bundleRoot = path.resolve(process.argv[3]);
const statePath = path.resolve(process.argv[4]);
const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.links) ||
    typeof manifest.fingerprint !== "string" || typeof manifest.sourceFingerprint !== "string") {
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
const bundlesRoot = path.join(setupRoot, "bundles");
const backupRoot = path.join(setupRoot, "backups");
const lockPath = path.join(setupRoot, ".activation-lock");
const retentionMs = ${PORTABLE_SETUP_RETENTION_MS};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const insideAnyRoot = (candidate) => Object.values(roots).some((root) => inside(root, candidate));
const pathEntryExists = (target) => {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code !== "ENOENT") { throw error; } return false; }
};
const unlinkIfPresent = (target) => {
  try { fs.unlinkSync(target); return true; } catch (error) { if (error.code !== "ENOENT") { throw error; } return false; }
};
const symlinkTarget = (target) => path.resolve(path.dirname(target), fs.readlinkSync(target));
const legacySetupRoots = [];
const devicesRoot = path.join(home, ".accordagents", "remote-runs", "devices");
try {
  for (const device of fs.readdirSync(devicesRoot)) {
    legacySetupRoots.push(path.join(devicesRoot, device, "agent-setup"));
  }
} catch {}
const managedSetupRoots = [setupRoot, ...legacySetupRoots];
const isManagedSource = (source) => managedSetupRoots.some((root) => inside(root, source));
const isManagedBundle = (candidate) => managedSetupRoots.some((root) =>
  inside(path.join(root, "bundles"), candidate) || candidate === path.join(root, "bundle")
);
const isManagedRetiredRoot = (candidate) =>
  isManagedBundle(candidate) || legacySetupRoots.includes(candidate);
const bundleForSource = (source) => {
  for (const root of managedSetupRoots) {
    const legacy = path.join(root, "bundle");
    if (inside(legacy, source)) { return legacy; }
    const parent = path.join(root, "bundles");
    if (inside(parent, source)) {
      const first = path.relative(parent, source).split(path.sep)[0];
      if (first) { return path.join(parent, first); }
    }
  }
  return undefined;
};
const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
fs.mkdirSync(setupRoot, { recursive: true, mode: 0o700 });
const lockDeadline = Date.now() + 55000;
while (true) {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    break;
  } catch (error) {
    if (error.code !== "EEXIST") { throw error; }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > 120000) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {}
    if (Date.now() >= lockDeadline) { throw new Error("portable-setup-lock-timeout"); }
    wait(25);
  }
}
try {
  const previous = readJson(statePath);
  const previousLinks = new Map();
  for (const link of Array.isArray(previous.links) ? previous.links : []) {
    if (!link || typeof link !== "object" || typeof link.source !== "string" || typeof link.target !== "string") {
      throw new Error("invalid-portable-setup-state-link");
    }
    const source = path.resolve(link.source);
    const target = path.resolve(link.target);
    const backup = typeof link.backup === "string" ? path.resolve(link.backup) : undefined;
    if (!isManagedSource(source) || !insideAnyRoot(target) || (backup && !inside(backupRoot, backup))) {
      throw new Error("unsafe-portable-setup-state-link");
    }
    if (previousLinks.has(target)) { throw new Error("duplicate-portable-setup-state-target"); }
    previousLinks.set(target, { source, target, ...(backup ? { backup } : {}) });
  }
  const migratedLegacyRoots = new Set();
  for (const legacyRoot of legacySetupRoots) {
    const legacyStatePath = path.join(legacyRoot, "state.json");
    if (!fs.existsSync(legacyStatePath)) { continue; }
    const legacy = readJson(legacyStatePath);
    const rawLinks = Array.isArray(legacy.links) ? legacy.links : [];
    if (rawLinks.length === 0) { continue; }
    const imported = [];
    const claimedBackups = new Set();
    let safe = true;
    for (const link of rawLinks) {
      if (!link || typeof link !== "object" || typeof link.source !== "string" || typeof link.target !== "string") {
        safe = false;
        break;
      }
      const source = path.resolve(link.source);
      const target = path.resolve(link.target);
      const backup = typeof link.backup === "string" ? path.resolve(link.backup) : undefined;
      const legacyBackupRoot = path.join(legacyRoot, "backups");
      if (!inside(legacyRoot, source) || !insideAnyRoot(target) || !pathEntryExists(source) ||
          (backup && !inside(legacyBackupRoot, backup))) {
        safe = false;
        break;
      }
      if (backup) { claimedBackups.add(backup); }
      if (previousLinks.has(target)) { continue; }
      if (pathEntryExists(target)) {
        const current = fs.lstatSync(target);
        if (!current.isSymbolicLink() || symlinkTarget(target) !== source) {
          safe = false;
          break;
        }
      }
      imported.push({ source, target, ...(backup ? { backup } : {}) });
    }
    try {
      for (const name of fs.readdirSync(path.join(legacyRoot, "backups"))) {
        if (!claimedBackups.has(path.join(legacyRoot, "backups", name))) {
          safe = false;
          break;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") { safe = false; }
    }
    if (!safe) { continue; }
    for (const link of imported) { previousLinks.set(link.target, link); }
    migratedLegacyRoots.add(legacyRoot);
  }
  const plannedTargets = new Set();
  const planned = manifest.links.map((link) => {
    if (!link || typeof link !== "object" || !roots[link.root] ||
        typeof link.source !== "string" || typeof link.target !== "string") {
      throw new Error("invalid-portable-setup-link");
    }
    const source = path.resolve(bundleRoot, link.source);
    const target = path.resolve(roots[link.root], link.target);
    if (!inside(bundleRoot, source) || !inside(roots[link.root], target) || !fs.existsSync(source)) {
      throw new Error("unsafe-portable-setup-link");
    }
    if (plannedTargets.has(target)) { throw new Error("duplicate-portable-setup-target"); }
    plannedTargets.add(target);
    return { source, target };
  });
  for (const old of previousLinks.values()) {
    if (!pathEntryExists(old.target)) { continue; }
    const current = fs.lstatSync(old.target);
    if (!current.isSymbolicLink() || symlinkTarget(old.target) !== old.source) {
      throw new Error("managed-portable-setup-target-modified:" + old.target);
    }
  }
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const temporary = statePath + ".tmp-" + process.pid;
  const undo = [];
  let committed = false;
  try {
  for (const old of previousLinks.values()) {
    if (!old.backup || inside(backupRoot, old.backup) || !pathEntryExists(old.backup)) { continue; }
    const migratedBackup = path.join(backupRoot, crypto.createHash("sha256").update(old.target).digest("hex"));
    if (pathEntryExists(migratedBackup)) { throw new Error("portable-setup-backup-conflict:" + migratedBackup); }
    fs.renameSync(old.backup, migratedBackup);
    const legacyBackup = old.backup;
    old.backup = migratedBackup;
    undo.push(() => {
      fs.renameSync(migratedBackup, legacyBackup);
      old.backup = legacyBackup;
    });
  }
  const nextTargets = new Set(planned.map((link) => link.target));
  const adoptedBundleRoots = new Set();
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
  for (let index = 0; index < planned.length; index += 1) {
    const link = planned[index];
    const old = previousLinks.get(link.target);
    let backup = old && old.backup;
    if (!old && pathEntryExists(link.target)) {
      const existing = fs.lstatSync(link.target);
      const adoptManaged = existing.isSymbolicLink() && isManagedSource(symlinkTarget(link.target));
      if (adoptManaged) {
        const adoptedSource = symlinkTarget(link.target);
        const adoptedBundle = bundleForSource(adoptedSource);
        if (adoptedBundle && adoptedBundle !== bundleRoot) { adoptedBundleRoots.add(adoptedBundle); }
        unlinkIfPresent(link.target);
        undo.push(() => fs.symlinkSync(adoptedSource, link.target, fs.statSync(adoptedSource).isDirectory() ? "dir" : "file"));
      } else {
        backup = path.join(backupRoot, crypto.createHash("sha256").update(link.target).digest("hex"));
        if (pathEntryExists(backup)) { throw new Error("portable-setup-backup-conflict:" + backup); }
        fs.renameSync(link.target, backup);
        undo.push(() => fs.renameSync(backup, link.target));
      }
    }
    fs.mkdirSync(path.dirname(link.target), { recursive: true, mode: 0o700 });
    if (unlinkIfPresent(link.target) && old) {
      undo.push(() => fs.symlinkSync(old.source, old.target, fs.statSync(old.source).isDirectory() ? "dir" : "file"));
    }
    const temporaryLink = link.target + ".accordagents-" + process.pid + "-" + index;
    unlinkIfPresent(temporaryLink);
    fs.symlinkSync(link.source, temporaryLink, fs.statSync(link.source).isDirectory() ? "dir" : "file");
    fs.renameSync(temporaryLink, link.target);
    undo.push(() => unlinkIfPresent(link.target));
    nextStateLinks.push({ source: link.source, target: link.target, ...(backup ? { backup } : {}) });
  }
  const retired = Array.isArray(previous.retired) ? previous.retired.filter((entry) =>
    entry && typeof entry.root === "string" && typeof entry.retiredAt === "number" && isManagedRetiredRoot(path.resolve(entry.root))
  ).map((entry) => ({ root: path.resolve(entry.root), retiredAt: entry.retiredAt })) : [];
  for (const adoptedRoot of adoptedBundleRoots) {
    if (isManagedBundle(adoptedRoot) && !retired.some((entry) => entry.root === adoptedRoot)) {
      retired.push({ root: adoptedRoot, retiredAt: Date.now() });
    }
  }
  for (const legacyRoot of migratedLegacyRoots) {
    if (!retired.some((entry) => entry.root === legacyRoot)) {
      retired.push({ root: legacyRoot, retiredAt: Date.now() });
    }
  }
  if (typeof previous.fingerprint === "string" && previous.fingerprint !== manifest.fingerprint) {
    for (const old of previousLinks.values()) {
      const candidate = bundleForSource(old.source);
      if (candidate && candidate !== bundleRoot && isManagedBundle(candidate) && !retired.some((entry) => entry.root === candidate)) {
        retired.push({ root: candidate, retiredAt: Date.now() });
      }
    }
  }
  const nextState = {
    version: 1,
    fingerprint: manifest.fingerprint,
    sourceFingerprint: manifest.sourceFingerprint,
    links: nextStateLinks,
    retired
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(nextState) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, statePath);
  committed = true;
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    if (!committed) {
      for (const rollback of undo.reverse()) { try { rollback(); } catch {} }
    }
    throw error;
  }
  try {
    const current = readJson(statePath);
    const activeRoots = new Set([bundleRoot]);
    for (const link of Array.isArray(current.links) ? current.links : []) {
      if (link && typeof link.source === "string") {
        const activeRoot = bundleForSource(path.resolve(link.source));
        if (activeRoot) { activeRoots.add(activeRoot); }
      }
    }
    const kept = [];
    for (const entry of Array.isArray(current.retired) ? current.retired : []) {
      const retiredRoot = entry && typeof entry.root === "string" ? path.resolve(entry.root) : "";
      const containsActiveRoot = [...activeRoots].some((activeRoot) => inside(retiredRoot, activeRoot));
      if (!retiredRoot || !isManagedRetiredRoot(retiredRoot) || retiredRoot === bundleRoot || containsActiveRoot) { continue; }
      if (typeof entry.retiredAt === "number" && Date.now() - entry.retiredAt >= retentionMs) {
        try { fs.rmSync(retiredRoot, { recursive: true, force: true }); } catch { kept.push(entry); }
      } else { kept.push(entry); }
    }
    current.retired = kept;
    const cleanupState = statePath + ".gc-" + process.pid;
    try {
      fs.writeFileSync(cleanupState, JSON.stringify(current) + "\n", { mode: 0o600 });
      fs.renameSync(cleanupState, statePath);
    } catch { try { fs.unlinkSync(cleanupState); } catch {} }
    try {
      const retiredRoots = new Set((Array.isArray(current.retired) ? current.retired : [])
        .map((entry) => entry && typeof entry.root === "string" ? path.resolve(entry.root) : undefined)
        .filter(Boolean));
      for (const name of fs.readdirSync(bundlesRoot)) {
        const candidate = path.join(bundlesRoot, name);
        const stats = fs.statSync(candidate);
        if (!activeRoots.has(candidate) && !retiredRoots.has(candidate) &&
            Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) >= retentionMs) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      }
    } catch {}
    try {
      const claimed = new Set((Array.isArray(current.links) ? current.links : [])
        .map((link) => link && typeof link.backup === "string" ? path.resolve(link.backup) : undefined)
        .filter(Boolean));
      for (const name of fs.readdirSync(backupRoot)) {
        const candidate = path.join(backupRoot, name);
        const stats = fs.statSync(candidate);
        if (!claimed.has(candidate) && Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) >= retentionMs) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      }
    } catch {}
  } catch {}
  process.stdout.write(JSON.stringify({ ok: true, fingerprint: manifest.fingerprint }));
} finally {
  fs.rmSync(lockPath, { recursive: true, force: true });
}
`;
}
