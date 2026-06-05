import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ChatProviderKind,
  ChatSkillMention,
  ChatSkillMentionVariant,
  UserSkillCapabilityState,
  UserSkillDiagnosticRoot,
  UserSkillDiagnostics,
  UserSkillScope,
  UserSkillSearchRequest,
  UserSkillSearchResult,
  UserSkillSummary,
  UserSkillTargetSummary
} from "../../shared/types";
import { parseSkillFrontmatter, stripOuterMarkdownFence } from "./appSkills";

const INTERNAL_MANIFEST_FILE = ".accordagents-skills.json";
const INTERNAL_MARKER_FILE = ".accordagents-generated.json";
const INTERNAL_TMP_PREFIX = ".accordagents-tmp-";
const USER_SKILL_HASH_VERSION = "user-skills-v1";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export interface UserSkillRunContext {
  repoPath?: string;
  target: UserSkillTargetSummary;
  participantProviderKindById?: Record<string, ChatProviderKind>;
  runRootByParticipant?: Record<string, string | undefined>;
  runRootByProvider?: Partial<Record<ChatProviderKind, string | undefined>>;
}

interface UserSkillsServiceOptions {
  homeDir?: string;
  internalSourceRoot?: string;
}

interface SkillRoot {
  providerKind: ChatProviderKind;
  scope: UserSkillScope;
  rootKind: UserSkillScope;
  rootPath: string;
  label: string;
  repoRealPath?: string;
}

interface ScanRoot extends SkillRoot {
  exists: boolean;
  rootRealPath?: string;
  visibleCount: number;
  hiddenInternalCount: number;
  malformedCount: number;
  unsafeSymlinkCount: number;
  lastError?: string;
}

interface DiscoveredSkillVariant extends ChatSkillMentionVariant {
  id: string;
  folderName: string;
  displayName: string;
  description: string;
  realPath: string;
  rootLabel: string;
  repoRealPath?: string;
}

interface ScanResult {
  variants: DiscoveredSkillVariant[];
  roots: ScanRoot[];
  lastScanError?: string;
}

export class UserSkillsService {
  private readonly homeDir: string;
  private readonly internalSourceRoot?: string;

