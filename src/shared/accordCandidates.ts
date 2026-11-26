import { chatViewFor, isMainSessionChat, mainSessionParticipantId } from "./mainSession";
import { chatSubagentProjectKey, chatSubagentProvidersOf, effectiveSubagentProviders } from "./subagentProviders";
import type { ChatParticipant, ConversationMetadata, EffectiveSubagentProvider, SubagentProviderEntry } from "./types";

// Who an Accord the User starts can include (the User, 2026-11-26): the
// chat's members and, in a chat with a main session, each CLI of its Agents
// list (the side panel) that has no member here yet. Such a CLI gets its
// member when the Accord starts, made as the main session's member for a
// task (Delegation.addAccordMembers), so the Accord runs as with any member.

export const ACCORD_NEEDS_MEMBERS_REASON = "Add at least two members to start Accord.";
export const ACCORD_NEEDS_AGENT_TOOLTIP = "Accord needs at least one more agent. Add one in the side panel's Agents list.";
export const ACCORD_NEEDS_AGENT_LINE = "Accord needs at least one more agent. Add one here.";

type AccordMember = Pick<ChatParticipant, "id" | "kind" | "cloudRun">;

export interface AccordChat {
  repoPath?: string;
  metadata: Pick<ConversationMetadata, "mainSessionParticipantId" | "chatView" | "subagentProviders" | "machineRepository">
    & { participants?: unknown; archived?: unknown };
}

export interface AccordCandidates<T> {
  /** The members it can include (the caller leaves out the Chat Assistant). */
  members: T[];
  /** Agents-list CLIs with no member here yet: each becomes one when the Accord starts. */
  providers: EffectiveSubagentProvider[];
}

export type AccordLaunch =
  | { kind: "ready" }
  /** The sessions view of a chat with a main session, with too few: the
   *  button opens the side panel's Agents list to add one. */
  | { kind: "add-agent" }
  | { kind: "disabled"; reason: string };

export function accordCandidates<T extends AccordMember>(
  members: readonly T[],
  chat: AccordChat,
  projectLists: Readonly<Record<string, SubagentProviderEntry[]>> | undefined
): AccordCandidates<T> {
  const mainId = mainSessionParticipantId(chat.metadata);
  const main = mainId ? members.find((member) => member.id === mainId) : undefined;
  if (!main) {
    return { members: [...members], providers: [] };
  }
  // A chat from before the list has none to offer: it is added in the side panel first.
  const agents = effectiveSubagentProviders(projectLists?.[chatSubagentProjectKey(chat) ?? ""], chatSubagentProvidersOf(chat.metadata)) ?? [];
  // The main session is not one of its own CLI's agents.
  const taken = new Set(members.filter((member) => member.id !== main.id).map((member) => member.kind));
  // A Cloud run main session's members run there too, where Antigravity does not.
  const providers = agents.filter((agent) => !taken.has(agent.kind) && !(main.cloudRun && agent.kind === "gemini-cli"));
  return { members: [...members], providers };
}

/** What the composer's Accord button does (an open chat). */
export function accordLaunch(candidates: AccordCandidates<unknown>, chat: AccordChat): AccordLaunch {
  if (chat.metadata.archived === true) {
    return { kind: "disabled", reason: "Archived chats cannot start Accord." };
  }
  if (candidates.members.length + candidates.providers.length >= 2) {
    return { kind: "ready" };
  }
  // Only the sessions view has the side panel's Agents list; the classic view
  // adds members from its roster, as before.
  return isMainSessionChat(chat.metadata) && chatViewFor(chat.metadata) === "sessions"
    ? { kind: "add-agent" }
    : { kind: "disabled", reason: ACCORD_NEEDS_MEMBERS_REASON };
}
