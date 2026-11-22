import { MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID } from "../../../shared/mainSession";
import type { ChatParticipantConfig, ChatProviderKind } from "../../../shared/types";
import { newChatMemberPermissions } from "../../../shared/agentPermissions";
import { applyChatAccessOption, startChatAccessOption } from "../../../shared/chatAccessModes";
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
  hostId?: string,
  /** A chat that opens in the sessions view: its main session starts in the
   *  mode its CLI starts in (chatAccessModes.ts), as the CLI starts. */
  sessionsView = false,
  /** That mode by the CLI's name, as the User's own config sets it where the
   *  main session runs (CliStartDefaults.access); none: the CLI's built-in. */
  startAccess?: string
): ChatParticipantConfig {
  const permissions = { ...newChatMemberPermissions(hasProject), requestParticipants: "allow" as const, manageRolesParticipants: "allow" as const };
  const access = sessionsView ? applyChatAccessOption(startChatAccessOption(kind, startAccess), permissions) : { agentMode: "default" as const, permissions };
  return {
    id: NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID,
    handle: MAIN_SESSION_HANDLE,
    roleConfigId: MAIN_SESSION_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    // An added provider the New chat chip chose for it (sessions view).
    ...(hostId ? { hostId } : {}),
    // The rights an ordinary member starts with in this chat (reading its
    // project when it has one), asking members without a card as its role
    // does; the app makes the same one (ChatService.ensureMainSessionParticipant).
    // In the sessions view the mode its CLI starts in on top: what it is not
    // granted, the CLI asks about.
    agentMode: access.agentMode,
    permissions: access.permissions,
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
  hostId?: string,
  sessionsView = false,
  startAccess?: string
): ChatParticipantDraft {
  const draft = chatParticipantConfigToDraftWithRuntimeOverrides(
    newChatMainSessionParticipantConfig(kind, hasProject, hostId, sessionsView, startAccess),
    runtimeOverride ? { [NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID]: runtimeOverride } : {}
  );
  // The sessions view's picker has no repository switch: the main session
  // reads the chat's project when it has one, whatever folder was chosen
  // when its access was.
  const permissions = sessionsView && draft.permissions ? { ...draft.permissions, repoRead: hasProject } : draft.permissions;
  return { ...draft, permissions, participantConfigId: undefined };
}

/** A member the New chat screen never offers to add: the main session (the
 *  chat has one, first) and a saved Chat Assistant (not in new chats). */
export function isNewChatMainSessionOption(participant: Pick<ChatParticipantConfig, "id" | "handle" | "roleConfigId">): boolean {
  return participant.id === NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID ||
    participant.roleConfigId === MAIN_SESSION_ROLE_ID ||
    isChatAssistantParticipant(participant);
}
