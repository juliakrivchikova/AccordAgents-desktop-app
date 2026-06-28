import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import type {
  AgentHealth,
  AppSettings,
  ChatParticipant,
  ChatParticipantConfig
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
  settings: AppSettings;
  agents: AgentHealth[];
  draft: string;
  addParticipantDraft: ChatParticipantDraft;
  isRunning: boolean;
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  onDraftChange: (value: string) => void;
  onAddParticipantDraftChange: (draft: ChatParticipantDraft) => void;
  onAddParticipant: () => void;
  onAddSavedParticipant: (participant: ChatParticipantConfig) => void;
  onUpdateParticipantRuntime: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution">
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
  ) ?? validateChatCliAgents(addDraft, props.agents);
  const savedParticipants = addableSavedParticipantConfigs(props.settings, props.agents, existingHandles);

  return (
    <ChatParticipantMenuView
      participants={props.participants}
      draft={props.draft}
      addValidation={addValidation}
      isRunning={props.isRunning}
      participantStatusById={props.participantStatusById}
      savedParticipants={savedParticipants}
      hasSavedParticipantConfigs={props.settings.chatParticipantConfigs.length > 0}
      renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant, chatParticipantDisplayName(participant))} />}
      renderSavedParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
      participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      participantRoleArchived={(participant) => Boolean(
        props.settings.chatRoleConfigs.find((role) => role.id === participant.roleConfigId)?.archivedAt
      )}
      savedParticipantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      savedParticipantSummary={(participant) => savedParticipantSummary(props.settings, participant)}
      addParticipantEditor={(
        <ChatParticipantDraftRow
          draft={props.addParticipantDraft}
          settings={props.settings}
          agents={props.agents}
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

function savedParticipantSummary(settings: AppSettings, participant: ChatParticipantConfig): string {
  return [
    labelForProviderKind(settings.providers, participant.kind),
    participant.model,
    participant.reasoningEffort ? `reasoning ${chatReasoningEffortLabel(participant.reasoningEffort)}` : "",
    chatParticipantPermissionSummary(participant)
  ].filter(Boolean).join(" · ");
}
