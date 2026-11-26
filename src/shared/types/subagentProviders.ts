import type { ChatReasoningEffort } from "./members";
import type { ChatProviderKind } from "./providers";

/**
 * A CLI the main session may give tasks to (app_chat_delegate_task), at one
 * scope: a project's list (Settings, by its folder) or a chat's own layer over
 * it. Model and effort, when set, are what its new members run on; none: the
 * layer under it, then the CLI's own.
 */
export interface SubagentProviderEntry {
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  /** A chat's layer only: the project's provider is not used in this chat. */
  removed?: true;
}

/** A chat's own layer over its project's list (conversation.metadata.subagentProviders).
 *  A chat without one predates the list: its main session may give tasks to
 *  any ready CLI, as before. */
export interface ChatSubagentProviders {
  entries: SubagentProviderEntry[];
}

export type SubagentProviderScope = "thread" | "project";

/** Where a provider's value comes from, for the side panel to say. */
export type SubagentValueSource = "thread" | "project" | "default";

export interface EffectiveSubagentProvider {
  kind: ChatProviderKind;
  model?: string;
  modelFrom: SubagentValueSource;
  reasoningEffort?: ChatReasoningEffort;
  effortFrom: SubagentValueSource;
  /** Added for this chat only (not in the project's list). */
  addedInThread: boolean;
}

export type SubagentProviderChange =
  | { type: "add"; kind: ChatProviderKind }
  | { type: "remove"; kind: ChatProviderKind }
  /** Undefined values go back to the layer under this scope. */
  | { type: "set"; kind: ChatProviderKind; model?: string; reasoningEffort?: ChatReasoningEffort };

/** What a change left: the chat's own layer, and the projects' lists after a Project change. */
export interface UpdateChatSubagentProvidersResult {
  conversationId: string;
  subagentProviders: ChatSubagentProviders;
  subagentProvidersByProject?: Record<string, SubagentProviderEntry[]>;
}

export interface UpdateChatSubagentProvidersRequest {
  conversationId: string;
  scope: SubagentProviderScope;
  change: SubagentProviderChange;
}
