import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { AgentHealth, AppSkillSyncHealth, ChatProviderKind } from "../../shared/types";

const OWNER_ID = "accordagents";
const MARKER_FILE = ".accordagents-generated.json";
const MANIFEST_FILE = ".accordagents-skills.json";
const TMP_PREFIX = ".accordagents-tmp-";
const LOCK_PREFIX = "accordagents-app-skills-";
const SCHEMA_VERSION = 1;
const RENDERER_VERSION = "app-skills-v1";
const TMP_MAX_AGE_MS = 60 * 60_000;
const CODEX_DESCRIPTION_LIMIT = 1024;
const OPENAI_SHORT_DESCRIPTION_LIMIT = 120;

type AppSkillProvider = ChatProviderKind;

interface AppSkillsDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface AppSkillsServiceOptions {
  sourceRoot: string;
  appVersion: string;
  homeDir?: string;
  debugLogs?: AppSkillsDebugLogger;
  now?: () => Date;
  tmpMaxAgeMs?: number;
}

type AppSkillVisibility = "internal" | "public";

interface CanonicalSkill {
  id: string;
  generatedName: string;
  // The frontmatter name from the source SKILL.md. Preserved verbatim for public skills so
  // their slash name (e.g. /accord) survives; internal skills render as generatedName instead.
  canonicalName: string;
  visibility: AppSkillVisibility;
  normalizedContent: string;
  description: string;
  body: string;
  sourceHash: string;
}

interface RenderedFile {
  path: string;
  content: string;
}

interface RenderedSkill {
  canonical: CanonicalSkill;
  provider: AppSkillProvider;
  files: RenderedFile[];
  renderHash: string;
}

interface GeneratedMarker {
  schemaVersion: number;
  rendererVersion: string;
  owner: string;
  canonicalId: string;
  folderName: string;
  provider: AppSkillProvider;
  visibility: AppSkillVisibility;
  generatedFiles: string[];
  sourceHash: string;
  renderHash: string;
  appVersion: string;
  updatedAt: string;
}

interface ManifestEntry {
  canonicalId: string;
  folderName: string;
  visibility: AppSkillVisibility;
  sourceHash: string;
  renderHash: string;
}

interface AppSkillsManifest {
  schemaVersion: number;
  rendererVersion: string;
  owner: string;
  provider: AppSkillProvider;
  generatedFolders: ManifestEntry[];
  updatedAt: string;
}

interface SyncProviderResult {
  status: AppSkillSyncHealth["status"];
  skillCount: number;
  message?: string;
}

interface FrontmatterParseResult {
  name: string;
  description: string;
  frontmatter: string;
  body: string;
}

interface TargetSyncResult {
  status: "synced" | "skipped" | "collision";
  entry?: ManifestEntry;
  message?: string;
}

export class AppSkillsService {
  private readonly sourceRoot: string;
  private readonly homeDir: string;
  private readonly appVersion: string;
  private readonly debugLogs?: AppSkillsDebugLogger;
  private readonly now: () => Date;
  private readonly tmpMaxAgeMs: number;
  private inFlight?: Promise<Map<AppSkillProvider, AppSkillSyncHealth>>;
  private readonly lastStatuses = new Map<AppSkillProvider, AppSkillSyncHealth>();

  constructor(options: AppSkillsServiceOptions) {
    this.sourceRoot = path.resolve(options.sourceRoot);
    this.homeDir = path.resolve(options.homeDir ?? homedir());
    this.appVersion = options.appVersion;
    this.debugLogs = options.debugLogs;
    this.now = options.now ?? (() => new Date());
    this.tmpMaxAgeMs = options.tmpMaxAgeMs ?? TMP_MAX_AGE_MS;
  }

  async reconcileAgents(agents: AgentHealth[]): Promise<AgentHealth[]> {
    const statuses = await this.reconcile(agents);
    return agents.map((agent) => ({
      ...agent,
      appSkillSync: statuses.get(agent.kind) ?? this.notInstalledStatus()
    }));
  }