  constructor(options: UserSkillsServiceOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? homedir());
    this.internalSourceRoot = options.internalSourceRoot ? path.resolve(options.internalSourceRoot) : undefined;
  }

  async search(request: UserSkillSearchRequest, context: UserSkillRunContext): Promise<UserSkillSearchResult> {
    const scan = await this.scan(context.repoPath);
    const query = request.query.trim().toLowerCase();
    const limit = normalizeLimit(request.limit);
    const targetProviders = uniqueProviderKinds(context.target.providerKinds);
    const matched = scan.variants.filter((variant) => {
      if (query && !variant.frontmatterName.toLowerCase().includes(query) && !variant.description.toLowerCase().includes(query)) {
        return false;
      }
      return targetProviders.length === 0 || targetProviders.includes(variant.providerKind);
    });
    return {
      target: context.target,
      skills: this.rankByQuery(this.summariesForVariants(matched, context), query).slice(0, limit)
    };
  }

  // Order results by how well they match the typed query so the first/highlighted entry is the
  // best match: exact name > name prefix > name substring > description-only match, then
  // alphabetical within a tier. Without this, an alphabetical sort can highlight a description-only
  // match (e.g. `/browse`) above the exact `/qa` the user typed.
  private rankByQuery(summaries: UserSkillSummary[], query: string): UserSkillSummary[] {
    if (!query) {
      return summaries;
    }
    const score = (summary: UserSkillSummary): number => {
      const name = summary.frontmatterName.toLowerCase();
      if (name === query) {
        return 0;
      }
      if (name.startsWith(query)) {
        return 1;
      }
      if (name.includes(query)) {
        return 2;
      }
      return 3;
    };
    return [...summaries].sort((left, right) =>
      score(left) - score(right) || left.frontmatterName.localeCompare(right.frontmatterName)
    );
  }

  async diagnostics(repoPath?: string, context?: UserSkillRunContext): Promise<UserSkillDiagnostics> {
    const scan = await this.scan(repoPath);
    return {
      roots: scan.roots.map((root): UserSkillDiagnosticRoot => ({
        label: root.label,
        providerKind: root.providerKind,
        scope: root.scope,
        exists: root.exists,
        visibleCount: root.visibleCount,
        hiddenInternalCount: root.hiddenInternalCount,
        malformedCount: root.malformedCount,
        unsafeSymlinkCount: root.unsafeSymlinkCount,
        lastError: root.lastError
      })),
      visibleCount: scan.roots.reduce((total, root) => total + root.visibleCount, 0),
      hiddenInternalCount: scan.roots.reduce((total, root) => total + root.hiddenInternalCount, 0),
      malformedCount: scan.roots.reduce((total, root) => total + root.malformedCount, 0),
      unsafeSymlinkCount: scan.roots.reduce((total, root) => total + root.unsafeSymlinkCount, 0),
      providerCapabilities: this.capabilityDiagnostics(context ?? this.defaultDiagnosticsContext(repoPath)),
      lastScanError: scan.lastScanError
    };
  }

  async validateMentionForParticipant(
    mention: ChatSkillMention,
    providerKind: ChatProviderKind,
    context: UserSkillRunContext,
    participantId?: string
  ): Promise<{ ok: true; mention: ChatSkillMention } | { ok: false; message: string }> {
    const sanitized = sanitizeChatSkillMention(mention);
    if (!sanitized) {
      return { ok: false, message: "Selected skill metadata is invalid." };
    }
    const selectedVariant = sanitized.variants.find((variant) => variant.providerKind === providerKind);
    if (!selectedVariant) {
      return { ok: false, message: `${sanitized.displayName} is not available for ${providerLabel(providerKind)}.` };
    }
    const scan = await this.scan(context.repoPath);
    const current = scan.variants.find((variant) =>
      variant.providerKind === selectedVariant.providerKind &&
      variant.scope === selectedVariant.scope &&
      variant.sourceKey === selectedVariant.sourceKey &&
      variant.frontmatterName === selectedVariant.frontmatterName
    );
    if (!current) {
      return { ok: false, message: `${sanitized.displayName} is no longer available for ${providerLabel(providerKind)}.` };
    }
    const currentCapability = this.capabilityForVariant(current, context, participantId);
    if (currentCapability !== "invocable") {
      return { ok: false, message: `${sanitized.displayName} is ${currentCapability} for ${providerLabel(providerKind)} in this chat run.` };
    }
    if (current.contentHash !== selectedVariant.contentHash) {
      return { ok: false, message: `${sanitized.displayName} changed since it was selected. Reopen the slash picker and select it again.` };
    }
    return { ok: true, mention: sanitized };
  }

  // Resolve the validated selected skills for a participant run to their provider-recognized name
  // and real directory. Returns only variants that exist, are invocable for the run, and whose
  // content hash is unchanged. Real paths stay server-side (never sent to the renderer); the run
  // layer uses them to enable the provider's skill-loading path.
  async resolveInvocableSkillsForParticipant(
    mentions: ChatSkillMention[],
    providerKind: ChatProviderKind,
    context: UserSkillRunContext,
    participantId?: string
  ): Promise<Array<{ name: string; dir: string }>> {
    if (mentions.length === 0) {
      return [];
    }
    const scan = await this.scan(context.repoPath);
    const resolved: Array<{ name: string; dir: string }> = [];
    const seen = new Set<string>();
    for (const mention of mentions) {
      const sanitized = sanitizeChatSkillMention(mention);
      const selectedVariant = sanitized?.variants.find((variant) => variant.providerKind === providerKind);
      if (!selectedVariant) {
        continue;
      }
      const current = scan.variants.find((variant) =>
        variant.providerKind === selectedVariant.providerKind &&
        variant.scope === selectedVariant.scope &&
        variant.sourceKey === selectedVariant.sourceKey &&
        variant.frontmatterName === selectedVariant.frontmatterName
      );
      if (
        !current ||
        this.capabilityForVariant(current, context, participantId) !== "invocable" ||
        current.contentHash !== selectedVariant.contentHash ||
        seen.has(current.realPath)
      ) {
        continue;
      }
      seen.add(current.realPath);
      resolved.push({ name: current.frontmatterName, dir: current.realPath });
    }
    return resolved;
  }

  private async scan(repoPath?: string): Promise<ScanResult> {
    const roots = await this.skillRoots(repoPath);
    const scanRoots: ScanRoot[] = [];
    const variants: DiscoveredSkillVariant[] = [];
    let lastScanError: string | undefined;
    for (const root of roots) {
      const scanRoot: ScanRoot = {
        ...root,
        exists: false,
        visibleCount: 0,
        hiddenInternalCount: 0,
        malformedCount: 0,
        unsafeSymlinkCount: 0
      };
      scanRoots.push(scanRoot);
      try {
        const rootInfo = await lstat(root.rootPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        });
        if (!rootInfo) {
          continue;
        }
        scanRoot.exists = true;
        scanRoot.rootRealPath = await realpath(root.rootPath);
        if (!rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
          scanRoot.lastError = "Skill root is not a directory.";
          continue;
        }
        if (root.scope === "repo" && root.repoRealPath && !isPathInside(root.repoRealPath, scanRoot.rootRealPath)) {
          scanRoot.lastError = "Repo-local skill root escapes the repository.";
          continue;
        }
        const generatedFolders = await this.internalGeneratedFolders(root.rootPath);
        const entries = await readdir(root.rootPath, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          const variant = await this.scanEntry(root, scanRoot, entry, generatedFolders);
          if (variant) {
            variants.push(variant);
            scanRoot.visibleCount += 1;
          }
        }
      } catch (error) {
        scanRoot.lastError = errorText(error);
        lastScanError = scanRoot.lastError;
      }
    }
    return { roots: scanRoots, variants, lastScanError };
  }

  private async scanEntry(
    root: SkillRoot,
    scanRoot: ScanRoot,
    entry: Dirent,
    generatedFolders: Set<string>
  ): Promise<DiscoveredSkillVariant | undefined> {
    if (entry.name.startsWith(".") || entry.name.startsWith(INTERNAL_TMP_PREFIX) || generatedFolders.has(entry.name)) {
      if (generatedFolders.has(entry.name) || entry.name.startsWith(INTERNAL_TMP_PREFIX)) {
        scanRoot.hiddenInternalCount += 1;
      }
      return undefined;
    }
    const entryPath = path.join(root.rootPath, entry.name);
    const entryInfo = await lstat(entryPath).catch(() => undefined);
    if (!entryInfo) {
      return undefined;
    }
    if (!entryInfo.isDirectory() && !entryInfo.isSymbolicLink()) {
      return undefined;
    }
    const entryRealPath = await realpath(entryPath).catch(() => undefined);
    if (!entryRealPath) {
      scanRoot.unsafeSymlinkCount += entryInfo.isSymbolicLink() ? 1 : 0;
      return undefined;
    }
    if (!(await stat(entryRealPath).catch(() => undefined))?.isDirectory()) {
      scanRoot.unsafeSymlinkCount += entryInfo.isSymbolicLink() ? 1 : 0;
      return undefined;
    }
    if (this.internalSourceRoot && isPathInside(this.internalSourceRoot, entryRealPath)) {
      scanRoot.hiddenInternalCount += 1;
      return undefined;
    }
    if (await this.hasInternalMarker(entryRealPath)) {
      scanRoot.hiddenInternalCount += 1;
      return undefined;
    }
    const skillPath = path.join(entryRealPath, "SKILL.md");
    const skillInfo = await lstat(skillPath).catch(() => undefined);
    if (!skillInfo) {
      return undefined;
    }
    const skillRealPath = await realpath(skillPath).catch(() => undefined);
    if (!skillRealPath) {
      scanRoot.unsafeSymlinkCount += skillInfo.isSymbolicLink() ? 1 : 0;
      return undefined;
    }
    if (!(await stat(skillRealPath).catch(() => undefined))?.isFile()) {
      scanRoot.unsafeSymlinkCount += skillInfo.isSymbolicLink() ? 1 : 0;
      return undefined;
    }
    try {
      const normalizedContent = ensureTrailingNewline(stripOuterMarkdownFence(await readFile(skillRealPath, "utf8")));
      const parsed = parseSkillFrontmatter(normalizedContent);
      const contentHash = hashText(normalizedContent);
      const sourceKey = hashText(`${USER_SKILL_HASH_VERSION}\0${skillRealPath}`);
      return {
        id: hashText(`${USER_SKILL_HASH_VERSION}\0${root.providerKind}\0${root.scope}\0${sourceKey}\0${parsed.name}`),
        providerKind: root.providerKind,
        scope: root.scope,
        rootKind: root.rootKind,
        sourceKey,
        frontmatterName: parsed.name,
        displayName: `/${parsed.name.replace(/^\//, "")}`,
        description: parsed.description,
        contentHash,
        capabilityState: "discovery-only",
        folderName: entry.name,
        realPath: entryRealPath,
        rootLabel: root.label,
        repoRealPath: root.repoRealPath
      };
    } catch {
      scanRoot.malformedCount += 1;
      return undefined;
    }
  }

  private summariesForVariants(variants: DiscoveredSkillVariant[], context: UserSkillRunContext): UserSkillSummary[] {
    const targetProviders = uniqueProviderKinds(context.target.providerKinds);
    const byName = new Map<string, DiscoveredSkillVariant[]>();
    const seenVariants = new Set<string>();
    for (const variant of variants) {
      const identity = `${variant.providerKind}\0${variant.scope}\0${variant.sourceKey}\0${variant.frontmatterName.toLowerCase()}`;
      if (seenVariants.has(identity)) {
        continue;
      }
      seenVariants.add(identity);
      const key = variant.frontmatterName.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), variant]);
    }
    const summaries: UserSkillSummary[] = [];
    for (const group of byName.values()) {
      const providers = targetProviders.length > 0
        ? targetProviders
        : uniqueProviderKinds(group.map((variant) => variant.providerKind));
      const selected: DiscoveredSkillVariant[] = [];
      let ambiguous = false;
      for (const providerKind of providers) {
        const best = this.bestVariant(group.filter((variant) => variant.providerKind === providerKind), context);
        if (best.ambiguous) {
          ambiguous = true;
        }
        if (best.variant) {
          selected.push(best.variant);
        }
      }
      if (targetProviders.length > 0 && selected.length !== providers.length) {
        continue;
      }
      if (selected.length === 0) {
        continue;
      }
      const needsClearTarget = !context.target.hasClearTargets;
      const capabilityState: UserSkillCapabilityState = needsClearTarget || ambiguous
        ? "discovery-only"
        : selected.every((variant) => this.capabilityForVariant(variant, context) === "invocable")
          ? "invocable"
          : "discovery-only";
      const first = selected[0];
      const mention = this.mentionForSelected(first, selected, capabilityState, context);
      summaries.push({
        ...mention,
        providerKinds: uniqueProviderKinds(selected.map((variant) => variant.providerKind)),
        scopeKinds: Array.from(new Set(selected.map((variant) => variant.scope))).sort(),
        statusMessage: needsClearTarget ? "Mention a participant before selecting a skill." : ambiguous ? "Duplicate skill variants are ambiguous." : undefined,
        ambiguous
      });
    }
    return summaries.sort((left, right) => left.frontmatterName.localeCompare(right.frontmatterName));
  }

  private bestVariant(
    variants: DiscoveredSkillVariant[],
    context: UserSkillRunContext
  ): { variant?: DiscoveredSkillVariant; ambiguous: boolean } {
    const invocable = variants.filter((variant) => this.capabilityForVariant(variant, context) === "invocable");
    const candidates = invocable.length > 0 ? invocable : variants;
    const byScope = new Map<UserSkillScope, DiscoveredSkillVariant[]>();
    for (const variant of candidates) {
      byScope.set(variant.scope, [...(byScope.get(variant.scope) ?? []), variant]);
    }
    const repo = byScope.get("repo") ?? [];
    if (repo.length === 1) {
      return { variant: repo[0], ambiguous: false };
    }
    if (repo.length > 1) {
      return { variant: repo[0], ambiguous: true };
    }
    const personal = byScope.get("personal") ?? [];
    if (personal.length === 1) {
      return { variant: personal[0], ambiguous: false };
    }
    if (personal.length > 1) {
      return { variant: personal[0], ambiguous: true };
    }
    return { ambiguous: false };
  }

  private mentionForSelected(
    first: DiscoveredSkillVariant,
    selected: DiscoveredSkillVariant[],
    capabilityState: UserSkillCapabilityState,
    context: UserSkillRunContext
  ): ChatSkillMention {
    const variants = selected.map((variant): ChatSkillMentionVariant => ({
      providerKind: variant.providerKind,
      scope: variant.scope,
      rootKind: variant.rootKind,
      sourceKey: variant.sourceKey,
      frontmatterName: variant.frontmatterName,
      contentHash: variant.contentHash,
      capabilityState: this.capabilityForVariant(variant, context)
    }));
    return {
      skillId: hashText(`${USER_SKILL_HASH_VERSION}\0${selected.map((variant) => variant.id).sort().join("\0")}`),
      displayName: first.displayName,
      frontmatterName: first.frontmatterName,
      description: first.description,
      contentHash: hashText(`${USER_SKILL_HASH_VERSION}\0${variants.map((variant) => `${variant.providerKind}:${variant.contentHash}`).sort().join("\0")}`),
      capabilityState,
      variants
    };
  }

  private capabilityForVariant(
    variant: DiscoveredSkillVariant | ChatSkillMentionVariant,
    context: UserSkillRunContext,
    participantId?: string
  ): UserSkillCapabilityState {
    // Deterministic, discovery-based capability. V1 does not run any provider proof: a skill is
    // selectable when it exists for the target provider and (for repo-local skills) the repo is the
    // effective run root/cwd. Whether the provider natively invokes it is not asserted here — the
    // UI labels these as selected skills, not "proven invoked".
    if (variant.providerKind !== "codex-cli" && variant.providerKind !== "claude-code") {
      return "unsupported";
    }
    if (!context.target.hasClearTargets) {
      return "discovery-only";
    }
    if (variant.scope === "repo") {
      const repoPath = context.repoPath;
      if (!repoPath) {
        return "discovery-only";
      }
      const participantIds = context.target.participantIds.filter((id) =>
        context.participantProviderKindById?.[id] === variant.providerKind
      );
      if (participantId) {
        return this.runRootMatchesRepo(context.runRootByParticipant?.[participantId], repoPath) ? "invocable" : "discovery-only";
      }
      if (participantIds.length > 0) {
        return participantIds.every((id) => this.runRootMatchesRepo(context.runRootByParticipant?.[id], repoPath)) ? "invocable" : "discovery-only";
      }
      const runRoot = Object.prototype.hasOwnProperty.call(context.runRootByProvider ?? {}, variant.providerKind)
        ? context.runRootByProvider?.[variant.providerKind]
        : repoPath;
      return this.runRootMatchesRepo(runRoot, repoPath) ? "invocable" : "discovery-only";
    }
    return "invocable";
  }

  private runRootMatchesRepo(runRoot: string | undefined, repoPath: string): boolean {
    return Boolean(runRoot && path.resolve(runRoot) === path.resolve(repoPath));
  }

  private capabilityDiagnostics(context: UserSkillRunContext): UserSkillDiagnostics["providerCapabilities"] {
    const providerKinds = context.target.providerKinds.length > 0
      ? uniqueProviderKinds(context.target.providerKinds)
      : uniqueProviderKinds(["codex-cli", "claude-code"]);
    return providerKinds.map((providerKind) => {
      const runRoot = Object.prototype.hasOwnProperty.call(context.runRootByProvider ?? {}, providerKind)
        ? context.runRootByProvider?.[providerKind]
        : context.repoPath;
      const repoMode = runRoot ? "repo" : "no-repo";
      return {
        providerKind,
        capabilityState: "invocable" as const,
        runCondition: repoMode,
        message: runRoot
          ? "Personal and matching repo-local skills are selectable. Provider-native invocation is not verified by the app."
          : "Personal skills are selectable; repo-local skills require a conversation repo. Provider-native invocation is not verified by the app."
      };
    });
  }

  private defaultDiagnosticsContext(repoPath?: string): UserSkillRunContext {
    const runRootByProvider: Partial<Record<ChatProviderKind, string | undefined>> = {
      "codex-cli": repoPath,
      "claude-code": repoPath
    };
    return {
      repoPath,
      target: {
        participantIds: [],
        providerKinds: ["codex-cli", "claude-code"],
        hasClearTargets: true
      },
      runRootByProvider
    };
  }

  private async skillRoots(repoPath?: string): Promise<SkillRoot[]> {
    // Codex docs list personal skills at `~/.agents/skills`, but the installed CLI runtime still
    // injects `~/.codex/skills` in prompt context. Scan both personal roots for compatibility.
    // Repo-local Codex skills use documented `.agents/skills`; Claude Code uses `.claude/skills`.
    const roots: SkillRoot[] = [
      {
        providerKind: "codex-cli",
        scope: "personal",
        rootKind: "personal",
        rootPath: path.join(this.homeDir, ".codex", "skills"),
        label: "~/.codex/skills"
      },
      {
        providerKind: "codex-cli",
        scope: "personal",
        rootKind: "personal",
        rootPath: path.join(this.homeDir, ".agents", "skills"),
        label: "~/.agents/skills"
      },
      {
        providerKind: "claude-code",
        scope: "personal",
        rootKind: "personal",
        rootPath: path.join(this.homeDir, ".claude", "skills"),
        label: "~/.claude/skills"
      }
    ];
    if (repoPath) {
      const repoRealPath = await realpath(repoPath).catch(() => undefined);
      if (repoRealPath) {
        roots.push(
          {
            providerKind: "codex-cli",
            scope: "repo",
            rootKind: "repo",
            rootPath: path.join(repoRealPath, ".agents", "skills"),
            label: "repo/.agents/skills",
            repoRealPath
          },
          {
            providerKind: "claude-code",
            scope: "repo",
            rootKind: "repo",
            rootPath: path.join(repoRealPath, ".claude", "skills"),
            label: "repo/.claude/skills",
            repoRealPath
          }
        );
      }
    }
    return roots;
  }

  private async internalGeneratedFolders(rootPath: string): Promise<Set<string>> {
    const manifestPath = path.join(rootPath, INTERNAL_MANIFEST_FILE);
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { owner?: unknown; generatedFolders?: unknown };
      if (parsed.owner !== "accordagents" || !Array.isArray(parsed.generatedFolders)) {
        return new Set();
      }
      // Only internal generated folders are hidden from slash discovery. Public app-owned
      // skills (e.g. /accord) keep their folders but remain discoverable. A missing visibility
      // field (older manifests) is treated as internal so nothing is unexpectedly revealed.
      return new Set(parsed.generatedFolders.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const record = entry as { folderName?: unknown; visibility?: unknown };
        if (typeof record.folderName !== "string" || record.visibility === "public") {
          return [];
        }
        return [record.folderName];
      }));
    } catch {
      return new Set();
    }
  }

  private async hasInternalMarker(folderPath: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(path.join(folderPath, INTERNAL_MARKER_FILE), "utf8")) as { owner?: unknown; visibility?: unknown };
      // Public app-owned skills carry the AccordAgents marker too, but must stay discoverable.
      // Only internal markers (or older markers without a visibility field) hide the folder.
      return parsed.owner === "accordagents" && parsed.visibility !== "public";
    } catch {
      return false;
    }
  }
}

