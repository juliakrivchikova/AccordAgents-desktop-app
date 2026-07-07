import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ChatProviderKind,
  PluginCatalogItem,
  PluginInstallRecord,
  PluginInvocationDescriptor,
  PluginListDiagnostics,
  PluginListRequest,
  PluginListResult,
  PluginProviderAvailability,
  PluginSourceScope,
  UserSkillCapabilityState,
  UserSkillSummary
} from "../../shared/types";
import { UserSkillsService } from "./userSkills";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CODEX_CACHE_MAX_DEPTH = 5;
const PROVIDERS: ChatProviderKind[] = ["codex-cli", "claude-code"];
const ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

interface PluginServiceOptions {
  homeDir?: string;
  userSkills: UserSkillsService;
  now?: () => Date;
}

interface ManifestSource {
  manifestPath: string;
  pluginPath: string;
  manifestKind: "codex" | "claude";
  providerKind: ChatProviderKind;
  sourceScope: PluginSourceScope;
  sourceLabel: string;
  marketplacePath?: string;
  entry?: Record<string, unknown>;
}

export class PluginService {
  private readonly homeDir: string;
  private readonly userSkills: UserSkillsService;
  private readonly now: () => Date;

  constructor(options: PluginServiceOptions) {
    this.homeDir = path.resolve(options.homeDir ?? homedir());
    this.userSkills = options.userSkills;
    this.now = options.now ?? (() => new Date());
  }

  async list(request: PluginListRequest = {}, skillOverride?: UserSkillSummary[]): Promise<PluginListResult> {
    const repoPath = typeof request.repoPath === "string" && request.repoPath.trim()
      ? request.repoPath
      : undefined;
    const diagnostics: PluginListDiagnostics = {
      checkedSources: [],
      errors: [],
      updatedAt: this.now().toISOString()
    };
    const skills = skillOverride ?? (await this.userSkills.listAll({ repoPath, limit: MAX_LIMIT })).skills;
    const installRecordsByName = await this.installedPlugins(diagnostics);
    const sources = await this.manifestSources(repoPath, diagnostics);
    const plugins: PluginCatalogItem[] = [];
    const pluginIndexByIdentity = new Map<string, number>();
    for (const source of sources) {
      diagnostics.checkedSources.push(source.manifestPath);
      try {
        const parsed = await readJsonRecord(source.manifestPath);
        const item = await this.catalogItemFromManifest(source, parsed, skills, installRecordsByName);
        const identityKey = pluginIdentityKey(item);
        const existingIndex = pluginIndexByIdentity.get(identityKey);
        if (existingIndex === undefined) {
          pluginIndexByIdentity.set(identityKey, plugins.length);
          plugins.push(item);
        } else if (installPriority(item) > installPriority(plugins[existingIndex])) {
          plugins[existingIndex] = mergePluginCatalogItem(item, plugins[existingIndex]);
        } else {
          plugins[existingIndex] = mergePluginCatalogItem(plugins[existingIndex], item);
        }
      } catch (error) {
        diagnostics.errors.push(`${source.manifestPath}: ${errorText(error)}`);
      }
    }
    this.addInstalledFallbackItems(plugins, pluginIndexByIdentity, installRecordsByName);
    backfillPluginIconMetadata(plugins);
    const query = typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
    const limit = normalizeLimit(request.limit);
    return {
      plugins: plugins
        .filter((plugin) => pluginMatchesQuery(plugin, query))
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .slice(0, limit),
      diagnostics
    };
  }

  async refresh(request: PluginListRequest = {}, skillOverride?: UserSkillSummary[]): Promise<PluginListResult> {
    return this.list(request, skillOverride);
  }

