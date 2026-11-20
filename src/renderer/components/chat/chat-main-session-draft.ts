import { MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID } from "../../../shared/mainSession";
import type { ChatParticipantConfig, ChatProviderKind, ChatRoleConfig } from "../../../shared/types";
import { isChatAssistantParticipant } from "../conversation/conversation-display";
import {
  type ChatParticipantDraft,
  type ChatParticipantRuntimeOverride,
  chatParticipantConfigToDraftWithRuntimeOverrides,
  defaultChatParticipantPermissionsForRole
} from "./chat-participant-drafts";

/** The New chat screen's locked first member: the chat's main session
 *  (docs/main-session.md), on the CLI the Assistant used to take. Its
 *  settings on that screen are kept under this id. */
export const NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID = "__new-chat-main-session__";

/** The main session as the New chat screen lists it: an ordinary member with
 *  the rights its role gives a new member (not the Assistant's narrow ones). */
export function newChatMainSessionParticipantConfig(
  kind: ChatProviderKind,
  roles: readonly ChatRoleConfig[]
): ChatParticipantConfig {
  return {
    id: NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID,
    handle: MAIN_SESSION_HANDLE,
    roleConfigId: MAIN_SESSION_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    agentMode: "default",
    permissions: defaultChatParticipantPermissionsForRole({ chatRoleConfigs: [...roles] }, MAIN_SESSION_ROLE_ID),
    remoteExecution: "local",
    updatedAt: ""
  };
}

/** What a new chat is made with for its main session, with the settings the
 *  User changed for it on the New chat screen. No saved member is behind it. */
export function newChatMainSessionParticipantDraft(
  kind: ChatProviderKind,
  roles: readonly ChatRoleConfig[],
  runtimeOverride: ChatParticipantRuntimeOverride | undefined
): ChatParticipantDraft {
  const draft = chatParticipantConfigToDraftWithRuntimeOverrides(
    newChatMainSessionParticipantConfig(kind, roles),
    runtimeOverride ? { [NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID]: runtimeOverride } : {}
  );
  return { ...draft, participantConfigId: undefined };
}

/** A member the New chat screen never offers to add: the main session (the
 *  chat has one, first) and a saved Chat Assistant (not in new chats). */
export function isNewChatMainSessionOption(participant: Pick<ChatParticipantConfig, "id" | "handle" | "roleConfigId">): boolean {
  return participant.id === NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID ||
    participant.roleConfigId === MAIN_SESSION_ROLE_ID ||
    isChatAssistantParticipant(participant);
}