  async reconcile(agents: AgentHealth[]): Promise<Map<AppSkillProvider, AppSkillSyncHealth>> {
    if (!this.inFlight) {
      this.inFlight = this.withProcessLock(() => this.reconcileNow(agents))
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    return this.inFlight;
  }

  statusFor(provider: AppSkillProvider): AppSkillSyncHealth | undefined {
    return this.lastStatuses.get(provider);
  }

  statusForAgent(agent: Pick<AgentHealth, "kind" | "installed">): AppSkillSyncHealth | undefined {
    const status = this.statusFor(agent.kind);
    if (!status) {
      return undefined;
    }
    const matchesInstalledState = agent.installed
      ? status.status !== "not-installed"
      : status.status === "not-installed";
    return matchesInstalledState ? status : undefined;
  }

  private async reconcileNow(agents: AgentHealth[]): Promise<Map<AppSkillProvider, AppSkillSyncHealth>> {
    const statuses = new Map<AppSkillProvider, AppSkillSyncHealth>();
    const skills = await this.loadCanonicalSkills().catch((error) => {
      void this.writeDebugLog("app-skills-source-error", {
        sourceRoot: this.sourceRoot,
        error: this.errorText(error)
      });
      return undefined;
    });
    if (!skills) {
      for (const provider of this.providers()) {
        const agent = agents.find((item) => item.kind === provider);
        const status = agent?.installed
          ? this.toHealth({ status: "error", skillCount: 0, message: "App skill source is unavailable." })
          : this.notInstalledStatus();
        statuses.set(provider, status);
        this.lastStatuses.set(provider, status);
      }
      return statuses;
    }
    for (const provider of this.providers()) {
      const agent = agents.find((item) => item.kind === provider);
      const result = agent?.installed
        ? await this.syncProvider(provider, skills).catch((error): SyncProviderResult => {
            void this.writeDebugLog("app-skills-sync-error", {
              provider,
              error: this.errorText(error)
            });
            return { status: "error", skillCount: 0, message: "App skill sync failed." };
          })
        : ({ status: "not-installed", skillCount: 0 } satisfies SyncProviderResult);
      const status = this.toHealth(result);
      statuses.set(provider, status);
      this.lastStatuses.set(provider, status);
    }
    return statuses;
  }

  private async syncProvider(provider: AppSkillProvider, skills: CanonicalSkill[]): Promise<SyncProviderResult> {
    const root = this.providerSkillRoot(provider);
    await mkdir(root, { recursive: true });
    await this.sweepStaleTempDirs(root);

    const manifestResult = await this.readManifest(root, provider);
    if (manifestResult.status === "collision") {
      await this.writeDebugLog("app-skills-sync-collision", {
        provider,
        path: path.join(root, MANIFEST_FILE),
        reason: manifestResult.message
      });
      return { status: "collision", skillCount: 0, message: "App skill manifest is malformed." };
    }

    const previousManifest = manifestResult.manifest;
    const currentEntries: ManifestEntry[] = [];
    const expectedFolders = new Set<string>();
    let collisionCount = 0;
    let syncedCount = 0;
    let skippedCount = 0;

    for (const skill of skills) {
      const rendered = this.renderSkill(skill, provider);
      expectedFolders.add(skill.generatedName);
      const target = path.join(root, skill.generatedName);
      const result = await this.syncTarget(root, target, rendered);
      if (result.status === "collision") {
        collisionCount += 1;
        await this.writeDebugLog("app-skills-sync-collision", {
          provider,
          canonicalId: skill.id,
          path: target,
          reason: result.message
        });
      } else if (result.status === "skipped") {
        skippedCount += 1;
      } else {
        syncedCount += 1;
      }
      if (result.entry) {
        currentEntries.push(result.entry);
      }
    }

    const staleEntries = previousManifest?.generatedFolders.filter((entry) => !expectedFolders.has(entry.folderName)) ?? [];
    const retainedStaleEntries: ManifestEntry[] = [];
    for (const entry of staleEntries) {
      const cleanup = await this.cleanupStaleTarget(root, provider, entry);
      if (!cleanup) {
        collisionCount += 1;
        retainedStaleEntries.push(entry);
      }
    }

    const nextManifestEntries = [...currentEntries, ...retainedStaleEntries];
    if (!previousManifest || !manifestEntriesEqual(previousManifest.generatedFolders, nextManifestEntries)) {
      await this.writeManifest(root, provider, nextManifestEntries);
    }
    if (collisionCount > 0) {
      return { status: "collision", skillCount: currentEntries.length, message: `${collisionCount} app skill target${collisionCount === 1 ? "" : "s"} skipped.` };
    }
    return {
      status: skippedCount === skills.length && syncedCount === 0 ? "skipped" : "synced",
      skillCount: currentEntries.length
    };
  }

  private async syncTarget(root: string, target: string, rendered: RenderedSkill): Promise<TargetSyncResult> {
    const targetStatus = await this.pathStatus(target);
    if (targetStatus === "missing") {
      return this.createTarget(root, target, rendered);
    }
    if (targetStatus !== "directory") {
      return { status: "collision", message: "Target exists but is not a normal directory." };
    }

    const markerResult = await this.readMarker(path.join(target, MARKER_FILE), rendered.provider, rendered.canonical.generatedName);
    if (markerResult.status !== "valid") {
      return { status: "collision", message: markerResult.message };
    }

    const expectedFiles = rendered.files.map((file) => file.path);
    const unchanged =
      markerResult.marker.sourceHash === rendered.canonical.sourceHash &&
      markerResult.marker.renderHash === rendered.renderHash &&
      stringArraysEqual(markerResult.marker.generatedFiles, expectedFiles) &&
      await this.renderedFilesMatch(target, rendered.files);
    const entry = this.manifestEntry(rendered);
    if (unchanged) {
      return { status: "skipped", entry };
    }

    const generatedFiles = new Set([...markerResult.marker.generatedFiles, ...expectedFiles]);
    for (const relativePath of generatedFiles) {
      const filePath = this.safeChildPath(target, relativePath);
      if (!filePath) {
        return { status: "collision", message: `Unsafe generated path in marker: ${relativePath}` };
      }
      const status = await this.pathStatus(filePath);
      if (status === "symlink" || status === "other") {
        return { status: "collision", message: `Generated path is not a normal file: ${relativePath}` };
      }
    }

    for (const file of rendered.files) {
      const filePath = this.safeChildPath(target, file.path);
      if (!filePath) {
        return { status: "collision", message: `Unsafe render path: ${file.path}` };
      }
      await this.atomicWriteFile(filePath, file.content);
    }
    await this.cleanupStaleFiles(target, markerResult.marker.generatedFiles, expectedFiles);
    await this.atomicWriteFile(path.join(target, MARKER_FILE), this.markerJson(rendered));
    await this.syncDirectory(target);
    return { status: "synced", entry };
  }

  private async createTarget(root: string, target: string, rendered: RenderedSkill): Promise<TargetSyncResult> {
    const tmp = path.join(root, `${TMP_PREFIX}${process.pid}-${randomUUID()}`);
    await mkdir(tmp, { recursive: true });
    try {
      for (const file of rendered.files) {
        const filePath = this.safeChildPath(tmp, file.path);
        if (!filePath) {
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return { status: "collision", message: `Unsafe render path: ${file.path}` };
        }
        await mkdir(path.dirname(filePath), { recursive: true });
        await this.writeSyncedFile(filePath, file.content);
      }
      await this.writeSyncedFile(path.join(tmp, MARKER_FILE), this.markerJson(rendered));
      await this.syncDirectory(tmp);
      await this.syncNestedDirectories(tmp, rendered.files.map((file) => file.path));
      await rename(tmp, target);
      await this.syncDirectory(root);
      return { status: "synced", entry: this.manifestEntry(rendered) };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        return { status: "collision", message: "Target appeared during app skill creation." };
      }
      throw error;
    }
  }