  private async manifestSources(repoPath: string | undefined, diagnostics: PluginListDiagnostics): Promise<ManifestSource[]> {
    const sources: ManifestSource[] = [];
    await this.addMarketplaceSources(sources, diagnostics, {
      marketplacePath: path.join(this.homeDir, ".agents", "plugins", "marketplace.json"),
      sourceScope: "personal",
      sourceLabel: "Personal marketplace"
    });
    if (repoPath) {
      const repoRealPath = await realpath(repoPath).catch(() => undefined);
      if (repoRealPath) {
        await this.addMarketplaceSources(sources, diagnostics, {
          marketplacePath: path.join(repoRealPath, ".agents", "plugins", "marketplace.json"),
          sourceScope: "workspace",
          sourceLabel: "Workspace marketplace"
        });
        const repoManifestPath = path.join(repoRealPath, ".codex-plugin", "plugin.json");
        if (await isFile(repoManifestPath)) {
          sources.push({
            manifestPath: repoManifestPath,
            pluginPath: repoRealPath,
            manifestKind: "codex",
            providerKind: "codex-cli",
            sourceScope: "workspace",
            sourceLabel: "Workspace plugin"
          });
        }
      }
    }
    sources.push(...await this.codexCacheSources(diagnostics));
    sources.push(...await this.claudeCacheSources(diagnostics));
    return sources;
  }

  private async addMarketplaceSources(
    sources: ManifestSource[],
    diagnostics: PluginListDiagnostics,
    options: { marketplacePath: string; sourceScope: PluginSourceScope; sourceLabel: string }
  ): Promise<void> {
    diagnostics.checkedSources.push(options.marketplacePath);
    if (!(await isFile(options.marketplacePath))) {
      return;
    }
    try {
      const marketplace = await readJsonRecord(options.marketplacePath);
      for (const entry of marketplaceEntries(marketplace)) {
        const pluginPath = await this.pluginPathForMarketplaceEntry(options.marketplacePath, entry);
        const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
        if (await isFile(manifestPath)) {
          sources.push({
            manifestPath,
            pluginPath,
            manifestKind: "codex",
            providerKind: "codex-cli",
            sourceScope: options.sourceScope,
            sourceLabel: options.sourceLabel,
            marketplacePath: options.marketplacePath,
            entry
          });
        } else {
          const name = stringValue(entry.name) ?? stringValue(entry.id) ?? pluginPath;
          diagnostics.errors.push(`${options.marketplacePath}: ${name} has no .codex-plugin/plugin.json`);
        }
      }
    } catch (error) {
      diagnostics.errors.push(`${options.marketplacePath}: ${errorText(error)}`);
    }
  }

  private async pluginPathForMarketplaceEntry(marketplacePath: string, entry: Record<string, unknown>): Promise<string> {
    const source = isRecord(entry.source) ? entry.source : {};
    const sourcePath = stringValue(source.path) ?? stringValue(entry.path) ?? stringValue(entry.localPath);
    const base = path.dirname(marketplacePath);
    if (sourcePath) {
      return path.resolve(base, sourcePath);
    }
    const name = stringValue(entry.name) ?? stringValue(entry.id);
    return path.resolve(base, name ?? ".");
  }

  private async codexCacheSources(diagnostics: PluginListDiagnostics): Promise<ManifestSource[]> {
    const cacheRoot = path.join(this.homeDir, ".codex", "plugins", "cache");
    diagnostics.checkedSources.push(cacheRoot);
    return this.codexCacheManifestSources(cacheRoot, cacheRoot, 0);
  }

