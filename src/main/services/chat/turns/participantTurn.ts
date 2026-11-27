import { applyChatAccessOptionById } from "../../../../shared/chatAccessModes";
import path from "node:path";
import { memberMovedNote } from "../../../../shared/memberSessionMove";
import type {
  ChatAgentPermissions, ChatMessage, ChatExecutionLeaseMetadata, ChatParticipant, ChatPendingMention, Conversation
} from "../../../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { parseNativeGoalCommand } from "../../../../shared/nativeGoalCommand";
import { chatParticipantHome, chatParticipantHomeUnassignedMessage } from "../../../../shared/chatParticipantHome";
import { claudeCodePermissionMode, isForkSourceMissingError, type ClaudePermissionMode, type CliAgentReplyStart } from "../../cliAgents";
import type { ParticipantRunResult } from "../../providers";
import { MEMORY_PICKS_OFF_MS, memoryAccessNow, memoryIndex, memoryPicks } from "../../memoryTools";
import { NativeProcessUnavailableError } from "../../nativeProcess";
import { consumeOneTimePermissionApprovals, oneTimePermissionApprovalsForParticipant } from "../approvals/permissionGrants";
import { pendingChoiceFromAgentReply } from "../choices/choiceRecords";
import { updateParticipantContextUsage } from "../compaction/contextUsage";
import { CHAT_WARM_AGENT_IDLE_TIMEOUT_MS, INSTRUCTIONS_ACCESS_RESTATE } from "../constants";
import { missingRunFolderText, startFailedOnMissingPath } from "../host/runFolders";
import {
  claudeMemberMode, cliParticipantWithHost, lockParticipantRoleVersion, participantForRun, upsertSession
} from "../members/identity";
import {
  agentModeForSession, appMcpClientGenerationIdFor, cliParticipantForSession, memoryIndexKey, participantTurnMode,
  runPathForParticipant, warmAgentContextKey
} from "../members/roleRuntime";
import { closedByQuit, INTERRUPTED_REPLY_TEXT, markStoppedByQuit } from "../runs/interruptions";
import {
  forkCopyFailed, forkedMemberIdentityNote, forkStartedCleanIdentityNote, forkStartedCleanNotice, importedMainSessionNote, otherChatForkOrigin,
  recordReplySessionCut
} from "../sessions/forkNotes";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { createChatMessage } from "../store/messages";
import {
  commitPromptContextPointerAdvance, forgetPromptContextPointers, promptContextScopeForTrigger, waitForEarlierClaudeMessages
} from "./promptContextRecords";
import {
  appMcpToolInventoryKeyFor, appMcpToolNamesFor, appToolCapabilitiesForRun, newMessageNonce, preauthorizedAppMcpToolNamesFor
} from "./promptSections";
import {
  cliStartedReplyStart, emitProgress, markParticipantMessageSentNow, markParticipantMessageStoppedByUser, markParticipantMessageStopUnconfirmed,
  processingTranscriptWithTerminalMessage, withCliStartedReplyStart
} from "./replyMessages";
import { takenBackMark } from "./takenBackMessages";
import type { ClaudeWriteGate } from "./types";
import type { ChatAppMcpTokenGrant, ChatMemberAccess, ChatPromptContextScope, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

function mobileEventIdFromChatTrigger(triggerMessage: ChatMessage): string | undefined {
  if (triggerMessage.metadata?.appMessageSource !== "mobile-relay") {
    return undefined;
  }
  const id = triggerMessage.metadata?.mobileEventId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** One turn of a member that runs here, from its prompt to its saved reply. */
export class ParticipantTurn {
  /** Move notes a running turn of the member carries (memberMovedNote). */
  private readonly moveNotesInFlight = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "accord" | "activeRuns" | "agentEnvironment" | "appMcpGrants" | "appQuit" | "approvalDecisions" | "attachments" | "backgroundTasks"
      | "chatHistory" | "choiceExpiry" | "claudeModes" | "codexApprovals" | "executorLeases" | "forks" | "host"
      | "memberSessions" | "pendingReplies" | "permissionRequests" | "promptContext" | "promptSuggestions" | "scheduledTasks"
      | "selfCompactionResumes" | "selfResumedTurns" | "store" | "turnPrompt"
    >,
    private readonly deps: Pick<ChatDependencies, "appMcp" | "cliRunner" | "debugLogs">
  ) {}

  async runParticipantTurn(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: {
      continuation?: boolean;
      warnings: string[];
      promptConversation?: Conversation;
      workspacePath?: string;
      promptContextScope?: ChatPromptContextScope;
      /** Messages outside the scope this turn reads too (preparePromptContextForRun). */
      extraPromptContextMessageIds?: readonly string[];
      participantRequestDepth?: number;
      participantRequestBatchId?: string;
      chainRootId?: string;
      turnSegmentId: string;
      queuedBehindHandle?: string;
      existingPendingMessage?: ChatMessage;
      writeGate?: ClaudeWriteGate;
      /** Its message waits in the member's CLI behind the running step
       *  (ParticipantTurnReservation.behindMemberTurn): the reply stays
       *  queued until the CLI starts it. */
      queuedInCli?: boolean;
      /** Its message is in the member's Claude Code CLI (a request delivered
       *  now gets the CLI's send-now from here). */
      onCliMessageWritten?: () => void;
      /** A request delivered now to a Codex member: steered into its running
       *  turn (CliAgentRunOptions.steerIntoRunningTurn). */
      steerIntoRunningTurn?: (outcome: "steered" | "not-steered") => void;
    }
  ): Promise<ChatMessage[]> {
    this.chat.host.assertOwnsParticipant(participant);
    const sessionState = await this.chat.memberSessions.sessionForParticipant(conversation, participant);
    const session = sessionState.session;
    const sourcePromptConversation = options.promptConversation ?? conversation;
    const nativeGoal = triggerMessage.role === "user" && triggerMessage.metadata?.nativeCommand?.name === "goal"
      ? triggerMessage.metadata.nativeCommand
      : undefined;
    const parsedTrigger = nativeGoal ? parseNativeGoalCommand(triggerMessage.content) : { kind: "none" as const };
    const promptTriggerMessage = parsedTrigger.kind === "valid"
      ? { ...triggerMessage, content: parsedTrigger.contentWithoutCommand }
      : triggerMessage;
    const promptConversation = parsedTrigger.kind === "valid"
      ? {
          ...sourcePromptConversation,
          messages: sourcePromptConversation.messages.map((message) =>
            message.id === triggerMessage.id ? promptTriggerMessage : message
          )
        }
      : sourcePromptConversation;
    const workspacePath = options.workspacePath ?? await this.chat.chatHistory.ensureHistoryFiles(promptConversation);
    // A member made as a fork of another's session starts from a copy of it
    // (Claude Code and Codex only): the copy already holds the conversation,
    // so its first turn is prompted as a resumed one.
    const forkSource = !session.sessionId?.trim() && session.forkFrom?.sessionId && session.forkFrom.kind === participant.kind &&
      (participant.kind === "claude-code" || participant.kind === "codex-cli")
      ? session.forkFrom
      : undefined;
    const isResumingSession = Boolean(session.sessionId) || Boolean(forkSource);
    // An imported thread's session, not yet told it is this chat's main
    // session: told now, in full, as a new session would be at its start.
    const importNotTold = session.importIntroPending === true;
    // Members' memory: the list of notes goes with a session's first turn,
    // with instructions sent again, and after the context was compacted. It
    // is asked now, while the rest of the turn is prepared (it never fails).
    const memoryKey = memoryIndexKey(conversation.id, participant.id);
    // Picks off for a while (no key, the server not picking now): a session
    // told that notes come with each message gets the list instead.
    const memoryPicksOff = Date.now() < this.chat.memberSessions.memoryPicksOffUntil;
    const memoryIndexIsDue = !isResumingSession || importNotTold || sessionState.instructionsRefreshed || this.chat.memberSessions.memoryIndexDue.has(memoryKey) ||
      (memoryPicksOff && Boolean(session.memoryNotesPicked));
    const memoryActor = { conversationId: conversation.id, participantId: participant.id };
    const memoryIndexPending = memoryIndexIsDue
      ? memoryIndex(memoryAccessNow(this.chat.memberSessions.memoryAccess), memoryActor, undefined, !memoryPicksOff)
      : undefined;
    // The notes that fit this message, by meaning (only with the User's
    // OpenAI key; none for replies coming back). A note given earlier in the
    // session is not given again until it changes; a session told its list
    // anew starts over.
    if (memoryIndexIsDue) this.chat.memberSessions.memoryPicksShown.delete(memoryKey);
    const shownPicks = this.chat.memberSessions.memoryPicksShown.get(memoryKey);
    const memoryPicksPending = options.continuation || memoryPicksOff ? undefined : memoryPicks(
      memoryAccessNow(this.chat.memberSessions.memoryAccess), memoryActor, promptTriggerMessage.content,
      [...(shownPicks ?? new Map<string, number>())].map(([id, version]) => ({ id, version }))
    );
    // A Claude Code member may take this message while an earlier one is
    // still waiting in its CLI; context counts as delivered only once the CLI
    // has handed that message to a step (onReplyStarted below).
    const sharedClaudeTurn = participantTurnMode(participant, triggerMessage) === "shared";
    // One nonce for everything this message carries (buildPromptParts).
    const turnNonce = newMessageNonce();
    const preparedPromptContext = await this.chat.promptContext.preparePromptContextForRun(
      conversation,
      promptConversation,
      participant,
      promptTriggerMessage,
      options.promptContextScope ?? promptContextScopeForTrigger(promptTriggerMessage),
      isResumingSession,
      sharedClaudeTurn ? undefined : runId,
      options.extraPromptContextMessageIds,
      turnNonce
    );
    const agentMode = agentModeForSession(session, participant);
    // A once-only approval is used by one turn: one that another turn of the
    // member still running has already applied is not applied again.
    const oneTimePermissionApprovals = oneTimePermissionApprovalsForParticipant(conversation, participant)
      .filter((approval) => !this.chat.permissionRequests.oneTimeApprovalClaimedByOtherRun(approval.id, runId));
    const appliedOneTimePermissionApprovalIds: string[] = [];
    const granted = this.chat.permissionRequests.participantPermissionsForRun(
      conversation,
      participant,
      oneTimePermissionApprovals,
      appliedOneTimePermissionApprovalIds
    );
    // Told only while the User's switch is on (createsScheduledTasksWithoutCard).
    const permissions = await this.chat.scheduledTasks.withSchedulingWhileOn(granted);
    for (const approvalId of appliedOneTimePermissionApprovalIds) {
      this.chat.permissionRequests.oneTimeApprovalClaims.set(approvalId, runId);
    }
    session.participantPermissions = normalizeChatAgentPermissions(permissions);
    // Claude Code's own modes: the mode the member is in as this turn read it,
    // and the mode this turn runs. A once-only grant of file edits ("Allow
    // once") is no mode of the session, which overlapping turns of the member
    // share (its live process): it lets this run's next file edit through,
    // once, when Claude Code asks for it, as "Yes, allow once" does in the CLI
    // (claudeOnceEditGrants, requestToolPermissionFromTool).
    const claudeModeRead = claudeMemberMode(conversation, participant);
    const ownModeBase = claudeModeRead ? normalizeChatAgentPermissions(participantForRun(conversation, participant).permissions) : undefined;
    const onceEditGrant = Boolean(ownModeBase && !ownModeBase.workspaceWrite && permissions.workspaceWrite);
    const cliPermissions: ChatAgentPermissions = onceEditGrant ? { ...permissions, workspaceWrite: false } : permissions;
    const claudeModeForTurn = claudeModeRead ? claudeCodePermissionMode(agentMode, cliPermissions) : undefined;
    // Nothing saved this chat since the app started: what this turn read is
    // the saved mode a later change is told apart from.
    if (claudeModeRead && !this.chat.claudeModes.savedClaudeMemberModes.has(`${conversation.id}:${participant.id}`)) {
      this.chat.claudeModes.savedClaudeMemberModes.set(`${conversation.id}:${participant.id}`, claudeModeRead);
    }
    const usePromptRole = session.roleRuntime === "prompt-fallback";
    const includeRefreshedRoleInstructions = isResumingSession && sessionState.instructionsRefreshed;
    const primaryIncludeRoleInstructions = (usePromptRole && !isResumingSession) || includeRefreshedRoleInstructions || importNotTold;
    let memoryIndexResult = await memoryIndexPending;
    const memoryPicksResult = await memoryPicksPending;
    // Told (now or before) that notes come with each message, and the server
    // said it picks none now: the list, in this turn.
    if (memoryPicksResult?.off && memoryPicksResult.answered && (memoryIndexResult ? memoryIndexResult.picks : session.memoryNotesPicked)) {
      memoryIndexResult = await memoryIndex(memoryAccessNow(this.chat.memberSessions.memoryAccess), memoryActor, undefined, false);
    }
    if (memoryPicksResult?.off) this.chat.memberSessions.memoryPicksOffUntil = Date.now() + MEMORY_PICKS_OFF_MS;
    if (memoryPicksResult?.notes.length) {
      const shown = this.chat.memberSessions.memoryPicksShown.get(memoryKey) ?? new Map<string, number>();
      for (const note of memoryPicksResult.notes) shown.set(note.id, note.version);
      this.chat.memberSessions.memoryPicksShown.set(memoryKey, shown);
    }
    const memoryIndexBlock = [memoryIndexResult?.text, memoryPicksResult?.text].filter(Boolean).join("\n\n") || undefined;
    // Shown again after a compaction until the server's list was given.
    if (memoryIndexResult?.delivered) {
      this.chat.memberSessions.memoryIndexDue.delete(memoryKey);
      if (memoryIndexResult.picks) session.memoryNotesPicked = true;
      else delete session.memoryNotesPicked;
    }
    // Told that notes come with each message, and the server did not answer
    // for picks: the list goes with the next turn (it waits for nobody now).
    if (memoryPicksResult?.off && session.memoryNotesPicked) this.chat.memberSessions.memoryIndexDue.add(memoryKey);
    // It moved here with its session: told once where it is now (until a
    // turn of it succeeded, below).
    const moveNoteKey = session.movedHere ? `${conversation.id}:${participant.id}:${session.movedHere.at}` : undefined;
    // A turn that overlaps one already carrying the note does not carry it too.
    const moveNoteBlock = session.movedHere && moveNoteKey && !this.moveNotesInFlight.has(moveNoteKey)
      ? memberMovedNote(session.movedHere, runPathForParticipant(conversation, participant, workspacePath, agentMode, permissions), process.platform)
      : undefined;
    const carriedMoveNote = moveNoteBlock && moveNoteKey ? moveNoteKey : undefined;
    if (carriedMoveNote) this.moveNotesInFlight.add(carriedMoveNote);
    // A fork's copy holds its source's instructions: who it is and its own
    // access are said with its messages until a turn of it succeeded (its
    // first one may fail after the copy was made: the copy's id is reported
    // before the turn runs).
    const forkNotTold = Boolean(forkSource) || (Boolean(session.forkedFromParticipantId) && !session.instructionsAccessHash);
    const identityNoteBlock = forkedMemberIdentityNote(conversation, participant, session, forkNotTold)
      ?? (importNotTold ? importedMainSessionNote(participant) : undefined);
    const access: ChatMemberAccess = { agentMode, permissions };
    // Compacted since its access was last said (accessRestateDue; after a
    // restart, as its session keeps it): said again in full. A new session
    // starts from its launch's text, which holds its access now.
    const restateKey = memoryIndexKey(conversation.id, participant.id);
    if (session.instructionsAccessHash === INSTRUCTIONS_ACCESS_RESTATE) this.chat.memberSessions.accessRestateDue.add(restateKey);
    const restateDue = isResumingSession && this.chat.memberSessions.accessRestateDue.has(restateKey);
    const carriesCurrentAccess = restateDue || !isResumingSession || importNotTold;
    const accessNote = forkNotTold || restateDue
      ? `Your access: ${this.chat.turnPrompt.participantDynamicHeader(conversation, participant, session, access)}`
      : isResumingSession ? this.chat.memberSessions.accessChangedNote(conversation, participant, session, access) : undefined;
    // The message's pictures, as the CLI's own image input.
    const turnImages = await this.chat.attachments.turnImagesForCli(conversation.id, promptTriggerMessage, participant.kind, turnNonce);
    const imageOptions = { unavailableImagesNote: turnImages.unavailableNote, picturesNote: turnImages.picturesNote, imageCount: turnImages.images?.items.length ?? 0 };
    const primary = this.chat.turnPrompt.buildPromptParts(promptConversation, participant, session, promptTriggerMessage, workspacePath, Boolean(options.continuation), {
      includeRoleInstructions: primaryIncludeRoleInstructions,
      turnNonce,
      agentMode,
      permissions,
      promptContextBlock: preparedPromptContext.block,
      memoryIndexBlock,
      moveNoteBlock,
      identityNoteBlock,
      accessNote,
      ...imageOptions
    });
    const prompt = primary.prompt;
    const promptFallbackPrompt = this.chat.turnPrompt.buildPrompt(promptConversation, participant, session, promptTriggerMessage, workspacePath, Boolean(options.continuation), {
      includeRoleInstructions: true,
      turnNonce,
      agentMode,
      permissions,
      promptContextBlock: preparedPromptContext.block,
      memoryIndexBlock,
      moveNoteBlock,
      ...imageOptions
    });
    // A fork whose source session is gone starts clean from this prompt
    // (the CLI's resume-miss fallback): it is still told who it is, with its
    // role's instructions, as the fork would have been.
    const resumeFallbackPrompt = isResumingSession
      ? this.chat.turnPrompt.buildPrompt(promptConversation, participant, session, promptTriggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: usePromptRole || includeRefreshedRoleInstructions || Boolean(forkSource),
          turnNonce,
          agentMode,
          permissions,
          promptContextBlock: preparedPromptContext.resumeFallbackBlock,
          memoryIndexBlock,
          moveNoteBlock,
          ...imageOptions,
          ...(forkSource ? { identityNoteBlock: forkStartedCleanIdentityNote(conversation, participant, session) } : {})
        })
      : undefined;
    const role = usePromptRole ? undefined : this.chat.agentEnvironment.cliRoleOptions(conversation, participant, session, access, workspacePath, promptFallbackPrompt);
    void this.deps.debugLogs.write("chat.prompt.size", {
      conversationId: conversation.id,
      participantId: participant.id,
      participantHandle: participant.handle,
      runId,
      includeRoleInstructions: primaryIncludeRoleInstructions,
      resuming: isResumingSession,
      instructionsRefreshed: sessionState.instructionsRefreshed,
      sections: primary.sections,
      promptFallbackSize: promptFallbackPrompt.length,
      resumeFallbackSize: resumeFallbackPrompt?.length ?? 0,
      roleInstructionsSize: role?.instructions.length ?? 0
    });
    const runPath = runPathForParticipant(conversation, participant, workspacePath, agentMode, permissions);
    let cliParticipant = cliParticipantForSession(participant, session);
    let pendingMessage: ChatMessage;
    if (options.existingPendingMessage) {
      pendingMessage = await this.chat.pendingReplies.prepareExistingPendingMessageForRun(
        conversation,
        options.existingPendingMessage,
        cliParticipant,
        triggerMessage,
        Boolean(options.continuation),
        {
          turnSegmentId: options.turnSegmentId,
          participantRequestDepth: options.participantRequestDepth ?? 0,
          participantRequestBatchId: options.participantRequestBatchId,
          chainRootId: options.chainRootId
        },
        { keepQueued: Boolean(options.queuedInCli) }
      );
    } else {
      pendingMessage = createChatMessage(
        "participant",
        "",
        cliParticipant,
        {
          threadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
          parentMessageId: triggerMessage.id,
          chatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
          sourceMessageId: triggerMessage.id,
          requesterParticipantId: options.continuation ? triggerMessage.participantId : undefined,
          approvedContinuation: options.continuation || undefined,
          runId,
          turnSegmentId: options.turnSegmentId,
          participantRequestDepth: options.participantRequestDepth ?? 0,
          participantRequestBatchId: options.participantRequestBatchId,
          participantRequestChainRootId: options.chainRootId,
          queuedBehind: options.queuedBehindHandle ? { handle: options.queuedBehindHandle } : undefined,
          turnQueued: options.queuedBehindHandle ? true : undefined
        },
        "pending"
      );
      this.chat.activeRuns.setTargetRunPendingMessageId(runId, pendingMessage.id);
      await this.chat.store.withChatMutation(conversation, async () => {
        this.chat.approvalDecisions.resolveSupersededParticipantInteractions(conversation, participant.id, pendingMessage.id);
        conversation.messages.push(pendingMessage);
        this.chat.choiceExpiry.noteChoiceExpiry(conversation);
        recordLastMessageByParticipant(conversation, pendingMessage);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
    }
    const progressSink = this.chat.pendingReplies.createAgentProgressSink(
      runId,
      progress,
      participant,
      pendingMessage.id,
      mobileEventIdFromChatTrigger(triggerMessage)
    );
    const unregisterRunProgressCallback = this.chat.activeRuns.registerRunProgressCallback(runId, progress);
    // `permissions.request` is force-added to every run's grant (independent of the
    // role's configured capabilities). The Default/Auto tool-permission bridge depends
    // on this: `requestToolPermissionFromTool` and the appMcp `app_tool_permission`
    // handler both gate on `permissions.request`, so if this force-add is ever removed
    // or scoped back to role config, native escalation silently denies every
    // un-pre-approved tool call. Keep it always-on (or give the bridge its own
    // capability) if you change this.
    const appToolCapabilities = appToolCapabilitiesForRun(conversation, participant, session, permissions, await this.chat.accord.accordFromAnySession());
    const appMcpToolNames = appMcpToolNamesFor(appToolCapabilities);
    const appMcpToolInventoryKey = appMcpToolInventoryKeyFor(appMcpToolNames);
    const appMcpClientGenerationId = appMcpClientGenerationIdFor(conversation, participant, session, appMcpToolInventoryKey);
    const appMcpGrant: ChatAppMcpTokenGrant = {
      conversationId: conversation.id,
      participantId: participant.id,
      roleConfigId: session.roleConfigId,
      roleConfigVersion: session.roleConfigVersion,
      capabilities: appToolCapabilities,
      clientGenerationId: appMcpClientGenerationId,
      expectedToolNames: appMcpToolNames,
      triggerMessageId: triggerMessage.id,
      triggerThreadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
      triggerParentMessageId: triggerMessage.metadata?.parentMessageId,
      triggerChatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
      snapshotMaxSequence: Math.max(0, promptConversation.messages.length - 1),
      continuation: Boolean(options.continuation),
      runId,
      turnSegmentId: options.turnSegmentId,
      agentMode,
      runPermissions: effectiveChatAgentPermissionsForProvider(participant.kind, agentMode, cliPermissions),
      participantRequestDepth: options.participantRequestDepth ?? 0,
      participantRequestBatchId: options.participantRequestBatchId,
      chainRootId: options.chainRootId,
      historyMarkdownPath: path.join(workspacePath, "history.md"),
      historyJsonPath: path.join(workspacePath, "history.json")
    };
    // A Claude Code member's warm process takes this message while it may
    // still be working on an earlier one (or on a step it started itself), and
    // the member has one app tool token. Its grant names the run and thread the
    // tools act for, so it moves to this run only when the CLI hands this
    // message to a step; until then the earlier work keeps acting for itself.
    const memberKey = `${conversation.id}:${participant.id}`;
    // Claude Code's own modes: the mode the member is in as its message goes
    // in. A mode she picked after this turn read the member is the one (it was
    // set in the live process already); else this turn's own.
    const claudeModeNow = claudeModeForTurn
      ? (): ClaudePermissionMode => {
          const saved = this.chat.claudeModes.savedClaudeMemberModes.get(memberKey);
          return saved !== undefined && saved !== claudeModeRead ? saved : claudeModeForTurn;
        }
      : undefined;
    // The grant goes by that mode too, when it is issued: issued at the reply's
    // start, it must not take back a mode set in the process since.
    const grantNow = (): ChatAppMcpTokenGrant => {
      const mode = claudeModeNow?.();
      if (!mode || mode === claudeModeForTurn) return appMcpGrant;
      const access = applyChatAccessOptionById("claude-code", mode, cliPermissions);
      return { ...appMcpGrant, agentMode: access.agentMode, runPermissions: effectiveChatAgentPermissionsForProvider(participant.kind, access.agentMode, access.permissions) };
    };
    const existingConnection = this.chat.appMcpGrants.appMcpTokens.has(memberKey) ? this.chat.appMcpGrants.appMcpConnections.get(memberKey) : undefined;
    const grantAtReplyStart = participant.kind === "claude-code" && !nativeGoal && Boolean(existingConnection);
    const grantThisRun = (): void => {
      const grant = grantNow();
      this.chat.appMcpGrants.issueAppMcpConnection(conversation, participant, grant);
      if (participant.kind === "claude-code") {
        this.chat.appMcpGrants.lastAppMcpGrants.set(memberKey, grant);
      }
    };
    const onReplyStarted = (start?: CliAgentReplyStart): void => {
      if (grantAtReplyStart) {
        grantThisRun();
      }
      if (sharedClaudeTurn && preparedPromptContext.pointerAdvance) {
        this.chat.promptContext.registerInFlightPromptContext(conversation.id, participant.id, preparedPromptContext.pointerAdvance, runId);
      }
      if (sharedClaudeTurn) {
        const started = cliStartedReplyStart(conversation, pendingMessage, start);
        if (started) {
          // The run's own copy too: its "Worked for …" is counted from it.
          pendingMessage.metadata = withCliStartedReplyStart(pendingMessage.metadata, started);
          void this.chat.pendingReplies.noteCliStartedReply(conversation, pendingMessage.id, started).catch((error: unknown) => {
            void this.deps.debugLogs.write("chat.cli-started-reply.error", {
              conversationId: conversation.id,
              participantId: participant.id,
              runId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
    };
    const firstGrant = grantAtReplyStart ? undefined : grantNow();
    const appMcp = grantAtReplyStart ? existingConnection : this.chat.appMcpGrants.issueAppMcpConnection(conversation, participant, firstGrant!);
    if (firstGrant && participant.kind === "claude-code") {
      this.chat.appMcpGrants.lastAppMcpGrants.set(memberKey, firstGrant);
    }
    emitProgress(runId, progress, "debate", `@${participant.handle} is responding.`, {
      participantLabel: `@${participant.handle}`,
      agentProgress: {
        participantId: participant.id,
        participantLabel: `@${participant.handle}`,
        state: "running",
        messageId: pendingMessage.id
      }
    });
    // Before the read: a change told while it is read still judges its process.
    const agentEnvGeneration = this.deps.cliRunner.environmentGeneration?.();
    const agentEnvironment = await this.chat.agentEnvironment.agentEnvironmentForParticipant(participant, cliParticipant.model);
    cliParticipant = cliParticipantWithHost(cliParticipant, agentEnvironment);
    // The last session id this turn's CLI reported (a fork's copy, or one
    // Claude Code was given before it made it).
    let reportedHere: string | undefined;
    const persistSessionId = (sessionId: string): void => {
      reportedHere = sessionId.trim() || reportedHere;
      this.chat.memberSessions.persistParticipantSessionId(conversation, session, sessionId);
    };
    let executionLease: ChatExecutionLeaseMetadata | undefined;
    try {
      // Held from here, inside the try its finally ends.
      if (onceEditGrant) this.chat.claudeModes.claudeOnceEditGrants.set(runId, appliedOneTimePermissionApprovalIds.slice());
      progressSink.beginAttempt();
      // A member whose home is a machine never reaches here: it is dispatched to
      // that machine before its turn is prepared. What can still arrive is a
      // member that was set to run on the cloud worker this app no longer has,
      // and it has no machine to run on until the User gives it one.
      const home = chatParticipantHome(participant);
      if (home.kind === "unassigned") {
        const message = chatParticipantHomeUnassignedMessage(participant.handle);
        pendingMessage.status = "error";
        pendingMessage.content = message;
        options.warnings.push(message);
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, runId, message, true);
        return [pendingMessage];
      }
      if (participant.hostId?.trim() && home.kind !== "this-machine") {
        // A machine runtime reads its own Settings; an added provider and its
        // key exist only on the computer that added them, so such a member is
        // refused there instead of failing as "provider removed".
        const message = `@${participant.handle} cannot start: members on an added provider (${participant.hostLabel ?? "provider"}) run on this computer only. Choose this computer as its machine in the member settings.`;
        pendingMessage.status = "error";
        pendingMessage.content = message;
        options.warnings.push(message);
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, runId, message, true);
        return [pendingMessage];
      }
      if (agentEnvironment.problem) {
        const message = `${agentEnvironment.problem}.`;
        await this.chat.agentEnvironment.closeWarmAgentsForParticipant(conversation.id, participant.id);
        pendingMessage.status = "error";
        pendingMessage.content = message;
        options.warnings.push(message);
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, runId, message, true);
        return [pendingMessage];
      }
      // A member's first turn here, on a provider perhaps chosen elsewhere (a
      // chat the phone made from an offer this computer published earlier):
      // the run still decides (readiness can be stale), and a first turn that
      // fails on a CLI that is not ready here says so (firstTurnProviderProblem).
      const firstTurnHere = !session.sessionId && !forkSource;
      executionLease = this.chat.executorLeases.acquireParticipantExecutorLease(conversation, participant, session, "desktop");
      pendingMessage.metadata = {
        ...pendingMessage.metadata,
        executionLease
      };
      if (options.writeGate) {
        await waitForEarlierClaudeMessages(options.writeGate, signal);
      }
      // A main session made by Fork to new chat whose member's session is
      // not here starts clean: the chat says so before the turn runs, as the
      // fork's other notices are said (postForkNotice).
      if (sessionState.forkOriginUnavailable) {
        this.chat.forks.postForkNotice(conversation, participant, "origin-unavailable", sessionState.forkOriginUnavailable);
      }
      // `clean`: a fork whose copy could not be made starts a session of its
      // own from the saved chat context, in this same turn (below).
      const runCli = (clean = false): Promise<ParticipantRunResult> => this.deps.cliRunner.run(cliParticipant, clean ? resumeFallbackPrompt ?? prompt : prompt, runPath, undefined, "chat", signal, {
        persistSession: true,
        ...(clean ? {} : {
          sessionId: session.sessionId,
          ...(forkSource ? { forkFromSessionId: forkSource.sessionId, ...this.chat.forks.forkCutRunOption(conversation, participant, forkSource) } : {})
        }),
        extraReadableDirs: [workspacePath],
        resumeFallbackPrompt,
        ...(importNotTold ? { resumeOnly: true } : {}),
        ...(turnImages.images ? { images: turnImages.images } : {}),
        role,
        appMcp: appMcp
          ? {
              ...appMcp,
              toolNames: appMcpToolNames,
              autoPreauthorizedToolNames: preauthorizedAppMcpToolNamesFor(appMcpToolNames),
              clientGenerationId: appMcpClientGenerationId,
              clientStatus: (clientGenerationId: string) => this.deps.appMcp?.clientStatus?.(clientGenerationId)
            }
          : undefined,
        agentEnv: agentEnvironment.env,
        settingsEnv: agentEnvironment.settingsEnv,
        agentEnvKey: agentEnvironment.version,
        agentEnvGeneration,
        agentMode,
        permissions: cliPermissions,
        nativeGoal,
        ...(options.steerIntoRunningTurn ? { steerIntoRunningTurn: options.steerIntoRunningTurn } : {}),
        onOutput: progressSink.emit,
        onSessionId: persistSessionId,
        onCodexServerRequest: (request) => this.chat.codexApprovals.requestCodexApprovalFromCli(
          conversation,
          participant,
          session,
          runId,
          triggerMessage.id,
          request
        ),
        warm: {
          conversationId: conversation.id,
          participantId: participant.id,
          contextKey: warmAgentContextKey(conversation, participant, session, runPath, workspacePath, permissions, appMcpToolInventoryKey),
          idleTimeoutMs: CHAT_WARM_AGENT_IDLE_TIMEOUT_MS,
          origin: {
            runId,
            messageId: pendingMessage.id,
            threadId: pendingMessage.metadata?.threadId,
            chatThreadRootId: pendingMessage.metadata?.chatThreadRootId
          },
          onSelfResumedTurn: (turn) => this.chat.selfResumedTurns.handleSelfResumedTurn(conversation.id, participant.id, turn),
          onBackgroundTasksChanged: (tasks, environmentPending) => this.chat.backgroundTasks.handleBackgroundTasksChanged(conversation.id, participant.id, tasks, environmentPending),
          onReplyStarted: grantAtReplyStart || sharedClaudeTurn ? onReplyStarted : undefined,
          onMessageWritten: options.writeGate || options.onCliMessageWritten
            ? () => {
                options.writeGate?.markWritten();
                options.onCliMessageWritten?.();
              }
            : undefined,
          onPromptSuggestion: (text) => this.chat.promptSuggestions.receiveMemberPromptSuggestion({
            conversationId: conversation.id,
            participantId: participant.id,
            runId,
            text
          }),
          permissionMode: claudeModeNow,
          // A mode the CLI moved to itself (a plan she approved): the
          // member's mode follows it.
          onCliPermissionMode: claudeModeForTurn
            ? (mode) => this.chat.claudeModes.followClaudeCliMode(conversation.id, participant.id, mode)
            : undefined
        }
      });
      let result = await runCli();
      if (!this.chat.host.machineRuntime) {
        this.chat.promptSuggestions.suggestions.replyEnded(conversation.id, participant.id, runId);
      }
      // A start that failed because the project folder is gone says so,
      // instead of the process error that reads as a missing CLI. Only the
      // project folder can go away under the member: the chat's own workspace
      // is created for every run.
      let missingRunFolderSaid = false;
      if (!result.ok && !signal?.aborted && runPath !== workspacePath && startFailedOnMissingPath(result)) {
        const missing = await this.chat.host.missingRunFolder(conversation, runPath);
        if (missing) {
          missingRunFolderSaid = true;
          result = { ...result, content: missingRunFolderText(participant.handle, missing), error: missing.reason };
          // The computer that made the copy forgets it when it reads this,
          // so the next message copies the project again.
          if (missing.copyOf && this.chat.host.hostMachineId) {
            pendingMessage.metadata = { ...pendingMessage.metadata, missingProjectCopy: { machineId: this.chat.host.hostMachineId, sourcePath: missing.copyOf } };
          }
        }
      }
      // The CLI could not make the copy: her message still gets its reply in
      // this turn. When the CLI says the source session is gone, the member
      // starts clean at once; any other failure of the copy is tried once
      // more first. Never a failure that is not the copy's (a project folder
      // gone, a Stop, a turn that failed after the copy was made).
      let forkStartedCleanThisTurn = false;
      if (forkSource && !missingRunFolderSaid && forkCopyFailed(result, signal)) {
        const sourceGone = isForkSourceMissingError(result.error);
        void this.deps.debugLogs.write("chat.session.fork-failed", {
          conversationId: conversation.id,
          participantId: participant.id,
          sourceParticipantId: forkSource.participantId,
          sourceGone,
          error: result.error
        });
        // The id this turn's CLI was given (or reported) is no session; one
        // another turn of the member made meanwhile stays.
        const forgetOwnId = (): void => {
          if (session.sessionId === reportedHere) session.sessionId = "";
        };
        // Two messages sent at once share the member's first turn: the other
        // one may have made its session (the copy, or a clean one) meanwhile.
        const madeMeanwhile = (): boolean => Boolean(session.sessionId?.trim()) && !session.forkFrom && session.sessionId !== forkSource.sessionId;
        forgetOwnId();
        if (!sourceGone && !madeMeanwhile()) {
          progressSink.beginAttempt();
          result = await runCli();
          if (forkCopyFailed(result, signal)) forgetOwnId();
        }
        if (forkCopyFailed(result, signal) && madeMeanwhile()) {
          // This message goes into the session the other one made.
          progressSink.beginAttempt();
          result = await runCli();
        } else if (forkCopyFailed(result, signal)) {
          // The retry may be the one that says the source is gone.
          const gone = sourceGone || isForkSourceMissingError(result.error);
          const copyFailure = result;
          const forkedFromParticipantId = session.forkedFromParticipantId;
          delete session.forkFrom;
          delete session.forkedFromParticipantId;
          forkStartedCleanThisTurn = true;
          void this.deps.debugLogs.write("chat.session.fork-starts-clean", {
            conversationId: conversation.id,
            participantId: participant.id,
            sourceParticipantId: forkSource.participantId,
            sourceGone: gone
          });
          // Said before the clean turn runs (it may last hours, and the app
          // may stop during it) when the CLI said the copy cannot be made.
          if (gone) this.chat.forks.postForkNotice(conversation, participant, "started-clean", forkStartedCleanNotice(conversation, participant, forkSource, "turn"));
          const reportedBeforeClean = reportedHere;
          progressSink.beginAttempt();
          result = await runCli(true);
          // No session started: the CLI exited before it took the message,
          // or nothing reported a session at all (a thread that could not
          // be started, a process that could not be had).
          if (!result.ok && !signal?.aborted && (result.sessionNotStarted === true || reportedHere === reportedBeforeClean)) {
            // The id the clean session was given is no session, and its next
            // turn must not resume it.
            forgetOwnId();
            if (!gone) {
              // Nor was the copy what failed: the member stays a fork, its
              // next turn makes the copy, and the reply says what went wrong.
              session.forkFrom = forkSource;
              if (forkedFromParticipantId) session.forkedFromParticipantId = forkedFromParticipantId;
              forkStartedCleanThisTurn = false;
              result = copyFailure;
            }
          }
        }
      }
      // The CLI could not copy the source session and started the member
      // clean from the saved chat context instead (Claude Code's resume-miss
      // fallback, or the clean start above): it is a member of its own from
      // now on, and the chat says so, once. A fork's notices are lines in
      // the chat as well as warnings here: a warning stays on the device that
      // raised it, and a fork may run on a cloud machine, or have been asked
      // from the phone (postForkNotice).
      const forkStartedClean = forkSource && forkStartedCleanThisTurn
        ? forkStartedCleanNotice(conversation, participant, forkSource, "turn")
        : forkSource && result.sessionRestarted
          ? forkStartedCleanNotice(conversation, participant, forkSource, "now")
          : undefined;
      this.chat.pendingReplies.applyCliRunMetadata(session, result, participant, options.warnings, Boolean(forkStartedClean));
      // Its copy was made whole although it was to end where the User
      // tapped Fork: a line in the chat says why, once.
      const forkCutNote = forkSource && !forkStartedClean ? this.chat.forks.forkCutMissedNote(participant, forkSource, session, result) : undefined;
      if (forkCutNote) {
        this.chat.forks.postForkNotice(conversation, participant, "cut-missed", forkCutNote);
      }
      if (forkStartedClean) {
        delete session.forkFrom;
        delete session.forkedFromParticipantId;
        // In the chat, whoever asked for the turn (a member's request keeps
        // no run warnings of its own).
        this.chat.forks.postForkNotice(conversation, participant, "started-clean", forkStartedClean);
        void this.deps.debugLogs.write("chat.session.fork-started-clean", {
          conversationId: conversation.id,
          participantId: participant.id,
          sourceParticipantId: forkSource!.participantId,
          ok: result.ok
        });
        if (forkStartedCleanThisTurn && !result.ok) {
          // Its clean start failed too, or was stopped: its next turn starts
          // as a new session's first, with the chat context from where the
          // source's started (a clean session has seen none of it).
          forgetPromptContextPointers(conversation, participant.id);
          // The member that gave the task reads it in this failed reply (a
          // main session made by Fork to new chat was asked by the User,
          // whose notice it is: its reply does not say it twice).
          if (!signal?.aborted && !otherChatForkOrigin(conversation, participant, forkSource!.participantId)) {
            result = { ...result, content: [result.content.trim(), forkStartedClean].filter(Boolean).join("\n\n") };
          }
        }
      }
      const sentNow = Boolean(signal?.aborted) && this.chat.activeRuns.sentNowRunIds.has(runId);
      // A run Send now cut short used its once-only grants as one that finished.
      if (!signal?.aborted || sentNow) {
        consumeOneTimePermissionApprovals(conversation, participant, appliedOneTimePermissionApprovalIds);
      }
      const now = new Date().toISOString();
      session.updatedAt = now;
      updateParticipantContextUsage(conversation, participant.id, result.contextUsage);
      const writtenBeforeEnd = pendingMessage.content;
      pendingMessage.content = result.content;
      if (sentNow || (result.ok && result.cutBySendNow)) {
        // A card its cut-short step was waiting on is not answered any more,
        // on the chat as saved now (the card was saved on another copy).
        await this.retireApprovalsCutBySendNow(conversation, participant, runId);
      }
      if (sentNow) {
        // Cut for the message waiting behind it: what it had written stays,
        // never the CLI's cancellation notice.
        if (!(result.ok && result.content.trim())) {
          pendingMessage.content = writtenBeforeEnd.trim() ? writtenBeforeEnd : progressSink.processingTranscript(now)?.content ?? "";
        }
        markParticipantMessageSentNow(pendingMessage);
      } else if (signal?.aborted) {
        // A Stop that lands as the reply finishes keeps the reply the member
        // already delivered, as the CLI does.
        markParticipantMessageStoppedByUser(pendingMessage, participant, {
          preserveContent: result.ok && result.content.trim().length > 0
        });
      } else if (!result.ok && this.chat.appQuit.endsByQuit(runId) && closedByQuit(result.error)) {
        // Its process closed because the User quits: what the quit says of
        // the turns it ends (endTurnsForQuit), not a failure of the member,
        // keeping what it had written (in the bubble, else as it streamed).
        markStoppedByQuit(pendingMessage, false, writtenBeforeEnd.trim() ? writtenBeforeEnd : progressSink.processingTranscript(now)?.content);
      } else {
        pendingMessage.status = result.ok ? "done" : "error";
      }
      if (pendingMessage.metadata?.queuedBehind || pendingMessage.metadata?.turnQueued) {
        // A reply its CLI never started (it failed or stopped while queued)
        // is not left queued.
        const takenBack = signal?.aborted && !this.chat.appQuit.endsByQuit(runId) ? takenBackMark(pendingMessage) : undefined;
        const { queuedBehind: _queuedBehind, turnQueued: _turnQueued, ...metadata } = pendingMessage.metadata;
        pendingMessage.metadata = { ...metadata, ...takenBack };
      }
      const endedByQuit = !signal?.aborted && !result.ok && this.chat.appQuit.endsByQuit(runId) && closedByQuit(result.error);
      const notReady = !signal?.aborted && !result.ok && !endedByQuit && firstTurnHere ? await this.chat.agentEnvironment.firstTurnProviderProblem(participant) : undefined;
      if (notReady) {
        pendingMessage.content = pendingMessage.content.trim() ? `${notReady}\n\n${pendingMessage.content}` : notReady;
        options.warnings.push(notReady);
      }
      if (!signal?.aborted && !result.ok) {
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(
          conversation,
          runId,
          endedByQuit ? INTERRUPTED_REPLY_TEXT : result.error ?? `@${participant.handle} failed before pending approval was resolved.`,
          !endedByQuit
        );
      }
      if (!signal?.aborted && !result.ok && !endedByQuit && result.error) {
        options.warnings.push(`@${participant.handle}: ${result.error}`);
      }
      if ((result.ok && result.turnContinues && !signal?.aborted) || sentNow) {
        // The turn goes on in the next message's reply (as in the CLI's
        // transcript): no "Worked for" of its own, its steps stay open.
        const { workedMs: _workedMs, ...metadata } = pendingMessage.metadata ?? {};
        pendingMessage.metadata = { ...metadata, turnContinues: true };
      } else {
        // Worked from its own turn's start: a reply that waited in the queue
        // does not count the wait (turnStartedAt).
        const workedMs = Date.parse(now) - Date.parse(pendingMessage.metadata?.turnStartedAt ?? pendingMessage.createdAt);
        if (Number.isFinite(workedMs) && workedMs >= 0) {
          pendingMessage.metadata = { ...pendingMessage.metadata, workedMs };
        }
      }
      recordReplySessionCut(pendingMessage, result);
      const activityEvents = progressSink.activityEvents();
      if (activityEvents.length > 0) {
        pendingMessage.metadata = { ...pendingMessage.metadata, activityEvents };
      }
      let processingTranscript = progressSink.processingTranscript(now);
      if (processingTranscript && signal?.aborted && !sentNow) {
        processingTranscript = processingTranscriptWithTerminalMessage(
          processingTranscript,
          pendingMessage.content
        );
      }
      if (processingTranscript) {
        pendingMessage.metadata = { ...pendingMessage.metadata, processingTranscript };
      }
      // A reply Send now cut short read its prompt as one that finished did.
      const promptRead = (!signal?.aborted && result.ok) || sentNow;
      if (sentNow) commitPromptContextPointerAdvance(conversation, participant.id, preparedPromptContext.pointerAdvance);
      if (!signal?.aborted && result.ok && result.content.trim()) {
        commitPromptContextPointerAdvance(conversation, participant.id, preparedPromptContext.pointerAdvance);
        this.chat.pendingReplies.logMissingSelectedSkillStatus(triggerMessage, participant, pendingMessage, runId);
        const pendingMentions: ChatPendingMention[] = [];
        const pendingChoice = pendingChoiceFromAgentReply(result.content);
        const requesterContinuationRequested = false;
        if (pendingMentions.length > 0 || pendingChoice) {
          pendingMessage.metadata = {
            ...pendingMessage.metadata,
            mentions: pendingMentions.length > 0 ? pendingMentions.map((mention) => mention.targetHandle) : undefined,
            pendingMentions: pendingMentions.length > 0 ? pendingMentions : undefined,
            pendingChoice,
            requesterContinuationRequested: requesterContinuationRequested || undefined
          };
        }
        session.lastSyncedMessageId = pendingMessage.id;
      }
      // Told where it is now (its CLI answered this prompt): not again.
      if (carriedMoveNote && promptRead) delete session.movedHere;
      // Its access as this turn's CLI was told it (its instructions, or a
      // note): a later turn says only a change of it. A compaction of its
      // conversation (by its CLI, in this turn or in a reply nobody waited
      // on) makes the next turn say it again, unless this turn said it after.
      const told = promptRead;
      if (told) delete session.importIntroPending;
      const compactedNow = this.chat.turnPrompt.noteMemberCompactions(conversation.id, participant);
      if (told && carriesCurrentAccess && !compactedNow) this.chat.memberSessions.accessRestateDue.delete(restateKey);
      if (this.chat.memberSessions.accessRestateDue.has(restateKey)) {
        if (told || session.instructionsAccessHash) session.instructionsAccessHash = INSTRUCTIONS_ACCESS_RESTATE;
      } else if (told) {
        session.instructionsAccessHash = this.chat.memberSessions.accessHash(conversation, participant, session, access);
      }
      // Its instructions given again in this message, in a turn that did not
      // succeed (it may never have reached the CLI): given again next turn.
      if (!told && includeRefreshedRoleInstructions) session.runtimeConfigVersion = undefined;
      upsertSession(conversation, session);
      lockParticipantRoleVersion(conversation, participant, session.roleConfigVersion);
      return [pendingMessage];
    } catch (error) {
      if (signal?.aborted && error instanceof NativeProcessUnavailableError) {
        markParticipantMessageStopUnconfirmed(pendingMessage, participant, error.message);
      }
      throw error;
    } finally {
      if (carriedMoveNote) this.moveNotesInFlight.delete(carriedMoveNote);
      void turnImages.cleanup();
      unregisterRunProgressCallback();
      options.writeGate?.markWritten();
      // A turn that ran in another mode by a once-only grant ("Allow once" of
      // file edits: Accept edits): the member's live process goes back to its
      // own mode, so what it does on its own afterwards (background tasks)
      // runs in that.
      if (claudeModeForTurn && claudeModeRead && claudeModeForTurn !== claudeModeRead) {
        void this.chat.claudeModes.restoreClaudeMemberMode(conversation.id, participant.id, claudeModeRead);
      }
      this.chat.promptContext.releaseInFlightPromptContext(runId);
      this.chat.claudeModes.claudeOnceEditGrants.delete(runId);
      for (const [approvalId, claimRunId] of this.chat.permissionRequests.oneTimeApprovalClaims) {
        if (claimRunId === runId) {
          this.chat.permissionRequests.oneTimeApprovalClaims.delete(approvalId);
        }
      }
      if (pendingMessage.status === "pending") {
        const sentNow = Boolean(signal?.aborted) && this.chat.activeRuns.sentNowRunIds.has(runId);
        if (sentNow) {
          markParticipantMessageSentNow(pendingMessage);
        } else if (signal?.aborted) {
          markParticipantMessageStoppedByUser(pendingMessage, participant);
        } else {
          pendingMessage.status = "error";
        }
        if (!pendingMessage.content && sentNow) {
          // What it had streamed stays as its words.
          pendingMessage.content = progressSink.processingTranscript(new Date().toISOString())?.content ?? "";
        } else if (!pendingMessage.content) {
          pendingMessage.content = `@${participant.handle} run was interrupted before a response was produced.`;
        }
      }
      const selfCompaction = this.chat.selfCompactionResumes.selfCompactionMarkFor(conversation.id, participant.id, runId,
        Boolean(signal?.aborted) && !this.chat.activeRuns.sentNowRunIds.has(runId));
      if (selfCompaction) pendingMessage.metadata = { ...pendingMessage.metadata, selfCompaction };
      // Skip the snapshot push for two cases:
      //   1. The run was cancelled — caller (`discardStoppedTargetRun`) will
      //      preserve a finalized stopped bubble (including captured output),
      //      or replace a never-started queued bubble with a system note.
      //   2. This run came from `runParticipantBatch` (identified by the
      //      pre-created `existingPendingMessage`) — that caller emits the final
      //      snapshot under `withChatMutation` via `appendCompletedTurn`.
      // The legacy path (mention approval continuation, choice continuation,
      // auto-resume) still needs an immediate snapshot of the finalized pending
      // message, but it must run under `withChatMutation` so concurrent background
      // dispatches' state isn't clobbered by a stale clone.
      if (signal?.aborted && !options.existingPendingMessage) {
        this.chat.executorLeases.releaseParticipantExecutorLease(conversation, executionLease);
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(
          conversation,
          runId,
          `@${participant.handle} stopped before pending approval was resolved.`
        );
        await this.chat.pendingReplies.finalizePendingParticipantMessage(conversation, participant, pendingMessage);
      } else if (!signal?.aborted && !options.existingPendingMessage) {
        this.chat.executorLeases.releaseParticipantExecutorLease(conversation, executionLease);
        await this.chat.pendingReplies.finalizePendingParticipantMessage(conversation, participant, pendingMessage);
      } else {
        this.chat.executorLeases.releaseParticipantExecutorLease(conversation, executionLease);
      }
      progressSink.finish();
    }
  }

  /** The cards a step cut short by Send now was waiting on: not answered any
   *  more, on the chat as it is saved now (they were saved on another copy). */
  private async retireApprovalsCutBySendNow(conversation: Conversation, participant: ChatParticipant, runId: string): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, runId,
        `@${participant.handle} moved on to the message sent now before this was answered.`);
      this.chat.store.queueSnapshot(conversation);
    });
  }
}