export function sanitizeChatSkillMention(value: unknown): ChatSkillMention | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const variants = Array.isArray(value.variants)
    ? value.variants.flatMap((variant) => {
        const sanitized = sanitizeChatSkillMentionVariant(variant);
        return sanitized ? [sanitized] : [];
      })
    : [];
  if (
    typeof value.skillId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.frontmatterName !== "string" ||
    typeof value.contentHash !== "string" ||
    !isCapabilityState(value.capabilityState) ||
    variants.length === 0
  ) {
    return undefined;
  }
  return {
    skillId: value.skillId,
    displayName: value.displayName,
    frontmatterName: value.frontmatterName,
    description: typeof value.description === "string" ? value.description : undefined,
    contentHash: value.contentHash,
    capabilityState: value.capabilityState,
    variants
  };
}

function sanitizeChatSkillMentionVariant(value: unknown): ChatSkillMentionVariant | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    !isChatProviderKind(value.providerKind) ||
    !isUserSkillScope(value.scope) ||
    !isUserSkillScope(value.rootKind) ||
    typeof value.sourceKey !== "string" ||
    typeof value.frontmatterName !== "string" ||
    typeof value.contentHash !== "string" ||
    !isCapabilityState(value.capabilityState)
  ) {
    return undefined;
  }
  return {
    providerKind: value.providerKind,
    scope: value.scope,
    rootKind: value.rootKind,
    sourceKey: value.sourceKey,
    frontmatterName: value.frontmatterName,
    contentHash: value.contentHash,
    capabilityState: value.capabilityState
  };
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value as number)));
}

function uniqueProviderKinds(values: ChatProviderKind[]): ChatProviderKind[] {
  return Array.from(new Set(values)).sort();
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChatProviderKind(value: unknown): value is ChatProviderKind {
  return value === "codex-cli" || value === "claude-code";
}

function isUserSkillScope(value: unknown): value is UserSkillScope {
  return value === "personal" || value === "repo";
}

function isCapabilityState(value: unknown): value is UserSkillCapabilityState {
  return value === "invocable" || value === "discovery-only" || value === "unsupported";
}

function providerLabel(providerKind: ChatProviderKind): string {
  return providerKind === "codex-cli" ? "Codex" : "Claude";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