  private async cleanupStaleTarget(root: string, provider: AppSkillProvider, entry: ManifestEntry): Promise<boolean> {
    const target = this.safeChildPath(root, entry.folderName);
    if (!target) {
      return false;
    }
    const targetStatus = await this.pathStatus(target);
    if (targetStatus === "missing") {
      return true;
    }
    if (targetStatus !== "directory") {
      await this.writeDebugLog("app-skills-sync-collision", { provider, path: target, reason: "Stale target is not a normal directory." });
      return false;
    }
    const markerResult = await this.readMarker(path.join(target, MARKER_FILE), provider, entry.folderName);
    if (markerResult.status !== "valid") {
      await this.writeDebugLog("app-skills-sync-collision", { provider, path: target, reason: markerResult.message });
      return false;
    }
    for (const relativePath of markerResult.marker.generatedFiles) {
      const filePath = this.safeChildPath(target, relativePath);
      if (!filePath) {
        await this.writeDebugLog("app-skills-sync-collision", { provider, path: target, reason: `Unsafe stale path: ${relativePath}` });
        return false;
      }
      const status = await this.pathStatus(filePath);
      if (status === "symlink" || status === "other") {
        await this.writeDebugLog("app-skills-sync-collision", { provider, path: filePath, reason: "Stale generated path is not a normal file." });
        return false;
      }
    }
    await this.cleanupStaleFiles(target, markerResult.marker.generatedFiles, []);
    await unlink(path.join(target, MARKER_FILE)).catch(() => undefined);
    await this.removeEmptyAncestors(target, markerResult.marker.generatedFiles);
    await rmdir(target).catch(() => undefined);
    return true;
  }

