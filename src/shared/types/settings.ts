import type { MobileControlSettings } from "../mobilePairing";
import type { CustomAvatarSummary } from "../avatarStudio";
import type { CloudRunsSettings } from "./cloudRuns";
import type { RepoFileExternalOpenAction, RepoFileOpenAction } from "./files";
import type { ChatReasoningEffort } from "./members";
import type { ChatProviderKind, CliProviderHost, ProviderSettings } from "./providers";
import type { ChatBehaviorRuleConfig, ChatParticipantConfig, ChatRoleConfig, ChatSavedPromptConfig } from "./roles";

export type ChatPromptContextMode = "off" | "all_unseen" | "latest_unseen";

export interface ChatPromptContextScopeSettings {
  mode: ChatPromptContextMode;
  limit?: number;
}

export interface ChatPromptContextSettings {
  thread: ChatPromptContextScopeSettings;
  timeline: ChatPromptContextScopeSettings;
}

export interface AppSettings {
  roundLimitDefault: number;
  betaUpdates: boolean;
  /** Error, crash and usage reports to the app's Sentry project; on unless
   *  the User turned them off. */
  crashReports: boolean;
  cliAgentRunTimeoutMs: number;
  chatParticipantRequestMaxDepth: number;
  chatParticipantRequestPromptMaxChars: number;
  chatAutoWatchWakeLimit: number;
  chatPromptContext: ChatPromptContextSettings;
  cloudRuns: CloudRunsSettings;
  mobileControl: MobileControlSettings;
  providers: ProviderSettings[];
  cliProviderHosts: CliProviderHost[];
  chatRoleConfigs: ChatRoleConfig[];
  chatBehaviorRules: ChatBehaviorRuleConfig[];
  chatSavedPrompts: ChatSavedPromptConfig[];
  chatParticipantConfigs: ChatParticipantConfig[];
  chatCustomAvatars: CustomAvatarSummary[];
  chatParticipantSeedState?: ChatParticipantSeedState;
  /** The CLI a new chat runs on (Settings → General → New chats). */
  assistantProviderKind?: ChatProviderKind;
  /** How a new chat starts besides its CLI (src/shared/newChatDefaults.ts). */
  newChatDefaults?: NewChatDefaults;
  lastSuccessfulChatProviderKind?: ChatProviderKind;
  lastRepoPath?: string;
  repoFileOpenAction?: RepoFileOpenAction;
  repoFileExternalOpenAction?: RepoFileExternalOpenAction;
}

export interface NewChatDefaults {
  /** The CLI the model, effort and mode were chosen for: they apply only
   *  while a new chat runs on that CLI's own sign-in. */
  kind?: ChatProviderKind;
  /** None: the model the CLI runs by default. */
  model?: string;
  /** None: the CLI's own effort. */
  reasoningEffort?: ChatReasoningEffort;
  /** The CLI's mode by its own id (chatAccessModes.ts); none: the mode the
   *  User's own config starts the CLI in where it runs. */
  access?: string;
  /** The machine a new chat runs on; none: this computer. */
  homeMachineId?: string;
  /** Compaction without a card (the agent's own request to compact its
   *  context). Off: it asks first. */
  compactWithoutAsking: boolean;
  /** Creating scheduled tasks without a card. Off (none): it asks first. */
  scheduleWithoutAsking?: true;
}

/** A change from Settings: a value, `null` to go back to the CLI's own, or
 *  absent to keep it. Model, effort and mode name the CLI (`kind`) they are
 *  for. */
export interface NewChatDefaultsUpdate {
  kind?: ChatProviderKind;
  model?: string | null;
  reasoningEffort?: ChatReasoningEffort | null;
  access?: string | null;
  homeMachineId?: string | null;
  compactWithoutAsking?: boolean;
  scheduleWithoutAsking?: boolean;
}

/** How a chat with a main session is shown (shared/mainSession.ts): "classic"
 *  is the timeline with avatars where every member's reply is on it;
 *  "sessions" shows only the main session on the timeline and each member's
 *  session in the right panel. A view only: the chat works the same in both.
 *  A chat made before the main session existed is always "classic". */
export type ChatViewMode = "classic" | "sessions";

export interface ChatParticipantSeedRecord {
  participantConfigId: string;
  updatedAt: string;
}

export interface ChatParticipantSeedState {
  seededProviders?: Partial<Record<ChatProviderKind, ChatParticipantSeedRecord>>;
  deletedSeedProviders?: Partial<Record<ChatProviderKind, ChatParticipantSeedRecord>>;
}

/** Claude in Chrome as this computer's Claude Code has it ("Enabled by
 *  default" in its `/chrome` dialog). */
export interface ClaudeChromeSetting {
  enabledByDefault: boolean;
  /** CLAUDE_CODE_ENABLE_CFC in the environment decides it instead, as in the
   *  CLI itself. */
  environmentDecides?: boolean;
}
