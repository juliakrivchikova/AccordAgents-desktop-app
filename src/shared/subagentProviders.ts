import { isChatProviderKind } from "./chatProviders";
import { CLI_PROVIDER_DISPLAY_ORDER } from "./cliReadiness";
import { normalizeChatReasoningEffort } from "./reasoningEffort";
import type {
  ChatProviderKind,
  ChatReasoningEffort,
  ChatSubagentProviders,
  EffectiveSubagentProvider,
  SubagentDefaultUpdate,
  SubagentProviderChange,
  SubagentProviderEntry,
  SubagentValueSource
} from "./types";

// The CLIs a chat may give tasks to (the side panel's Agents, the User,
// 2026-11-26): every CLI that is ready, each on its model and effort from
// Settings → General → Agents. A chat may take one out or give it a model and
// effort of its own; that is for that chat only. A value set in the chat wins
// over Settings', which wins over the CLI's own default.

export interface SubagentListInput {
  /** The CLIs ready where the chat's members run (readyProviderKinds). */
  ready: readonly ChatProviderKind[];
  /** Settings → General → Agents. */
  defaults?: readonly SubagentProviderEntry[];
  /** The chat's own changes. */
  thread?: ChatSubagentProviders;
  /** A Cloud run main session: its members run there, where Antigravity does not. */
  cloudRun?: boolean;
}

/** Whether a CLI can be one of the chat's agents where its members run. */
function runsThere(kind: ChatProviderKind, input: Pick<SubagentListInput, "ready" | "cloudRun">): boolean {
  return input.ready.includes(kind) && !(input.cloudRun && kind === "gemini-cli");
}

/** The chat's Agents list, in the CLIs' display order, with each one's model and effort. */
export function effectiveSubagentProviders(input: SubagentListInput): EffectiveSubagentProvider[] {
  const own = new Map((input.thread?.entries ?? []).map((entry) => [entry.kind, entry]));
  const defaults = new Map((input.defaults ?? []).map((entry) => [entry.kind, entry]));
  return CLI_PROVIDER_DISPLAY_ORDER
    .filter((kind) => runsThere(kind, input) && !own.get(kind)?.removed)
    .map((kind) => merged(kind, own.get(kind), defaults.get(kind)));
}

/** The CLIs this chat took out that it can have back (ready where its members run). */
export function addableSubagentProviders(input: Pick<SubagentListInput, "ready" | "thread" | "cloudRun">): ChatProviderKind[] {
  const removed = new Set((input.thread?.entries ?? []).filter((entry) => entry.removed).map((entry) => entry.kind));
  return CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => removed.has(kind) && runsThere(kind, input));
}

/** Whether this chat took the CLI out of its list. */
export function subagentRemovedInChat(thread: ChatSubagentProviders | undefined, kind: ChatProviderKind): boolean {
  return Boolean(thread?.entries.some((entry) => entry.kind === kind && entry.removed));
}

function merged(kind: ChatProviderKind, layer: SubagentProviderEntry | undefined, base: SubagentProviderEntry | undefined): EffectiveSubagentProvider {
  const source = (own: unknown, lower: unknown): SubagentValueSource => own ? "thread" : lower ? "settings" : "default";
  // An effort is chosen for a model: a model of the chat's own does not take
  // Settings' effort (Luna has no Ultra), it starts from its own default.
  const baseEffort = layer?.model ? undefined : base?.reasoningEffort;
  return {
    kind,
    model: layer?.model ?? base?.model,
    modelFrom: source(layer?.model, base?.model),
    reasoningEffort: layer?.reasoningEffort ?? baseEffort,
    effortFrom: source(layer?.reasoningEffort, baseEffort)
  };
}

/** One change to a chat's own changes: only what differs from the list as
 *  Settings makes it is kept. */
export function applySubagentProviderChange(entries: readonly SubagentProviderEntry[], change: SubagentProviderChange): SubagentProviderEntry[] {
  const current = entries.find((entry) => entry.kind === change.kind);
  const others = entries.filter((entry) => entry.kind !== change.kind);
  if (change.type === "remove") {
    return [...others, { kind: change.kind, removed: true }];
  }
  if (change.type === "add") {
    // Back in the list on Settings' values; a CLI that was not out (a second
    // window's late Add) keeps the values this chat gave it.
    return current?.removed ? others : [...entries];
  }
  const next = withValues({ kind: change.kind, model: current?.model, reasoningEffort: current?.reasoningEffort }, change.model, change.reasoningEffort);
  return next.model || next.reasoningEffort ? [...others, next] : others;
}

/** One change to Settings → General → Agents: a CLI with nothing set has no entry. */
export function applySubagentDefaultUpdate(entries: readonly SubagentProviderEntry[], update: SubagentDefaultUpdate): SubagentProviderEntry[] {
  const current = entries.find((entry) => entry.kind === update.kind);
  const model = update.model === undefined ? current?.model : update.model ?? undefined;
  const reasoningEffort = update.reasoningEffort === undefined ? current?.reasoningEffort : update.reasoningEffort ?? undefined;
  const next = withValues({ kind: update.kind }, model, reasoningEffort);
  const others = entries.filter((entry) => entry.kind !== update.kind);
  if (!next.model && !next.reasoningEffort) {
    return others;
  }
  // Kept in place: the file changes no more than the value.
  const index = entries.findIndex((entry) => entry.kind === update.kind);
  return index < 0 ? [...entries, next] : entries.map((entry, at) => at === index ? next : entry);
}

/** Values as they came over IPC: what is not a string is no value. */
function withValues(entry: SubagentProviderEntry, rawModel: unknown, rawEffort: unknown): SubagentProviderEntry {
  const next: SubagentProviderEntry = { kind: entry.kind };
  const model = typeof rawModel === "string" ? rawModel.trim() : undefined;
  const reasoningEffort = normalizeChatReasoningEffort(rawEffort, entry.kind);
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

/** A chat's own changes as stored; undefined when it has none. A chat from
 *  before 2026-11-26 may hold a CLI it added then ({ kind } alone): that
 *  changes nothing now, every ready CLI is in the list. */
export function chatSubagentProvidersOf(metadata: { subagentProviders?: unknown } | undefined): ChatSubagentProviders | undefined {
  const value = metadata?.subagentProviders as { entries?: unknown } | undefined;
  return value && typeof value === "object" ? { entries: normalizeSubagentProviderEntries(value.entries, true) } : undefined;
}
