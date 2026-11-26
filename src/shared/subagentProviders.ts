import { isChatProviderKind } from "./chatProviders";
import { normalizeChatReasoningEffort } from "./reasoningEffort";
import type {
  ChatProviderKind,
  ChatReasoningEffort,
  ChatSubagentProviders,
  EffectiveSubagentProvider,
  SubagentProviderChange,
  SubagentProviderEntry,
  SubagentProviderScope,
  SubagentValueSource
} from "./types";

// The CLIs a chat may give tasks to (the side panel's providers): a project's
// list in Settings, by its folder, and a chat's own layer over it. A value set
// in the chat wins over the project's, which wins over the CLI's own default.

/** The key a project's list is kept under: the chat's folder, without a trailing
 *  separator (a root keeps its own). No folder, no project list. */
export function subagentProjectKey(repoPath: string | undefined): string | undefined {
  const path = repoPath?.trim();
  if (!path) {
    return undefined;
  }
  return path.replace(/[\\/]+$/, "") || path.slice(0, 1);
}

/** A chat's project key wherever it runs: on a machine its folder is a local copy,
 *  and the computer's own folder (machineRepository.sourcePath) names the project. */
export function chatSubagentProjectKey(chat: { repoPath?: string; metadata?: { machineRepository?: unknown } }): string | undefined {
  const source = (chat.metadata?.machineRepository as { sourcePath?: unknown } | undefined)?.sourcePath;
  return subagentProjectKey(typeof source === "string" && source.trim() ? source : chat.repoPath);
}

/** The providers a chat may give tasks to, with their model and effort; undefined
 *  for a chat from before the list (its main session may use any ready CLI). */
export function effectiveSubagentProviders(
  project: readonly SubagentProviderEntry[] | undefined,
  thread: ChatSubagentProviders | undefined
): EffectiveSubagentProvider[] | undefined {
  if (!thread) {
    return undefined;
  }
  const own = new Map(thread.entries.map((entry) => [entry.kind, entry]));
  const inProject = new Set((project ?? []).map((entry) => entry.kind));
  const providers: EffectiveSubagentProvider[] = [];
  for (const base of project ?? []) {
    const layer = own.get(base.kind);
    if (!layer?.removed) {
      providers.push(merged(base.kind, layer, base, false));
    }
  }
  for (const layer of thread.entries) {
    if (!layer.removed && !inProject.has(layer.kind)) {
      providers.push(merged(layer.kind, layer, undefined, true));
    }
  }
  return providers;
}

function merged(
  kind: ChatProviderKind,
  layer: SubagentProviderEntry | undefined,
  base: SubagentProviderEntry | undefined,
  addedInThread: boolean
): EffectiveSubagentProvider {
  const source = (own: unknown, lower: unknown): SubagentValueSource => own ? "thread" : lower ? "project" : "default";
  // An effort is chosen for a model: a model of the chat's own does not take the
  // project's effort (Luna has no Ultra), it starts from its own default.
  const baseEffort = layer?.model ? undefined : base?.reasoningEffort;
  return {
    kind,
    model: layer?.model ?? base?.model,
    modelFrom: source(layer?.model, base?.model),
    reasoningEffort: layer?.reasoningEffort ?? baseEffort,
    effortFrom: source(layer?.reasoningEffort, baseEffort),
    addedInThread
  };
}

/** One change at one scope. `entries` is that scope's list (the project's, or the
 *  chat's own layer); `project` is the project's list, which a chat's layer sits on. */
export function applySubagentProviderChange(
  scope: SubagentProviderScope,
  entries: readonly SubagentProviderEntry[],
  change: SubagentProviderChange,
  project: readonly SubagentProviderEntry[] = []
): SubagentProviderEntry[] {
  const current = entries.find((entry) => entry.kind === change.kind);
  const others = entries.filter((entry) => entry.kind !== change.kind);
  const replace = (next: SubagentProviderEntry | undefined): SubagentProviderEntry[] => {
    if (!next) {
      return others;
    }
    // Kept in place: the side panel lists the providers in the order they were added.
    const index = entries.findIndex((entry) => entry.kind === change.kind);
    return index < 0 ? [...entries, next] : entries.map((entry, at) => at === index ? next : entry);
  };
  if (scope === "project") {
    if (change.type === "remove") {
      return others;
    }
    return replace(withValues({ kind: change.kind, model: current?.model, reasoningEffort: current?.reasoningEffort }, change));
  }
  const inProject = project.some((entry) => entry.kind === change.kind);
  if (change.type === "remove") {
    return replace(inProject ? { kind: change.kind, removed: true } : undefined);
  }
  const next = withValues({ kind: change.kind, model: current?.model, reasoningEffort: current?.reasoningEffort }, change);
  // A provider the project already has needs no entry of its own until the chat
  // changes its model or effort.
  return replace(inProject && !next.model && !next.reasoningEffort ? undefined : next);
}

function withValues(entry: SubagentProviderEntry, change: SubagentProviderChange): SubagentProviderEntry {
  const next: SubagentProviderEntry = { kind: entry.kind };
  const model = change.type === "set" ? change.model?.trim() : entry.model;
  const reasoningEffort = change.type === "set" ? normalizeChatReasoningEffort(change.reasoningEffort, entry.kind) : entry.reasoningEffort;
  if (model) next.model = model;
  if (reasoningEffort) next.reasoningEffort = reasoningEffort;
  return next;
}

/** A list read back from Settings or a chat's metadata: what is not a valid entry is dropped. */
export function normalizeSubagentProviderEntries(value: unknown, allowRemoved: boolean): SubagentProviderEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<ChatProviderKind>();
  const entries: SubagentProviderEntry[] = [];
  for (const raw of value) {
    const item = raw as Partial<SubagentProviderEntry> | null;
    if (!item || !isChatProviderKind(item.kind) || seen.has(item.kind)) {
      continue;
    }
    seen.add(item.kind);
    const entry: SubagentProviderEntry = { kind: item.kind };
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const reasoningEffort: ChatReasoningEffort | undefined = normalizeChatReasoningEffort(item.reasoningEffort, item.kind);
    if (model) entry.model = model;
    if (reasoningEffort) entry.reasoningEffort = reasoningEffort;
    if (allowRemoved && item.removed === true) entry.removed = true;
    entries.push(entry);
  }
  return entries;
}

/** A chat's own layer as stored; undefined for a chat from before the list. */
export function chatSubagentProvidersOf(metadata: { subagentProviders?: unknown } | undefined): ChatSubagentProviders | undefined {
  const value = metadata?.subagentProviders as { entries?: unknown } | undefined;
  return value && typeof value === "object" ? { entries: normalizeSubagentProviderEntries(value.entries, true) } : undefined;
}

/** The projects' lists as stored in Settings: a key per project folder; empty lists are dropped. */
export function normalizeSubagentProvidersByProject(value: unknown): Record<string, SubagentProviderEntry[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const byProject: Record<string, SubagentProviderEntry[]> = {};
  for (const [rawKey, rawEntries] of Object.entries(value)) {
    const key = subagentProjectKey(rawKey);
    const entries = normalizeSubagentProviderEntries(rawEntries, false);
    if (key && entries.length > 0) {
      byProject[key] = entries;
    }
  }
  return Object.keys(byProject).length > 0 ? byProject : undefined;
}