  private async codexCacheManifestSources(cacheRoot: string, dirPath: string, depth: number): Promise<ManifestSource[]> {
    const sources: ManifestSource[] = [];
    const codexManifestPath = path.join(dirPath, ".codex-plugin", "plugin.json");
    if (await isFile(codexManifestPath)) {
      sources.push({
        manifestPath: codexManifestPath,
        pluginPath: dirPath,
        manifestKind: "codex",
        providerKind: "codex-cli",
        sourceScope: "bundled",
        sourceLabel: cacheSourceLabel(cacheRoot, dirPath)
      });
    }
    const claudeManifestPath = path.join(dirPath, ".claude-plugin", "plugin.json");
    if (await isFile(claudeManifestPath)) {
      sources.push({
        manifestPath: claudeManifestPath,
        pluginPath: dirPath,
        manifestKind: "claude",
        providerKind: "codex-cli",
        sourceScope: "bundled",
        sourceLabel: cacheSourceLabel(cacheRoot, dirPath)
      });
    }
    if (depth >= CODEX_CACHE_MAX_DEPTH) {
      return sources;
    }
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name === ".codex-plugin") {
        continue;
      }
      sources.push(...await this.codexCacheManifestSources(cacheRoot, path.join(dirPath, entry.name), depth + 1));
    }
    return sources;
  }

  private async claudeCacheSources(diagnostics: PluginListDiagnostics): Promise<ManifestSource[]> {
    const cacheRoot = path.join(this.homeDir, ".claude", "plugins", "cache");
    diagnostics.checkedSources.push(cacheRoot);
    return this.claudeCacheManifestSources(cacheRoot, cacheRoot, 0);
  }

  private async claudeCacheManifestSources(cacheRoot: string, dirPath: string, depth: number): Promise<ManifestSource[]> {
    const sources: ManifestSource[] = [];
    const manifestPath = path.join(dirPath, ".claude-plugin", "plugin.json");
    if (await isFile(manifestPath)) {
      sources.push({
        manifestPath,
        pluginPath: dirPath,
        manifestKind: "claude",
        providerKind: "claude-code",
        sourceScope: "bundled",
        sourceLabel: "Claude plugin cache"
      });
    }
    if (depth >= CODEX_CACHE_MAX_DEPTH) {
      return sources;
    }
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name === ".claude-plugin") {
        continue;
      }
      sources.push(...await this.claudeCacheManifestSources(cacheRoot, path.join(dirPath, entry.name), depth + 1));
    }
    return sources;
  }

  private async installedPlugins(diagnostics: PluginListDiagnostics): Promise<Map<string, PluginInstallRecord[]>> {
    const records = new Map<string, PluginInstallRecord[]>();
    await this.addCodexConfigInstallRecords(records, diagnostics);
    await this.addCodexRemoteInstallRecords(records, diagnostics);
    await this.addClaudeInstallRecords(records, diagnostics);
    return records;
  }

  private async addCodexConfigInstallRecords(
    records: Map<string, PluginInstallRecord[]>,
    diagnostics: PluginListDiagnostics
  ): Promise<void> {
    const configPath = path.join(this.homeDir, ".codex", "config.toml");
    diagnostics.checkedSources.push(configPath);
    const content = await readFile(configPath, "utf8").catch(() => undefined);
    if (!content) {
      return;
    }
    for (const section of pluginTomlSections(content)) {
      if (!tomlSectionEnabled(section.body)) {
        continue;
      }
      addInstallRecord(records, {
        providerKind: "codex-cli",
        key: section.key,
        enabled: true,
        sourceLabel: "Codex config"
      });
    }
  }

  private async addCodexRemoteInstallRecords(
    records: Map<string, PluginInstallRecord[]>,
    diagnostics: PluginListDiagnostics
  ): Promise<void> {
    const cacheRoot = path.join(this.homeDir, ".codex", "plugins", "cache");
    const markerPaths = await findFilesNamed(cacheRoot, ".codex-remote-plugin-install.json", CODEX_CACHE_MAX_DEPTH);
    for (const markerPath of markerPaths) {
      diagnostics.checkedSources.push(markerPath);
      const pluginName = path.basename(path.dirname(markerPath));
      const marketplace = cacheMarketplaceName(cacheRoot, path.dirname(markerPath)) ?? "remote";
      addInstallRecord(records, {
        providerKind: "codex-cli",
        key: `${pluginName}@${marketplace}`,
        enabled: true,
        sourceLabel: "Codex remote install"
      });
    }
  }

  private async addClaudeInstallRecords(
    records: Map<string, PluginInstallRecord[]>,
    diagnostics: PluginListDiagnostics
  ): Promise<void> {
    const installedPath = path.join(this.homeDir, ".claude", "plugins", "installed_plugins.json");
    diagnostics.checkedSources.push(installedPath);
    const installed = await readJsonRecord(installedPath).catch(() => undefined);
    const plugins = isRecord(installed?.plugins) ? installed.plugins : {};
    for (const [key, entries] of Object.entries(plugins)) {
      if (!Array.isArray(entries) || entries.length === 0) {
        continue;
      }
      const entry = entries.find(isRecord) ?? {};
      addInstallRecord(records, {
        providerKind: "claude-code",
        key,
        enabled: true,
        sourceLabel: "Claude installed",
        scope: stringValue(entry.scope),
        version: stringValue(entry.version),
        installedAt: stringValue(entry.installedAt),
        installPath: stringValue(entry.installPath)
      });
    }
  }

  private async catalogItemFromManifest(
    source: ManifestSource,
    manifest: Record<string, unknown>,
    skills: UserSkillSummary[],
    installRecordsByName: Map<string, PluginInstallRecord[]>
  ): Promise<PluginCatalogItem> {
    const ui = isRecord(manifest.interface) ? manifest.interface : {};
    const name = stringValue(manifest.name) ??
      stringValue(source.entry?.name) ??
      stringValue(source.entry?.id) ??
      path.basename(source.pluginPath);
    const displayName = stringValue(ui.displayName) ??
      stringValue(source.entry?.displayName) ??
      (source.manifestKind === "claude" ? titleCasePluginName(name) : name);
    const description = stringValue(ui.shortDescription) ??
      stringValue(manifest.description) ??
      stringValue(source.entry?.description);
    const category = stringValue(ui.category) ?? stringValue(source.entry?.category);
    const iconUrl = await pluginIconUrl(source.pluginPath, manifest, source.entry);
    const brandColor = normalizeBrandColor(stringValue(ui.brandColor) ?? stringValue(source.entry?.brandColor));
    const skill = this.matchInstalledSkill(skills, manifest, source.entry, name, displayName);
    const prompt = firstPromptString(ui.defaultPrompt);
    const invocation: PluginInvocationDescriptor = skill
      ? { kind: "skill-mention", skill }
      : prompt
        ? { kind: "prompt-insert", prompt }
        : { kind: "mcp-passive" };
    const installRecords = installRecordsForPlugin(installRecordsByName, name, displayName)
      .filter((record) => record.providerKind === source.providerKind);
    const installedProviderKinds = providerKindsForInstallRecords(installRecords);
    const providerAvailability = this.providerAvailability(invocation, skill, hasMcpServers(manifest))
      .filter((provider) => provider.providerKind === source.providerKind);
    const statusMessage = statusMessageForInvocation(invocation, skill, hasMcpServers(manifest));
    return {
      id: hashText(`plugin-v1\0${source.manifestPath}\0${name}`),
      name,
      displayName,
      description,
      category,
      iconUrl,
      brandColor,
      providerKind: source.providerKind,
      sourceScope: source.sourceScope,
      sourceLabel: source.sourceLabel,
      manifestPath: source.manifestPath,
      pluginPath: source.pluginPath,
      installRecords,
      installedProviderKinds,
      invocation,
      providerAvailability,
      statusMessage
    };
  }

  private addInstalledFallbackItems(
    plugins: PluginCatalogItem[],
    pluginIndexByIdentity: Map<string, number>,
    installRecordsByName: Map<string, PluginInstallRecord[]>
  ): void {
    const matchedRecords = new Set<string>();
    for (const plugin of plugins) {
      for (const record of plugin.installRecords) {
        matchedRecords.add(installRecordIdentity(record));
      }
    }
    for (const [normalizedName, records] of [...installRecordsByName.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      for (const providerKind of PROVIDERS) {
        const unmatchedRecords = records
          .filter((record) => record.enabled && record.providerKind === providerKind && !matchedRecords.has(installRecordIdentity(record)))
          .sort((left, right) => left.key.localeCompare(right.key));
        if (!unmatchedRecords.length) {
          continue;
        }
        const item = installedFallbackCatalogItem(normalizedName, providerKind, unmatchedRecords);
        const identityKey = pluginIdentityKey(item);
        const existingIndex = pluginIndexByIdentity.get(identityKey);
        if (existingIndex === undefined) {
          pluginIndexByIdentity.set(identityKey, plugins.length);
          plugins.push(item);
        } else {
          plugins[existingIndex] = mergePluginCatalogItem(plugins[existingIndex], item);
        }
      }
    }
  }

  private matchInstalledSkill(
    skills: UserSkillSummary[],
    manifest: Record<string, unknown>,
    entry: Record<string, unknown> | undefined,
    name: string,
    displayName: string
  ): UserSkillSummary | undefined {
    const candidateNames = new Set<string>();
    for (const value of [name, displayName, stringValue(manifest.name), stringValue(entry?.name), stringValue(entry?.id)]) {
      addNormalizedName(candidateNames, value);
    }
    for (const skillName of manifestSkillNames(manifest)) {
      addNormalizedName(candidateNames, skillName);
    }
    return skills.find((skill) => candidateNames.has(normalizeName(skill.frontmatterName)));
  }

  private providerAvailability(
    invocation: PluginInvocationDescriptor,
    skill: UserSkillSummary | undefined,
    hasMcp: boolean
  ): PluginProviderAvailability[] {
    if (invocation.kind === "skill-mention" && skill) {
      return PROVIDERS.map((providerKind) => {
        const variant = skill.variants.find((item) => item.providerKind === providerKind);
        if (!variant) {
          return {
            providerKind,
            status: "unsupported",
            capabilityState: "unsupported",
            message: `No installed ${providerLabel(providerKind)} skill variant.`
          };
        }
        return {
          providerKind,
          status: variant.capabilityState === "invocable" ? "invocable" : "available",
          capabilityState: variant.capabilityState,
          message: skill.statusMessage
        };
      });
    }
    if (invocation.kind === "prompt-insert") {
      return [];
    }
    return PROVIDERS.map((providerKind) => ({
      providerKind,
      status: hasMcp ? "needs-setup" : "unsupported",
      capabilityState: "discovery-only" as UserSkillCapabilityState,
      message: hasMcp
        ? "MCP setup is required before this plugin can be used in chat."
        : "No chat invocation is available for this plugin."
    }));
  }
}

