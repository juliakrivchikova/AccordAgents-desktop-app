import type { ChatReasoningEffort } from "./members";
import type { ChatProviderKind } from "./providers";

/**
 * One CLI in the Agents list the main session gives tasks to
 * (app_chat_delegate_task): its model and effort in Settings → General →
 * Agents, or a chat's own change to it. Model and effort, when set, are what
 * its new members run on; none: Settings' value, then the CLI's own.
 */
export interface SubagentProviderEntry {
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  /** A chat's own change only: the CLI is taken out of this chat's list. */
  removed?: true;
}

/** A chat's own changes to its Agents list (conversation.metadata.subagentProviders):
 *  a CLI taken out, or its own model and effort. The list itself is every CLI
 *  that is ready, so a chat with none (or none of these) has every ready CLI. */
export interface ChatSubagentProviders {
  entries: SubagentProviderEntry[];
}

/** Where a provider's value comes from, for the side panel to say. */
export type SubagentValueSource = "thread" | "settings" | "default";

export interface EffectiveSubagentProvider {
  kind: ChatProviderKind;
  model?: string;
  modelFrom: SubagentValueSource;
  reasoningEffort?: ChatReasoningEffort;
  effortFrom: SubagentValueSource;
}

export type SubagentProviderChange =
  /** Back in this chat's list (one taken out). */
  | { type: "add"; kind: ChatProviderKind }
  /** Out of this chat's list. */
  | { type: "remove"; kind: ChatProviderKind }
  /** Undefined values go back to Settings' value. */
  | { type: "set"; kind: ChatProviderKind; model?: string; reasoningEffort?: ChatReasoningEffort };

/** What a change left: the chat's own changes. */
export interface UpdateChatSubagentProvidersResult {
  conversationId: string;
  subagentProviders: ChatSubagentProviders;
}

/** A change to one chat's Agents list; it is for that chat only. */
export interface UpdateChatSubagentProvidersRequest {
  conversationId: string;
  change: SubagentProviderChange;
}

/** A change to one CLI's model and effort in Settings → General → Agents:
 *  null goes back to the CLI's own, undefined leaves it as it is. */
export interface SubagentDefaultUpdate {
  kind: ChatProviderKind;
  model?: string | null;
  reasoningEffort?: ChatReasoningEffort | null;
}
