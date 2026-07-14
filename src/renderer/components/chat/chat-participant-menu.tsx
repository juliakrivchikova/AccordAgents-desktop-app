import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import type {
  AgentHealth,
  AppSettings,
  ChatParticipant,
  ChatParticipantConfig,
  ChatParticipantWatcherState,
  CloudRunRemoteExecutionMode
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import {
  avatarForChatAvatarOption,
  avatarForChatParticipant
} from "./chat-avatars";
import { chatRoleLabel } from "./chat-conversation-data";
import { ChatParticipantDraftRow } from "./chat-participant-draft-row";
import { ChatParticipantMenuView } from "./chat-participant-menu-view";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import type { ChatParticipantDraft } from "./chat-participant-drafts";
import {
  addableSavedParticipantConfigs,
  activeChatRoleConfigs,
  chatParticipantPermissionSummary,
  chatRunLocationLabel,
  labelForProviderKind,
  normalizedChatDrafts,
  validateChatCliAgents,
  validateChatParticipantDrafts
} from "./chat-participant-drafts";

export type { ChatParticipantMenuViewProps } from "./chat-participant-menu-view";
export type { ChatParticipantRosterStatus } from "./chat-roster-status";
export { RosterStatusIndicator } from "./chat-roster-status";

export function ChatParticipantMenu(props: {
  participants: ChatParticipant[];
  participantHasRunById: ReadonlyMap<string, boolean>;
  settings: AppSettings;
  agents: AgentHealth[];
  draft: string;
  addParticipantDraft: ChatParticipantDraft;
  isRunning: boolean;
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  participantWatchers?: Record<string, ChatParticipantWatcherState>;
  onDraftChange: (value: string) => void;
  onAddParticipantDraftChange: (draft: ChatParticipantDraft) => void;
  onAddParticipant: () => void;
  onAddSavedParticipant: (participant: ChatParticipantConfig, remoteExecution?: CloudRunRemoteExecutionMode) => void;
  onUpdateParticipantRuntime: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">
  ) => void;
  onCompactParticipant: (participantId: string) => void;
  onRemoveParticipant: (participantId: string) => void;
  onJumpToParticipantLastMessage: (participantId: string) => void;
  onManageInSettings: () => void;
}): JSX.Element {
  const existingHandles = new Set(props.participants.map((participant) => participant.handle.toLowerCase()));
  const addDraft = normalizedChatDrafts([props.addParticipantDraft]);
  const addValidation = validateChatParticipantDrafts(
    addDraft,
    activeChatRoleConfigs(props.settings),
    existingHandles,
    props.settings.chatBehaviorRules
  ) ?? validateChatCliAgents(addDraft, props.agents, props.settings.providers);
  const savedParticipants = addableSavedParticipantConfigs(props.settings, props.agents, existingHandles);
  const activeWatcher = props.participants.find((participant) => participant.autoWatch === true);
  const autoWatchConflictReason = activeWatcher
    ? `Only one member can watch a chat. Turn off @${activeWatcher.handle} first.`
    : undefined;

  return (
    <ChatParticipantMenuView
      participants={props.participants}
      participantHasRunById={props.participantHasRunById}
      draft={props.draft}
      addValidation={addValidation}
      isRunning={props.isRunning}
      participantStatusById={props.participantStatusById}
      participantWatchers={props.participantWatchers}
      savedParticipants={savedParticipants}
      hasSavedParticipantConfigs={props.settings.chatParticipantConfigs.length > 0}
      renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant, chatParticipantDisplayName(participant))} />}
      renderSavedParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
      participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      participantRoleArchived={(participant) => Boolean(
        props.settings.chatRoleConfigs.find((role) => role.id === participant.roleConfigId)?.archivedAt
      )}
      participantRoleDefaults={(participant) =>
        props.settings.chatRoleConfigs.find((role) => role.id === participant.roleConfigId)?.participantDefaults
      }
      savedParticipantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      savedParticipantSummary={(participant) => savedParticipantSummary(props.settings, participant, autoWatchConflictReason)}
      addParticipantEditor={(
        <ChatParticipantDraftRow
          draft={props.addParticipantDraft}
          settings={props.settings}
          agents={props.agents}
          autoWatchDisabledReason={props.addParticipantDraft.autoWatch ? autoWatchConflictReason : undefined}
          renderAvatarOption={(option) => <Avatar className="avatar-choice-preview" spec={avatarForChatAvatarOption(option)} />}
          onChange={props.onAddParticipantDraftChange}
        />
      )}
      onDraftChange={props.onDraftChange}
      onAddParticipant={props.onAddParticipant}
      onAddSavedParticipant={props.onAddSavedParticipant}
      onUpdateParticipantRuntime={props.onUpdateParticipantRuntime}
      onCompactParticipant={props.onCompactParticipant}
      onRemoveParticipant={props.onRemoveParticipant}
      onJumpToParticipantLastMessage={props.onJumpToParticipantLastMessage}
      onManageInSettings={props.onManageInSettings}
    />
  );
}

function savedParticipantSummary(settings: AppSettings, participant: ChatParticipantConfig, autoWatchConflictReason?: string): string {
  return [
    labelForProviderKind(settings.providers, participant.kind),
    participant.kind === "codex-cli" ? `run ${chatRunLocationLabel(participant.remoteExecution).toLowerCase()}` : "",
    participant.skipToolchainPreflight ? "skip preflight" : "",
    participant.model,
    participant.reasoningEffort ? `reasoning ${chatReasoningEffortLabel(participant.reasoningEffort)}` : "",
    participant.autoWatchEnabled ? (autoWatchConflictReason ? "auto-watch off: watcher already set" : "auto-watch") : "",
    chatParticipantPermissionSummary(participant)
  ].filter(Boolean).join(" · ");
}