function marketplaceEntries(value: Record<string, unknown>): Record<string, unknown>[] {
  const rawEntries = Array.isArray(value.plugins) ? value.plugins : Array.isArray(value.entries) ? value.entries : [];
  return rawEntries.filter(isRecord);
}

function manifestSkillNames(manifest: Record<string, unknown>): string[] {
  if (!Array.isArray(manifest.skills)) {
    return [];
  }
  return manifest.skills.flatMap((skill) => {
    if (typeof skill === "string") {
      return [skill];
    }
    if (!isRecord(skill)) {
      return [];
    }
    return [stringValue(skill.name), stringValue(skill.id), stringValue(skill.path)]
      .filter((value): value is string => Boolean(value));
  });
}

function statusMessageForInvocation(
  invocation: PluginInvocationDescriptor,
  skill: UserSkillSummary | undefined,
  hasMcp: boolean
): string | undefined {
  if (invocation.kind === "skill-mention") {
    return skill?.statusMessage;
  }
  if (invocation.kind === "prompt-insert") {
    return "Prompt plugin; selecting it inserts text into the composer.";
  }
  return hasMcp
    ? "MCP-only plugin. Setup is required before it can be used from chat."
    : "Detected plugin has no local chat invocation.";
}

function pluginMatchesQuery(plugin: PluginCatalogItem, query: string): boolean {
  if (!query) {
    return true;
  }
  return plugin.name.toLowerCase().includes(query) ||
    plugin.displayName.toLowerCase().includes(query) ||
    (plugin.description?.toLowerCase().includes(query) ?? false) ||
    (plugin.category?.toLowerCase().includes(query) ?? false);
}

