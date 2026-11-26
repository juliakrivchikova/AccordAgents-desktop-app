import { CLI_PROVIDER_SETUP } from "../../../shared/cliReadiness";
import type { SessionsMemberRow } from "../../../shared/mainSessionView";
import { effectiveSubagentProviders } from "../../../shared/subagentProviders";
import type { ChatProviderKind, ChatSubagentProviders, EffectiveSubagentProvider, SubagentProviderEntry } from "../../../shared/types";

// The side panel's Agents (variant B, the User, 2026-11-26): the CLIs the main
// session gives tasks to, each with its model and effort, and the sessions it
// gave them folded under each.

export interface SubagentPanelProvider extends EffectiveSubagentProvider {
  label: string;
  /** Its sessions working or waiting now, and those that ended but were not folded away. */
  rows: SessionsMemberRow[];
  running: number;
  waiting: number;
  /** A provider no longer in the chat's list, shown while it still has sessions. */
  offList: boolean;
  /** Its entry at each scope, for the settings window to start from. */
  projectEntry?: SubagentProviderEntry;
  threadEntry?: SubagentProviderEntry;
}

/** The providers the panel lists, in the chat's order, with the current sessions
 *  under each. A chat from before the list (`effective` undefined) shows the
 *  providers its sessions run on. A provider taken out of the list stays while
 *  it still has sessions here, so nothing running disappears from view. */
export function subagentPanelProviders(
  project: readonly SubagentProviderEntry[] | undefined,
  thread: ChatSubagentProviders | undefined,
  current: readonly SessionsMemberRow[]
): SubagentPanelProvider[] {
  const effective = effectiveSubagentProviders(project, thread);
  const listed: EffectiveSubagentProvider[] = effective
    ? [...effective]
    : uniqueKinds(current).map((kind) => defaultProvider(kind));
  const inList = new Set(listed.map((provider) => provider.kind));
  const offList = uniqueKinds(current).filter((kind) => !inList.has(kind));
  const entries = (provider: SubagentPanelProvider): SubagentPanelProvider => ({
    ...provider,
    projectEntry: project?.find((entry) => entry.kind === provider.kind),
    threadEntry: thread?.entries.find((entry) => entry.kind === provider.kind && !entry.removed)
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
  return { kind, modelFrom: "default", effortFrom: "default", addedInThread: false };
}

function uniqueKinds(rows: readonly SessionsMemberRow[]): ChatProviderKind[] {
  return [...new Set(rows.map((row) => row.participant.kind))];
}

/** A value set for this chat (the row's pin): what Reset at its scope takes back. */
export function hasThreadOverride(provider: Pick<EffectiveSubagentProvider, "modelFrom" | "effortFrom">): boolean {
  return provider.modelFrom === "thread" || provider.effortFrom === "thread";
}
