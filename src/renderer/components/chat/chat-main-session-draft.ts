import { MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID } from "../../../shared/mainSession";
import type { ChatParticipantConfig, ChatProviderKind } from "../../../shared/types";
import { newChatMemberPermissions } from "../../../shared/agentPermissions";
import { isChatAssistantParticipant } from "../conversation/conversation-display";
import {
  type ChatParticipantDraft,
  type ChatParticipantRuntimeOverride,
  chatParticipantConfigToDraftWithRuntimeOverrides
} from "./chat-participant-drafts";

/** The New chat screen's locked first member: the chat's main session
 *  (docs/main-session.md), on the CLI the Assistant used to take. Its
 *  settings on that screen are kept under this id. */
export const NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID = "__new-chat-main-session__";

/** The main session as the New chat screen lists it: an ordinary member with
 *  the rights its role gives a new member (not the Assistant's narrow ones). */
export function newChatMainSessionParticipantConfig(
  kind: ChatProviderKind,
  hasProject = true,
  hostId?: string
): ChatParticipantConfig {
  return {
    id: NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID,
    handle: MAIN_SESSION_HANDLE,
    roleConfigId: MAIN_SESSION_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    // An added provider the New chat chip chose for it (sessions view).
    ...(hostId ? { hostId } : {}),
    agentMode: "default",
    // The rights an ordinary member starts with in this chat (reading its
    // project when it has one), asking members without a card as its role
    // does; the app makes the same one (ChatService.ensureMainSessionParticipant).
    permissions: { ...newChatMemberPermissions(hasProject), requestParticipants: "allow", manageRolesParticipants: "allow" },
    remoteExecution: "local",
    updatedAt: ""
  };
}

/** What a new chat is made with for its main session, with the settings the
 *  User changed for it on the New chat screen (and the added provider its
 *  chip chose). No saved member is behind it. */
export function newChatMainSessionParticipantDraft(
  kind: ChatProviderKind,
  runtimeOverride: ChatParticipantRuntimeOverride | undefined,
  hasProject = true,
  hostId?: string
): ChatParticipantDraft {
  const draft = chatParticipantConfigToDraftWithRuntimeOverrides(
    newChatMainSessionParticipantConfig(kind, hasProject, hostId),
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