function pluginIdentityKey(plugin: PluginCatalogItem): string {
  const name = normalizeName(plugin.name) || normalizeName(plugin.displayName);
  return `${plugin.sourceScope}:${plugin.providerKind}:${name || plugin.id}`;
}

function installPriority(plugin: PluginCatalogItem): number {
  if (!plugin.installRecords.length) {
    return 0;
  }
  const pluginPath = plugin.pluginPath ? path.resolve(plugin.pluginPath) : undefined;
  if (pluginPath && plugin.installRecords.some((record) => record.installPath && path.resolve(record.installPath) === pluginPath)) {
    return 2;
  }
  return 1;
}

function mergePluginCatalogItem(primary: PluginCatalogItem, secondary: PluginCatalogItem): PluginCatalogItem {
  return {
    ...primary,
    description: primary.description ?? secondary.description,
    category: primary.category ?? secondary.category,
    iconUrl: primary.iconUrl ?? secondary.iconUrl,
    brandColor: primary.brandColor ?? secondary.brandColor,
    statusMessage: primary.statusMessage ?? secondary.statusMessage
  };
}

function backfillPluginIconMetadata(plugins: PluginCatalogItem[]): void {
  const metadataByName = new Map<string, Pick<PluginCatalogItem, "iconUrl" | "brandColor">>();
  for (const plugin of plugins) {
    const key = normalizeName(plugin.name) || normalizeName(plugin.displayName);
    if (!key || !plugin.iconUrl) {
      continue;
    }
    const current = metadataByName.get(key);
    metadataByName.set(key, {
      iconUrl: current?.iconUrl ?? plugin.iconUrl,
      brandColor: current?.brandColor ?? plugin.brandColor
    });
  }
  for (const plugin of plugins) {
    const key = normalizeName(plugin.name) || normalizeName(plugin.displayName);
    const metadata = key ? metadataByName.get(key) : undefined;
    if (metadata) {
      plugin.iconUrl = plugin.iconUrl ?? metadata.iconUrl;
      plugin.brandColor = plugin.brandColor ?? metadata.brandColor;
    }
  }
}