  private async cleanupStaleFiles(baseDir: string, previousFiles: string[], expectedFiles: string[]): Promise<void> {
    const expected = new Set(expectedFiles);
    for (const relativePath of previousFiles) {
      if (expected.has(relativePath)) {
        continue;
      }
      const filePath = this.safeChildPath(baseDir, relativePath);
      if (!filePath) {
        continue;
      }
      await unlink(filePath).catch(() => undefined);
    }
    await this.removeEmptyAncestors(baseDir, previousFiles);
  }

  private async removeEmptyAncestors(baseDir: string, files: string[]): Promise<void> {
    const dirs = Array.from(new Set(files.map((file) => path.dirname(file)).filter((dir) => dir !== ".")))
      .sort((left, right) => right.length - left.length);
    for (const relativeDir of dirs) {
      const dir = this.safeChildPath(baseDir, relativeDir);
      if (dir) {
        await rmdir(dir).catch(() => undefined);
      }
    }
  }

  private async loadCanonicalSkills(): Promise<CanonicalSkill[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.sourceRoot, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to read app skills from ${this.sourceRoot}: ${this.errorText(error)}`);
    }
    const skills: CanonicalSkill[] = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (!this.isValidSkillId(entry.name)) {
        throw new Error(`Invalid app skill id: ${entry.name}`);
      }
      const skillPath = path.join(this.sourceRoot, entry.name, "SKILL.md");
      if (!await this.fileExists(skillPath)) {
        continue;
      }
      const raw = await readFile(skillPath, "utf8");
      const normalizedContent = ensureTrailingNewline(stripOuterMarkdownFence(raw));
      const parsed = parseSkillFrontmatter(normalizedContent);
      const sourceHash = hashText(normalizedContent);
      const visibility: AppSkillVisibility =
        scalarFrontmatterValue(parsed.frontmatter, "visibility") === "public" ? "public" : "internal";
      skills.push({
        id: entry.name,
        generatedName: this.generatedSkillName(entry.name),
        canonicalName: parsed.name,
        visibility,
        normalizedContent,
        description: parsed.description,
        body: parsed.body,
        sourceHash
      });
    }
    return skills;
  }

  private renderSkill(skill: CanonicalSkill, provider: AppSkillProvider): RenderedSkill {
    // claude-code and gemini-cli share the plain SKILL.md layout; codex adds agents/openai.yaml.
    const files = provider === "codex-cli"
      ? this.renderCodexSkill(skill)
      : this.renderClaudeSkill(skill);
    return {
      canonical: skill,
      provider,
      files,
      renderHash: hashRenderedFiles(files)
    };
  }

  private renderedSkillName(skill: CanonicalSkill): string {
    // Public skills keep their slash name (e.g. accord); internal bridge skills are renamed to
    // the collision-safe generated name (e.g. accordagents-app-chat-request).
    return skill.visibility === "public" ? skill.canonicalName : skill.generatedName;
  }

  private renderClaudeSkill(skill: CanonicalSkill): RenderedFile[] {
    const parsed = parseSkillFrontmatter(skill.normalizedContent);
    const frontmatter = parsed.frontmatter
      .replace(/^name:\s*.*$/m, `name: ${this.renderedSkillName(skill)}`)
      .replace(/^visibility:\s*.*\n?/m, "");
    return [{
      path: "SKILL.md",
      content: ensureTrailingNewline(`---\n${frontmatter}\n---${parsed.body}`)
    }];
  }

  private renderCodexSkill(skill: CanonicalSkill): RenderedFile[] {
    if (skill.description.length > CODEX_DESCRIPTION_LIMIT) {
      throw new Error(`Codex description for "${skill.id}" is ${skill.description.length} chars (max ${CODEX_DESCRIPTION_LIMIT}).`);
    }
    const skillContent = [
      "---",
      `name: ${this.renderedSkillName(skill)}`,
      "description: >",
      ...formatFoldedDescription(skill.description),
      "---",
      skill.body.replace(/^\n/, "")
    ].join("\n");
    return [
      {
        path: "SKILL.md",
        content: ensureTrailingNewline(skillContent)
      },
      {
        path: "agents/openai.yaml",
        content: generateOpenAiYaml(this.renderedSkillName(skill), condenseOpenAiShortDescription(skill.description))
      }
    ];
  }

  private async readManifest(root: string, provider: AppSkillProvider): Promise<{ status: "missing"; manifest?: undefined } | { status: "valid"; manifest: AppSkillsManifest } | { status: "collision"; message: string }> {
    const manifestPath = path.join(root, MANIFEST_FILE);
    if (!await this.fileExists(manifestPath)) {
      return { status: "missing" };
    }
    const status = await this.pathStatus(manifestPath);
    if (status !== "file") {
      return { status: "collision", message: "Manifest is not a normal file." };
    }
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      if (isManifest(parsed, provider)) {
        return { status: "valid", manifest: parsed };
      }
      return { status: "collision", message: "Manifest ownership metadata is invalid." };
    } catch {
      return { status: "collision", message: "Manifest JSON is malformed." };
    }
  }

  private async writeManifest(root: string, provider: AppSkillProvider, entries: ManifestEntry[]): Promise<void> {
    const manifest: AppSkillsManifest = {
      schemaVersion: SCHEMA_VERSION,
      rendererVersion: RENDERER_VERSION,
      owner: OWNER_ID,
      provider,
      generatedFolders: entries.sort((left, right) => left.folderName.localeCompare(right.folderName)),
      updatedAt: this.now().toISOString()
    };
    await this.atomicWriteFile(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async readMarker(markerPath: string, provider: AppSkillProvider, folderName: string): Promise<{ status: "valid"; marker: GeneratedMarker } | { status: "collision"; message: string }> {
    const status = await this.pathStatus(markerPath);
    if (status === "missing") {
      return { status: "collision", message: "Target is missing AccordAgents ownership marker." };
    }
    if (status !== "file") {
      return { status: "collision", message: "Ownership marker is not a normal file." };
    }
    try {
      const parsed = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      if (isMarker(parsed, provider, folderName)) {
        return { status: "valid", marker: parsed };
      }
      return { status: "collision", message: "Ownership marker metadata is invalid." };
    } catch {
      return { status: "collision", message: "Ownership marker JSON is malformed." };
    }
  }

  private markerJson(rendered: RenderedSkill): string {
    const marker: GeneratedMarker = {
      schemaVersion: SCHEMA_VERSION,
      rendererVersion: RENDERER_VERSION,
      owner: OWNER_ID,
      canonicalId: rendered.canonical.id,
      folderName: rendered.canonical.generatedName,
      provider: rendered.provider,
      visibility: rendered.canonical.visibility,
      generatedFiles: rendered.files.map((file) => file.path),
      sourceHash: rendered.canonical.sourceHash,
      renderHash: rendered.renderHash,
      appVersion: this.appVersion,
      updatedAt: this.now().toISOString()
    };
    return `${JSON.stringify(marker, null, 2)}\n`;
  }

  private manifestEntry(rendered: RenderedSkill): ManifestEntry {
    return {
      canonicalId: rendered.canonical.id,
      folderName: rendered.canonical.generatedName,
      visibility: rendered.canonical.visibility,
      sourceHash: rendered.canonical.sourceHash,
      renderHash: rendered.renderHash
    };
  }

  private async renderedFilesMatch(target: string, files: RenderedFile[]): Promise<boolean> {
    for (const file of files) {
      const filePath = this.safeChildPath(target, file.path);
      if (!filePath || await this.pathStatus(filePath) !== "file") {
        return false;
      }
      const existing = await readFile(filePath, "utf8").catch(() => undefined);
      if (existing !== file.content) {
        return false;
      }
    }
    return true;
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = path.join(path.dirname(filePath), `${TMP_PREFIX}${process.pid}-${randomUUID()}-${path.basename(filePath)}`);
    try {
      await this.writeSyncedFile(tmp, content);
      await rename(tmp, filePath);
      await this.syncDirectory(path.dirname(filePath));
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async writeSyncedFile(filePath: string, content: string): Promise<void> {
    const handle = await open(filePath, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncNestedDirectories(root: string, files: string[]): Promise<void> {
    const dirs = Array.from(new Set(files.map((file) => path.dirname(file)).filter((dir) => dir !== ".")))
      .sort((left, right) => left.length - right.length);
    for (const relativeDir of dirs) {
      const dir = this.safeChildPath(root, relativeDir);
      if (dir) {
        await this.syncDirectory(dir);
      }
    }
  }

  private async syncDirectory(dir: string): Promise<void> {
    const handle = await open(dir, "r").catch(() => undefined);
    if (!handle) {
      return;
    }
    try {
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async sweepStaleTempDirs(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => []);
    const cutoff = this.now().getTime() - this.tmpMaxAgeMs;
    for (const entry of entries) {
      if (!entry.name.startsWith(TMP_PREFIX)) {
        continue;
      }
      const entryPath = path.join(root, entry.name);
      const info = await lstat(entryPath).catch(() => undefined);
      if (!info || info.mtimeMs > cutoff) {
        continue;
      }
      if (info.isDirectory()) {
        await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      } else if (info.isSymbolicLink() || info.isFile()) {
        await rm(entryPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async withProcessLock<T>(run: () => Promise<T>): Promise<T> {
    const lockDir = path.join(tmpdir(), `${LOCK_PREFIX}${hashText(this.homeDir).slice(0, 16)}.lock`);
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const info = await stat(lockDir).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > this.tmpMaxAgeMs) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() - startedAt > 5_000) {
          throw new Error("Timed out waiting for app skill sync lock.");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await run();
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private providerSkillRoot(provider: AppSkillProvider): string {
    if (provider === "codex-cli") {
      return path.join(this.homeDir, ".codex", "skills");
    }
    if (provider === "gemini-cli") {
      // Antigravity's personal skill root (`agy` discovers SKILL.md dirs here).
      return path.join(this.homeDir, ".gemini", "config", "skills");
    }
    return path.join(this.homeDir, ".claude", "skills");
  }

  private generatedSkillName(id: string): string {
    return `accordagents-${id}`;
  }

  private providers(): AppSkillProvider[] {
    return ["codex-cli", "claude-code", "gemini-cli"];
  }

  private isValidSkillId(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]*$/.test(value);
  }

  private safeChildPath(baseDir: string, relativePath: string): string | undefined {
    if (!relativePath || path.isAbsolute(relativePath)) {
      return undefined;
    }
    const parts = relativePath.split(/[\\/]+/);
    if (parts.some((part) => !part || part === "." || part === "..")) {
      return undefined;
    }
    const resolvedBase = path.resolve(baseDir);
    const resolvedChild = path.resolve(resolvedBase, ...parts);
    const relative = path.relative(resolvedBase, resolvedChild);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return resolvedChild;
  }

  private async pathStatus(filePath: string): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
    const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!info) {
      return "missing";
    }
    if (info.isSymbolicLink()) {
      return "symlink";
    }
    if (info.isFile()) {
      return "file";
    }
    if (info.isDirectory()) {
      return "directory";
    }
    return "other";
  }

  private async fileExists(filePath: string): Promise<boolean> {
    return access(filePath, fsConstants.F_OK).then(() => true, () => false);
  }

  private toHealth(result: SyncProviderResult): AppSkillSyncHealth {
    return {
      status: result.status,
      skillCount: result.skillCount,
      updatedAt: this.now().toISOString(),
      message: result.message
    };
  }

  private notInstalledStatus(): AppSkillSyncHealth {
    return {
      status: "not-installed",
      skillCount: 0,
      updatedAt: this.now().toISOString()
    };
  }

  private async writeDebugLog(event: string, payload: Record<string, unknown>): Promise<void> {
    await this.debugLogs?.write(event, payload);
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function stripOuterMarkdownFence(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^(`{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*\n?$/);
  return match ? match[2] : normalized;
}

export function parseSkillFrontmatter(content: string): FrontmatterParseResult {
  if (!content.startsWith("---\n")) {
    throw new Error("App skill must start with YAML frontmatter.");
  }
  const end = content.indexOf("\n---", 4);
  if (end < 0) {
    throw new Error("App skill frontmatter is not closed.");
  }
  const frontmatter = content.slice(4, end);
  const body = content.slice(end + 4);
  const name = scalarFrontmatterValue(frontmatter, "name");
  const description = descriptionFrontmatterValue(frontmatter);
  if (!name) {
    throw new Error("App skill frontmatter is missing name.");
  }
  if (!description) {
    throw new Error("App skill frontmatter is missing description.");
  }
  return { name, description, frontmatter, body };
}

function scalarFrontmatterValue(frontmatter: string, field: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim();
}

function descriptionFrontmatterValue(frontmatter: string): string | undefined {
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(/^description:\s*(.+?)\s*$/);
    if (inline && inline[1] !== ">" && inline[1] !== "|") {
      return inline[1].trim();
    }
    if (/^description:\s*[>|]\s*$/.test(line)) {
      const block: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const blockLine = lines[next];
        if (blockLine.trim() && !/^\s/.test(blockLine)) {
          break;
        }
        block.push(blockLine.replace(/^  /, ""));
      }
      return block.join(" ").replace(/\s+/g, " ").trim();
    }
  }
  return undefined;
}

