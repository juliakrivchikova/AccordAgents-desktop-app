import { MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID } from "../../../shared/mainSession";
import type { ChatParticipantConfig, ChatProviderKind } from "../../../shared/types";
import { newChatMemberPermissions } from "../../../shared/agentPermissions";
import { applyChatAccessOption, startChatAccessOption } from "../../../shared/chatAccessModes";
import type { NewChatMainSessionStart } from "../../../shared/newChatDefaults";
import type { CloudRunSelection } from "../../../shared/cloudRunPreparation";
import type { MachineRecord } from "../../../shared/machineLink";
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
  startAccess?: string,
  /** How Settings → General → New chats starts it on this provider
   *  (newChatDesktopStart): its model, effort, mode (over the one her
   *  config starts the CLI in), where it runs and compaction right. */
  start?: NewChatDesktopStart
): ChatParticipantConfig {
  const permissions = {
    ...newChatMemberPermissions(hasProject),
    requestParticipants: "allow" as const,
    manageRolesParticipants: "allow" as const,
    ...(start ? { requestCompaction: start.requestCompaction } : {})
  };
  const access = sessionsView
    ? applyChatAccessOption(startChatAccessOption(kind, start?.access ?? startAccess), permissions)
    : { agentMode: "default" as const, permissions };
  return {
    id: NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID,
    handle: MAIN_SESSION_HANDLE,
    roleConfigId: MAIN_SESSION_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    // An added provider the New chat chip chose for it (sessions view).
    ...(hostId ? { hostId } : {}),
    ...(start?.model ? { model: start.model } : {}),
    ...(start?.reasoningEffort ? { reasoningEffort: start.reasoningEffort } : {}),
    ...(start?.homeMachineId ? { homeMachineId: start.homeMachineId } : {}),
    ...(start?.cloudRun ? { cloudRun: start.cloudRun } : {}),
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
  startAccess?: string,
  start?: NewChatDesktopStart
): ChatParticipantDraft {
  const draft = chatParticipantConfigToDraftWithRuntimeOverrides(
    newChatMainSessionParticipantConfig(kind, hasProject, hostId, sessionsView, startAccess, start),
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

/** How Settings → General → New chats starts a new chat on this computer's
 *  New chat: its machine set as New chat's Runs on control sets that machine
 *  when it is chosen there (ParticipantRunLocation): a machine on an AWS
 *  instance as Cloud run on that instance, whose first turn makes it ready
 *  and copies the chat's project there; any other machine as its own. */
export type NewChatDesktopStart = Omit<NewChatMainSessionStart, "homeMachineId"> & { homeMachineId?: string; cloudRun?: CloudRunSelection };

export function newChatDesktopStart(
  start: NewChatMainSessionStart | undefined,
  kind: ChatProviderKind,
  machines: ReadonlyArray<Pick<MachineRecord, "id" | "awsInstanceId">>
): NewChatDesktopStart | undefined {
  if (!start?.homeMachineId) return start;
  const instanceId = machines.find((machine) => machine.id === start.homeMachineId)?.awsInstanceId;
  // Cloud run is Claude Code's and Codex's (the control offers it to them only).
  if (!instanceId || (kind !== "claude-code" && kind !== "codex-cli")) return start;
  const { homeMachineId: _machine, ...rest } = start;
  return { ...rest, cloudRun: { instanceId } };
}

/** Where the New chat screen's main session runs: what its controls chose
 *  (Local included), else where Settings → General → New chats puts it. */
export function newChatMainSessionPlace(
  runtimeOverride: ChatParticipantRuntimeOverride | undefined,
  start: Pick<NewChatDesktopStart, "homeMachineId" | "cloudRun"> | undefined
): Pick<ChatParticipantRuntimeOverride, "homeMachineId" | "cloudRun"> {
  const chose = Boolean(runtimeOverride) && ("homeMachineId" in runtimeOverride! || "cloudRun" in runtimeOverride!);
  return chose
    ? { homeMachineId: runtimeOverride!.homeMachineId, cloudRun: runtimeOverride!.cloudRun }
    : { homeMachineId: start?.homeMachineId, cloudRun: start?.cloudRun };
}
