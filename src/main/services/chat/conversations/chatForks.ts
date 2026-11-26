import {
  forkCutFor, forkedChatTitle, forkedMainSessionAccess, forkOriginFor, isForkableSessionKind, lastMemberTurnEnd
} from "../../../../shared/forkToNewChat";
import {
  DEFAULT_CHAT_VIEW, MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID, MAIN_SESSION_ROLE_MISSING_MESSAGE, isMainSessionParticipant
} from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type {
  AgentHealth, ChatParticipant, ChatParticipantSession, ChatForkSeenReply, ChatForkToNewChatSource, ChatParticipantForkOrigin,
  ChatSessionForkSource, ChatPromptContextParticipantPointers, ChatProviderKind, Conversation, StartReviewResult
} from "../../../../shared/types";
import { newChatMemberPermissions } from "../../../../shared/agentPermissions";
import { chatParticipantHome, preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { isForkSourceMissingError } from "../../cliAgents";
import type { ParticipantRunResult } from "../../providers";
import { cliProviderMetadata } from "../../../../shared/cliReadiness";
import {
  chatParticipants, chatSessions, normalizeParticipantPermissionsForRole, participantForRun, upsertSession
} from "../members/identity";
import { forkCutNoteText, forkOriginSessionName, participantHasAnswered } from "../sessions/forkNotes";
import { rebuildLastMessagesByParticipant } from "../store/lastMessages";
import { addConversationWarning, chatCreateLogPayload, createChatMessage } from "../store/messages";
import { chatIntro } from "../store/titles";
import {
  inFlightPromptContextKey, normalizedPromptContextPointers, promptContextPointerAtOrAfter, promptContextPointerForScope,
  setPromptContextPointerForScope
} from "../turns/promptContextRecords";
import type { ChatPromptContextScope } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** The newest messages of a chat a member is forked from that are read:
 *  its metadata says the rest (forkSourceChat). */
const FORK_SOURCE_MESSAGES = 40;

/** What a fork says about its copy, once per member (postForkNotice). */
type ForkNoticeKind = "origin-unavailable" | "cut-missed" | "started-clean";

/** The id of a fork's line: one per member and kind. */
function forkNoticeMessageId(participantId: string, kind: ForkNoticeKind): string {
  return `fork-notice-${kind}-${participantId}`;
}

/** Chats and members started from a copy of a session in another chat. */
export class ChatForks {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "agentEnvironment" | "creation" | "deletion" | "host" | "memberMoves" | "newChatOffers" | "promptContext" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "settings" | "storage">
  ) {}

  /**
   * Fork to new chat (src/shared/forkToNewChat.ts): a new chat whose one
   * member is its main session, a copy of a member of another chat: that
   * member's provider, model, effort, access and place it runs (as it runs
   * now: a member the main session made never above it), in its chat's
   * project, marked with where it comes from (forkOrigin). Nothing runs yet:
   * the chat opens empty, and the device the main session runs on copies the
   * member's CLI session at its first turn (startFromForkOrigin). The member
   * and its chat are not touched. Saved, and so put on the User's server,
   * like every new chat.
   */
  async createForkedConversation(forkOf: ChatForkToNewChatSource, signal: AbortSignal | undefined): Promise<StartReviewResult> {
    await this.deps.debugLogs.write("chat.fork-to-new-chat.requested", {
      sourceConversationId: forkOf.conversationId,
      sourceParticipantId: forkOf.participantId
    }).catch(() => undefined);
    let conversation: Conversation | undefined;
    let stage = "initializing";
    try {
      if (this.chat.host.machineRuntime) {
        throw new Error("A new chat is started from the User's computer.");
      }
      await this.chat.store.waitForQueuedSave(forkOf.conversationId);
      const source = await this.forkSourceChat(forkOf.conversationId);
      const member = chatParticipants(source).find((participant) => participant.id === forkOf.participantId);
      if (!member) {
        throw new Error("That member is no longer in its chat.");
      }
      // What the User sees of the member now (the User, 2026-11-21: the
      // copy is what she saw when she tapped Fork): its last reply that
      // ended a turn; the copy ends with that turn. Read first, before the
      // checks below take their time.
      const seen = await this.forkSeenReply(source, member.id);
      const running = participantForRun(source, member);
      const agents = await this.forkReadiness(running);
      signal?.throwIfAborted();
      const settings = await this.deps.settings.getPublicSettings();
      const refusal = this.chat.newChatOffers.forkToNewChatRefusal(source, running, agents, settings);
      if (refusal) {
        throw new Error(`@${member.handle} cannot be forked to a new chat: ${refusal}`);
      }
      const role = settings.chatRoleConfigs.find((candidate) => candidate.id === MAIN_SESSION_ROLE_ID);
      if (!role) {
        throw new Error(MAIN_SESSION_ROLE_MISSING_MESSAGE);
      }
      const repoPath = source.repoPath?.trim() || undefined;
      // Its access as it is (its CLI's mode and what it may read, edit, run
      // and reach), with the main session's own say over members: it makes
      // and asks them as its role gives.
      const base = normalizeParticipantPermissionsForRole(role, newChatMemberPermissions(Boolean(repoPath)), true);
      const { agentMode, permissions } = forkedMainSessionAccess(base, running);
      const [created] = await this.chat.creation.ensureMainSessionParticipant([], running.kind, {
        repoPath,
        requested: {
          handle: MAIN_SESSION_HANDLE,
          roleConfigId: MAIN_SESSION_ROLE_ID,
          kind: running.kind,
          model: running.model,
          reasoningEffort: running.reasoningEffort,
          hostId: running.hostId,
          agentMode,
          permissions,
          // Where the member runs: a fork never crosses devices.
          remoteExecution: preservedRemoteExecution(running.remoteExecution),
          homeMachineId: running.homeMachineId,
          cloudRun: running.cloudRun
        }
      });
      if (!created) {
        throw new Error("Could not make the new chat.");
      }
      const mainSession: ChatParticipant = { ...created, forkOrigin: forkOriginFor(source, member, seen) };
      signal?.throwIfAborted();
      const now = new Date().toISOString();
      conversation = {
        id: randomUUID(),
        title: forkedChatTitle(source.title),
        kind: "chat",
        createdAt: now,
        updatedAt: now,
        repoPath,
        messages: [
          createChatMessage("system", chatIntro([mainSession]), undefined, {
            threadId: "system"
          })
        ],
        findings: [],
        metadata: {
          participants: [mainSession],
          participantSessions: [],
          warnings: [],
          running: false,
          mainSessionParticipantId: mainSession.id,
          chatView: DEFAULT_CHAT_VIEW,
          // A new chat: every ready CLI, no changes of its own yet.
          subagentProviders: { entries: [] }
        }
      };
      rebuildLastMessagesByParticipant(conversation);
      const logPayload = {
        ...chatCreateLogPayload(conversation),
        sourceConversationId: source.id,
        sourceParticipantId: member.id,
        homeMachineId: mainSession.homeMachineId
      };
      stage = "saving";
      await this.deps.debugLogs.write("chat.create.save-started", logPayload).catch(() => undefined);
      signal?.throwIfAborted();
      await this.chat.store.saveConversation(conversation);
      stage = "saved";
      await this.deps.debugLogs.write("chat.fork-to-new-chat.saved", logPayload).catch(() => undefined);
      return { conversation, warnings: [] };
    } catch (error) {
      await this.deps.debugLogs.write("chat.fork-to-new-chat.failed", {
        conversationId: conversation?.id,
        stage,
        sourceConversationId: forkOf.conversationId,
        sourceParticipantId: forkOf.participantId,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The CLI readiness a fork is judged by: only what its main session will
   * run on. A member on this computer needs its own CLI here (its fresh
   * result reused, else that CLI alone checked); a member on a machine runs
   * on that machine's CLI, and Antigravity or a member with no place to run
   * is refused without any (forkToNewChatUnavailableReason). So Fork opens at
   * once instead of waiting for every CLI's check.
   */
  private async forkReadiness(running: ChatParticipant): Promise<AgentHealth[]> {
    if (chatParticipantHome(running).kind !== "this-machine" || !isForkableSessionKind(running.kind)) {
      return [];
    }
    return this.chat.agentEnvironment.detectAgentsForReadiness("submit", [running.kind]);
  }

  /** The member's last reply that ended a turn of its CLI in its chat, read
   *  as her server reads it for the phone (StorageService.
   *  conversationLastTurnEnd); the newest messages held when that read
   *  fails. */
  private async forkSeenReply(source: Conversation, participantId: string): Promise<ChatForkSeenReply | undefined> {
    if (typeof this.deps.storage.conversationLastTurnEnd === "function") {
      try {
        return await this.deps.storage.conversationLastTurnEnd(source.id, participantId);
      } catch (error) {
        void this.deps.debugLogs.write("chat.fork-to-new-chat.seen-read-failed", {
          sourceConversationId: source.id,
          sourceParticipantId: participantId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return lastMemberTurnEnd(source.messages, participantId);
  }

  /**
   * The chat a member is forked from, without reading all of its messages
   * (a chat can be thousands of them): its metadata (members, their session
   * records, the pointers to their last messages) and its newest messages,
   * as saved. Nothing in it is changed.
   */
  private async forkSourceChat(conversationId: string): Promise<Conversation> {
    if (this.chat.deletion.deletedConversationIds.has(conversationId) || await this.deps.storage.conversationTombstones?.().isDeleted(conversationId)) {
      throw new Error("Chat was permanently deleted.");
    }
    const conversation = typeof this.deps.storage.openConversation === "function"
      ? (await this.deps.storage.openConversation(conversationId, FORK_SOURCE_MESSAGES))?.conversation
      : await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      throw new Error("Chat conversation was not found.");
    }
    return conversation;
  }

  /** Why the main session's CLI session cannot be copied for this member, or
   *  undefined when it can: only by the same CLI (Claude Code or Codex; not
   *  Antigravity, which has no fork), through the same provider, on the same
   *  device, from a session that has an id. */
  forkUnavailableReason(
    caller: ChatParticipant,
    callerSession: ChatParticipantSession | undefined,
    kind: ChatProviderKind,
    hostId: string | undefined
  ): string | undefined {
    const ownLabel = cliProviderMetadata(caller.kind).label;
    if (caller.kind === "gemini-cli") {
      return "Antigravity has no session fork. Start a clean member and put what it needs from this conversation into the task.";
    }
    if (kind !== caller.kind) {
      return `A fork copies your own ${ownLabel} session, so it cannot run on ${cliProviderMetadata(kind).label}. Start a clean member and put what it needs from this conversation into the task.`;
    }
    if ((hostId ?? undefined) !== (caller.hostId ?? undefined)) {
      return "A fork copies your own session, so it runs through your own provider. Start a clean member and put what it needs from this conversation into the task.";
    }
    if (!this.chat.host.ownsParticipant(caller)) {
      return "Your session is on another machine. Start a clean member and put what it needs from this conversation into the task.";
    }
    if (!callerSession?.sessionId?.trim()) {
      return "Your CLI session has no id yet to copy. Start a clean member and put what it needs from this conversation into the task.";
    }
    return undefined;
  }

  /** A fork already holds what its source's session had seen: its chat
   *  context starts where the source's does (the turn the source is running
   *  included), not at the start of the chat. */
  copyPromptContextPointersForFork(conversation: Conversation, sourceId: string, forkId: string): void {
    const pointers = normalizedPromptContextPointers(conversation.metadata.promptContextPointers);
    const source = pointers[sourceId];
    if (source) {
      pointers[forkId] = JSON.parse(JSON.stringify(source)) as ChatPromptContextParticipantPointers;
    }
    const timeline: ChatPromptContextScope = { type: "timeline" };
    const inFlight = this.chat.promptContext.inFlightPromptContextFloor(inFlightPromptContextKey(conversation.id, sourceId, timeline));
    const committed = pointers[forkId] ? promptContextPointerForScope(pointers[forkId], timeline) : undefined;
    if (inFlight && !promptContextPointerAtOrAfter(committed, inFlight)) {
      setPromptContextPointerForScope(pointers, forkId, timeline, inFlight);
    }
    if (pointers[forkId]) {
      conversation.metadata = { ...conversation.metadata, promptContextPointers: pointers };
    }
  }

  /**
   * A chat's main session made by Fork to new chat (participant.forkOrigin)
   * starts from a copy of the member it was forked from: this device runs it,
   * so it holds that member's session (a fork never crosses devices), read
   * from the member's own chat here. Only while the main session has no
   * session here and never answered in this chat, so a session it loses later
   * (a move) never becomes a copy again; the record is kept at once, so a
   * first turn cut short still forks at the next. When the member's session
   * is not here (its chat deleted, the member moved), the main session starts
   * clean and this returns the chat's line about it (said when its turn
   * runs, so a compaction asked first does not say it).
   */
  async startFromForkOrigin(conversation: Conversation, participant: ChatParticipant, session: ChatParticipantSession): Promise<string | undefined> {
    const origin = participant.forkOrigin;
    if (!origin || origin.conversationId === conversation.id || !isMainSessionParticipant(conversation.metadata, participant.id)) {
      return undefined;
    }
    if (participantHasAnswered(conversation, participant.id)) {
      return undefined;
    }
    const forkable = origin.kind === participant.kind && (participant.kind === "claude-code" || participant.kind === "codex-cli");
    let read = await this.forkOriginSessionId(origin);
    // A member that moved here whose session still waits on her server (a
    // move hands it over at the member's next turn): taken now, as that
    // turn would take it, so the copy starts from it.
    if (!read.sessionId && forkable && await this.takeForkOriginHandoff(origin)) {
      read = await this.forkOriginSessionId(origin);
    }
    const sessionId = read.sessionId;
    const sourceSessions = read.sessions;
    if (!sessionId || !forkable) {
      void this.deps.debugLogs.write("chat.session.fork-to-new-chat.source-missing", {
        conversationId: conversation.id,
        participantId: participant.id,
        sourceConversationId: origin.conversationId,
        sourceParticipantId: origin.participantId,
        sourceChatHere: Boolean(sourceSessions),
        forkable
      });
      // Read on every device (a line in the chat): the place is named, not "this".
      const place = this.chat.host.machineRuntime ? `the cloud machine @${participant.handle} runs on` : "your computer";
      const label = (kind: ChatProviderKind): string => cliProviderMetadata(kind).label;
      const why = origin.kind !== participant.kind
        ? `@${participant.handle} now runs on ${label(participant.kind)}, not ${label(origin.kind)}`
        : !forkable ? `${label(participant.kind)} has no session fork` : `that session is not on ${place}`;
      return `@${participant.handle} could not start from a copy of ${forkOriginSessionName(origin)}: ${why}, so it starts a clean session.`;
    }
    // The copy ends with the turn of the reply the User saw last, at the
    // point that reply recorded in this session, or by its finish.
    const cut = forkCutFor(origin.seen, sessionId);
    session.forkFrom = { participantId: origin.participantId, sessionId, kind: origin.kind, conversationId: origin.conversationId, cut };
    session.forkedFromParticipantId = origin.participantId;
    void this.deps.debugLogs.write("chat.session.fork-to-new-chat", {
      conversationId: conversation.id,
      participantId: participant.id,
      sourceConversationId: origin.conversationId,
      sourceParticipantId: origin.participantId,
      cut: cut.at ? "recorded" : cut.finishedBy ? "by-time" : "none",
      ...(cut.unknown ? { cutUnknown: cut.unknown } : {})
    });
    void this.chat.store.withChatMutation(conversation, async () => {
      if (chatSessions(conversation).some((item) => item.participantId === participant.id)) return;
      upsertSession(conversation, session);
      this.chat.store.queueSnapshot(conversation);
    }).catch((error) => {
      void this.deps.debugLogs.write("chat.session.persist-failed", {
        conversationId: conversation.id,
        participantId: participant.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return undefined;
  }

  /** The CLI session id of the member a forked main session copies, from
   *  the session records of the member's chat on this device (only those:
   *  that chat can be long); `sessions` is undefined when the chat is not
   *  here. */
  private async forkOriginSessionId(origin: ChatParticipantForkOrigin): Promise<{ sessionId?: string; sessions?: unknown[] }> {
    const sessions: unknown[] | undefined = this.deps.storage.conversationParticipantSessions
      ? await this.deps.storage.conversationParticipantSessions(origin.conversationId).catch(() => undefined)
      : await this.deps.storage.getConversation(origin.conversationId)
        .then((source) => source?.kind === "chat" ? chatSessions(source) : undefined)
        .catch(() => undefined);
    const record = (sessions ?? []).find((item): item is ChatParticipantSession =>
      Boolean(item) && typeof item === "object" && (item as { participantId?: unknown }).participantId === origin.participantId);
    const sessionId = typeof record?.sessionId === "string" && record.sessionId.trim() ? record.sessionId.trim() : undefined;
    return { ...(sessionId ? { sessionId } : {}), ...(sessions ? { sessions } : {}) };
  }

  /** The member a forked main session copies moved to this device and its
   *  session waits here on her server: taken (takeSessionHandoff, the same
   *  step its own next turn takes). True when there was one to take. */
  private async takeForkOriginHandoff(origin: ChatParticipantForkOrigin): Promise<boolean> {
    const listed: unknown = typeof this.deps.storage.conversationAccess === "function"
      ? (await this.deps.storage.conversationAccess(origin.conversationId).catch(() => undefined))?.participants
      : (await this.deps.storage.getConversation(origin.conversationId).catch(() => undefined))?.metadata.participants;
    const participants: unknown[] = Array.isArray(listed) ? listed : [];
    const member = participants.find((item): item is ChatParticipant =>
      Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === origin.participantId);
    if (!member?.sessionHandoff || !this.chat.host.runsHere(member)) return false;
    const source = await this.chat.store.requireChat(origin.conversationId).catch(() => undefined);
    if (!source) return false;
    await this.chat.memberMoves.takeSessionHandoff(source, member).catch((error: unknown) => {
      void this.deps.debugLogs.write("chat.session.fork-to-new-chat.handoff-failed", {
        sourceConversationId: origin.conversationId,
        sourceParticipantId: origin.participantId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }

  /** Where a fork's copy ends, for the CLI (Fork to new chat): the point its
   *  reply recorded (and the session it is in), or the reply's finish; none
   *  for a delegated fork. When no point can be named, or the CLI cannot
   *  stop there, a line in the chat says so before the turn's reply (it may
   *  last hours, and the app may stop during it): Codex once its copy is
   *  made, Claude Code once it has read the member's transcript. A source
   *  that is gone gets no copy and no such line. */
  forkCutRunOption(
    conversation: Conversation,
    participant: ChatParticipant,
    forkSource: ChatSessionForkSource
  ): { forkCut?: { at?: string; sessionId?: string; finishedBy?: string; unknown?: string }; onForkCutMissed?: (reason: string) => void } {
    const cut = forkSource.cut;
    if (!cut) return {};
    const note = (reason: string): void => {
      const text = forkCutNoteText(participant, reason);
      if (text) this.postForkNotice(conversation, participant, "cut-missed", text);
    };
    // No point to give the CLI: it copies the whole session and says why
    // once it knows there is a copy to make.
    if (cut.unknown) return { forkCut: { unknown: cut.unknown }, onForkCutMissed: note };
    const forkCut = cut.at
      ? { at: cut.at, ...(cut.sessionId ? { sessionId: cut.sessionId } : {}) }
      : cut.finishedBy ? { finishedBy: cut.finishedBy } : undefined;
    return forkCut ? { forkCut, onForkCutMissed: note } : {};
  }

  /** The chat's word when a forked main session's copy holds the member's
   *  whole session although it was to end with the reply the User saw last:
   *  only once the copy was made (not when it started clean instead). */
  forkCutMissedNote(
    participant: ChatParticipant,
    forkSource: ChatSessionForkSource,
    session: ChatParticipantSession,
    result: Pick<ParticipantRunResult, "forkCutMissed" | "error">
  ): string | undefined {
    const origin = participant.forkOrigin;
    // Said at once through onForkCutMissed; this is the safety net for a
    // runner that only reported it with the turn (the line is written once).
    const reason = result.forkCutMissed;
    // The copy has its own id now, and it is not a fork that could not read
    // its source (that one is made again, or starts clean, and says so).
    const copied = Boolean(session.sessionId?.trim()) && session.sessionId !== forkSource.sessionId && !session.forkFrom &&
      !isForkSourceMissingError(result.error);
    if (!origin || !forkSource.cut || !reason || !copied) return undefined;
    void this.deps.debugLogs.write("chat.session.fork-to-new-chat.cut-missed", {
      participantId: participant.id,
      sourceConversationId: origin.conversationId,
      sourceParticipantId: origin.participantId,
      reason
    });
    return forkCutNoteText(participant, reason);
  }

  /**
   * What a fork says about its copy (Fork to new chat, a delegated fork):
   * a line in the chat, which goes to her server with the chat, so a fork
   * run on a cloud machine or asked from the phone has it on every device;
   * and, as before, a chat warning on the device that ran it. Both, because
   * the chat's timeline does not show a system line on any device yet: the
   * warning is what the User sees on the device that ran the fork until the
   * line has a look of its own. Once per member and kind (the line's id says
   * which; her server refuses a second line with it), so a turn run again
   * after a restart or handed over again says nothing more. The warning is
   * kept in this copy of the chat at once, as it was, and saved with the
   * next save even when the line's own write fails.
   */
  postForkNotice(conversation: Conversation, participant: ChatParticipant, kind: ForkNoticeKind, text: string): void {
    addConversationWarning(conversation, text);
    const id = forkNoticeMessageId(participant.id, kind);
    void this.chat.store.withChatMutation(conversation, async () => {
      addConversationWarning(conversation, text);
      if (!conversation.messages.some((message) => message.id === id)) {
        conversation.messages.push({ ...createChatMessage("system", text, undefined, { threadId: "system" }), id });
      }
      this.chat.store.queueSnapshot(conversation);
    }).catch((error) => {
      void this.deps.debugLogs.write("chat.fork-notice.persist-failed", {
        conversationId: conversation.id,
        participantId: participant.id,
        kind,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}