function formatFoldedDescription(description: string): string[] {
  const words = description.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 88 && line) {
      lines.push(`  ${line}`);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(`  ${line}`);
  }
  return lines.length > 0 ? lines : ["  "];
}

function condenseOpenAiShortDescription(description: string): string {
  const collapsed = description.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (collapsed.length <= OPENAI_SHORT_DESCRIPTION_LIMIT) {
    return collapsed;
  }
  const truncated = collapsed.slice(0, OPENAI_SHORT_DESCRIPTION_LIMIT - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  const safe = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${safe}...`;
}

function generateOpenAiYaml(displayName: string, shortDescription: string): string {
  return [
    "interface:",
    `  display_name: ${JSON.stringify(displayName)}`,
    `  short_description: ${JSON.stringify(shortDescription)}`,
    `  default_prompt: ${JSON.stringify(`Use ${displayName} for this task.`)}`,
    "policy:",
    "  allow_implicit_invocation: true",
    ""
  ].join("\n");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function hashRenderedFiles(files: RenderedFile[]): string {
  return hashText(JSON.stringify({
    rendererVersion: RENDERER_VERSION,
    files: files
      .map((file) => ({ path: file.path, content: file.content }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestEntriesEqual(left: ManifestEntry[], right: ManifestEntry[]): boolean {
  const normalize = (entries: ManifestEntry[]) => entries
    .map((entry) => `${entry.folderName}\0${entry.canonicalId}\0${entry.sourceHash}\0${entry.renderHash}`)
    .sort();
  return stringArraysEqual(normalize(left), normalize(right));
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function isManifest(value: unknown, provider: AppSkillProvider): value is AppSkillsManifest {
  if (!isRecord(value)) {
    return false;
  }
  return value.schemaVersion === SCHEMA_VERSION &&
    typeof value.rendererVersion === "string" &&
    value.owner === OWNER_ID &&
    value.provider === provider &&
    Array.isArray(value.generatedFolders) &&
    value.generatedFolders.every(isManifestEntry);
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  return isRecord(value) &&
    typeof value.canonicalId === "string" &&
    typeof value.folderName === "string" &&
    isOptionalVisibility(value.visibility) &&
    typeof value.sourceHash === "string" &&
    typeof value.renderHash === "string";
}

// Visibility was added after v1. Treat a missing field as internal so a manifest/marker
// written by an older app version still validates (and stays hidden) instead of forcing a
// collision/rewrite.
function isOptionalVisibility(value: unknown): boolean {
  return value === undefined || value === "internal" || value === "public";
}

function isMarker(value: unknown, provider: AppSkillProvider, folderName: string): value is GeneratedMarker {
  if (!isRecord(value)) {
    return false;
  }
  return value.schemaVersion === SCHEMA_VERSION &&
    typeof value.rendererVersion === "string" &&
    value.owner === OWNER_ID &&
    value.provider === provider &&
    value.folderName === folderName &&
    isOptionalVisibility(value.visibility) &&
    typeof value.canonicalId === "string" &&
    Array.isArray(value.generatedFiles) &&
    value.generatedFiles.every((item) => typeof item === "string") &&
    typeof value.sourceHash === "string" &&
    typeof value.renderHash === "string" &&
    typeof value.appVersion === "string" &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