function installRecordsForPlugin(
  records: Map<string, PluginInstallRecord[]>,
  name: string,
  displayName: string
): PluginInstallRecord[] {
  const merged = new Map<string, PluginInstallRecord>();
  for (const value of [name, displayName]) {
    for (const record of records.get(normalizeName(value)) ?? []) {
      merged.set(`${record.providerKind}:${record.key}`, record);
    }
  }
  return [...merged.values()].sort((left, right) => {
    const providerOrder = left.providerKind.localeCompare(right.providerKind);
    return providerOrder === 0 ? left.key.localeCompare(right.key) : providerOrder;
  });
}

function providerKindsForInstallRecords(records: PluginInstallRecord[]): ChatProviderKind[] {
  return PROVIDERS.filter((providerKind) => records.some((record) => record.providerKind === providerKind && record.enabled));
}

function addInstallRecord(records: Map<string, PluginInstallRecord[]>, record: PluginInstallRecord): void {
  const name = pluginNameFromInstallKey(record.key);
  if (!name) {
    return;
  }
  const normalized = normalizeName(name);
  const current = records.get(normalized) ?? [];
  if (!current.some((item) => item.providerKind === record.providerKind && item.key === record.key)) {
    records.set(normalized, [...current, record]);
  }
}

function installedFallbackCatalogItem(
  normalizedName: string,
  providerKind: ChatProviderKind,
  installRecords: PluginInstallRecord[]
): PluginCatalogItem {
  return {
    id: hashText(`plugin-install-fallback-v1\0${providerKind}\0${normalizedName}`),
    name: normalizedName,
    displayName: titleCasePluginName(normalizedName),
    description: "Installed plugin",
    providerKind,
    sourceScope: sourceScopeForInstallRecords(installRecords),
    sourceLabel: installRecords.map((record) => record.sourceLabel).filter(Boolean).join(", ") || "Installed plugin",
    installRecords,
    installedProviderKinds: [providerKind],
    invocation: { kind: "mcp-passive" },
    providerAvailability: [{
      providerKind,
      status: "invocable",
      capabilityState: "invocable",
      message: "Installed plugin detected; manifest metadata was not found."
    }],
    statusMessage: "Installed plugin detected; manifest metadata was not found."
  };
}

function sourceScopeForInstallRecords(records: PluginInstallRecord[]): PluginSourceScope {
  return records.some((record) => {
    const marketplace = record.key.split("@")[1]?.trim();
    return marketplace === "claude-plugins-official" || marketplace?.startsWith("openai-");
  })
    ? "bundled"
    : "personal";
}

function installRecordIdentity(record: PluginInstallRecord): string {
  return `${record.providerKind}\0${record.key}`;
}

function pluginNameFromInstallKey(key: string): string | undefined {
  return key.split("@")[0]?.trim();
}

