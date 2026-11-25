import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  PORTABLE_AGENT_SETUP_VERSION, PORTABLE_SETUP_LARGE_FILE_COUNT, PORTABLE_SETUP_LARGE_TOTAL_BYTES,
  PORTABLE_SETUP_MAX_CLAUDE_CONFIG_BYTES, PORTABLE_SETUP_MAX_CODEX_CONFIG_BYTES, PORTABLE_SETUP_MAX_INVOCATION_CONFIG_BYTES
} from "./constants";
import { computePortableAgentSetupSourceFingerprint, hashPortableBundle } from "./fingerprint";
import {
  codexPortableConfigOverrides, readPortableConfigText, readPortableJsonRecord, sanitizeClaudeMcpServers,
  sanitizeCodexPortableConfig
} from "./portableConfig";
import {
  assertPortableSetupNotAborted, copyPortableLinkedDirectoryEntries, copyPortableLinkedFile, copyPortableSkillRoot,
  sharedPortableDirectoryNames, writePortableFile
} from "./portableCopy";
import type {
  PortableAgentSetupBuildOptions, PortableAgentSetupBundle, PortableAgentSetupInvocation, PortableAgentSetupManifest,
  PortableAgentSetupManifestLink, PortableAgentSetupPreparedInvocation, PortableAgentSetupRoots, PortableCopyBudget
} from "./types";

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

export function portableInvocationFromBundle(bundle: PortableAgentSetupBundle): PortableAgentSetupInvocation {
  return portableInvocationFromPrepared(bundle.fingerprint, bundle);
}

export function portableInvocationFromPrepared(
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

export async function preparePortableAgentSetupInvocation(
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

export async function portableInvocationSourceStats(
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

export function resolvePortableAgentSetupRoots(
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

function comparePortableLinks(left: PortableAgentSetupManifestLink, right: PortableAgentSetupManifestLink): number {
  return `${left.root}/${left.target}`.localeCompare(`${right.root}/${right.target}`);
}
