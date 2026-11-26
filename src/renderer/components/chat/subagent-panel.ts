import { CLI_PROVIDER_DISPLAY_ORDER, CLI_PROVIDER_SETUP, readinessForProvider, readyProviderKinds } from "../../../shared/cliReadiness";
import type { SessionsMemberRow } from "../../../shared/mainSessionView";
import { effectiveSubagentProviders, type SubagentListInput } from "../../../shared/subagentProviders";
import type { AgentHealth, ChatProviderKind, EffectiveSubagentProvider, ProviderSettings, SubagentProviderEntry } from "../../../shared/types";

// The side panel's Agents (variant B, the User, 2026-11-26): every CLI ready
// here, less those this chat took out, each with its model and effort, and the
// sessions the main session gave them folded under each.

export interface SubagentPanelProvider extends EffectiveSubagentProvider {
  label: string;
  /** Its sessions working or waiting now, and those that ended but were not folded away. */
  rows: SessionsMemberRow[];
  running: number;
  waiting: number;
  /** A provider no longer in the chat's list, shown while it still has sessions. */
  offList: boolean;
  /** Settings' values and the chat's own, for the settings window to start from. */
  defaultEntry?: SubagentProviderEntry;
  threadEntry?: SubagentProviderEntry;
}

/** The providers the panel lists, in the display order, with the current
 *  sessions under each. A provider out of the list (taken out, or no longer
 *  ready) stays while it still has sessions here, so nothing running
 *  disappears from view. */
export function subagentPanelProviders(list: SubagentListInput, current: readonly SessionsMemberRow[]): SubagentPanelProvider[] {
  const listed = effectiveSubagentProviders(list);
  const inList = new Set(listed.map((provider) => provider.kind));
  const offList = uniqueKinds(current).filter((kind) => !inList.has(kind));
  const entries = (provider: SubagentPanelProvider): SubagentPanelProvider => ({
    ...provider,
    defaultEntry: list.defaults?.find((entry) => entry.kind === provider.kind),
    threadEntry: list.thread?.entries.find((entry) => entry.kind === provider.kind && !entry.removed)
  });
  return [
    ...listed.map((provider) => entries(withRows(provider, current, false))),
    ...offList.map((kind) => entries(withRows(defaultProvider(kind), current, true)))
  ];
}

function withRows(provider: EffectiveSubagentProvider, current: readonly SessionsMemberRow[], offList: boolean): SubagentPanelProvider {
  const rows = current.filter((row) => row.participant.kind === provider.kind);
  return {
    ...provider,
    label: CLI_PROVIDER_SETUP[provider.kind].label,
    rows,
    running: rows.filter((row) => row.status === "running").length,
    waiting: rows.filter((row) => row.status === "waiting").length,
    offList
  };
}

function defaultProvider(kind: ChatProviderKind): EffectiveSubagentProvider {
  return { kind, modelFrom: "default", effortFrom: "default" };
}

function uniqueKinds(rows: readonly SessionsMemberRow[]): ChatProviderKind[] {
  return [...new Set(rows.map((row) => row.participant.kind))];
}

/** The CLIs ready on this computer, and whether any is still being checked
 *  (then an empty list says nothing yet). */
export function subagentReadiness(agents: readonly AgentHealth[], providers: readonly ProviderSettings[]): { ready: ChatProviderKind[]; checking: boolean } {
  return {
    ready: readyProviderKinds([...agents], [...providers]),
    checking: CLI_PROVIDER_DISPLAY_ORDER.some((kind) => readinessForProvider(kind, [...agents], [...providers]) === "checking")
  };
}

/** A value set for this chat (the row's pin): what Reset takes back. */
export function hasThreadOverride(provider: Pick<EffectiveSubagentProvider, "modelFrom" | "effortFrom">): boolean {
  return provider.modelFrom === "thread" || provider.effortFrom === "thread";
}