function pluginTomlSections(content: string): Array<{ key: string; body: string }> {
  const sections: Array<{ key: string; body: string }> = [];
  const lines = content.split(/\r?\n/);
  let currentKey: string | undefined;
  let currentBody: string[] = [];
  const flush = (): void => {
    if (currentKey) {
      sections.push({ key: currentKey, body: currentBody.join("\n") });
    }
  };
  for (const line of lines) {
    const section = line.match(/^\[plugins\."([^"]+)"\]\s*$/);
    if (section) {
      flush();
      currentKey = section[1];
      currentBody = [];
      continue;
    }
    if (/^\[/.test(line)) {
      flush();
      currentKey = undefined;
      currentBody = [];
      continue;
    }
    if (currentKey) {
      currentBody.push(line);
    }
  }
  flush();
  return sections;
}

function tomlSectionEnabled(body: string): boolean {
  const enabled = body.match(/^\s*enabled\s*=\s*(true|false)\s*$/m)?.[1];
  return enabled !== "false";
}

async function findFilesNamed(rootPath: string, fileName: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  const visit = async (dirPath: string, depth: number): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        results.push(entryPath);
        continue;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        await visit(entryPath, depth + 1);
      }
    }
  };
  await visit(rootPath, 0);
  return results;
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JSON root must be an object.");
  }
  return parsed;
}

async function isFile(filePath: string): Promise<boolean> {
  const info = await lstat(filePath).catch(() => undefined);
  return Boolean(info?.isFile());
}

async function pluginIconUrl(
  pluginPath: string,
  manifest: Record<string, unknown>,
  entry: Record<string, unknown> | undefined
): Promise<string | undefined> {
  const ui = isRecord(manifest.interface) ? manifest.interface : {};
  const entryInterface = isRecord(entry?.interface) ? entry.interface : {};
  const candidates = [
    stringValue(ui.composerIcon),
    stringValue(ui.logo),
    stringValue(manifest.icon),
    stringValue(entryInterface.composerIcon),
    stringValue(entryInterface.logo),
    stringValue(entry?.icon)
  ];
  for (const candidate of candidates) {
    const assetUrl = await safePluginAssetUrl(pluginPath, candidate);
    if (assetUrl) {
      return assetUrl;
    }
  }
  return undefined;
}

async function safePluginAssetUrl(pluginPath: string, assetPath: string | undefined): Promise<string | undefined> {
  if (!assetPath || /^(?:https?:|data:|file:)/i.test(assetPath)) {
    return undefined;
  }
  const pluginRoot = await realpath(pluginPath).catch(() => path.resolve(pluginPath));
  const resolved = path.resolve(pluginRoot, assetPath);
  if (resolved !== pluginRoot && !resolved.startsWith(pluginRoot + path.sep)) {
    return undefined;
  }
  if (!ICON_EXTENSIONS.has(path.extname(resolved).toLowerCase()) || !(await isFile(resolved))) {
    return undefined;
  }
  return pathToFileURL(resolved).toString();
}

function normalizeBrandColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) ? value : undefined;
}

function hasMcpServers(manifest: Record<string, unknown>): boolean {
  const mcpServers = manifest.mcpServers;
  if (Array.isArray(mcpServers)) {
    return mcpServers.length > 0;
  }
  return isRecord(mcpServers) && Object.keys(mcpServers).length > 0;
}

function firstPromptString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return undefined;
}

function addNormalizedName(names: Set<string>, value: string | undefined): void {
  if (!value) {
    return;
  }
  const normalized = normalizeName(value);
  if (normalized) {
    names.add(normalized);
  }
}

function normalizeName(value: string): string {
  return value.trim().replace(/^\//, "").toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerLabel(providerKind: ChatProviderKind): string {
  return providerKind === "codex-cli" ? "Codex" : "Claude";
}

function cacheSourceLabel(cacheRoot: string, pluginPath: string): string {
  const sourceKind = cacheMarketplaceName(cacheRoot, pluginPath);
  if (sourceKind?.startsWith("openai-")) {
    return "OpenAI plugin cache";
  }
  if (sourceKind === "claude-plugins-official") {
    return "Claude plugin cache";
  }
  return "Codex plugin cache";
}

function cacheMarketplaceName(cacheRoot: string, pluginPath: string): string | undefined {
  return path.relative(cacheRoot, pluginPath).split(path.sep)[0];
}

function titleCasePluginName(value: string): string {
  return value
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || value;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value as number)));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
