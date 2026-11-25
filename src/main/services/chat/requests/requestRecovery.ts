import type { ChatMessage, ChatParticipantRequestBatch, Conversation } from "../../../../shared/types";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION } from "../constants";
import { chatParticipants } from "../members/identity";
import { delegationTurnGroup, requesterResumeRecoveryKey, turnSegmentKey } from "./delegationGroups";
import {
  participantRequestHasUnfinishedItems, participantRequestWaitsOnPermissionCard, pendingParticipantRequestApprovalTargetIds,
  rollupParticipantRequestStatus, terminalParticipantRequestBatch, updateParticipantRequestBatch
} from "./requestRecords";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** How the line that resumes a requester after its request starts. */
const PARTICIPANT_REQUEST_AUTO_RESUME_PREFIX = "Auto-resumed";

/** How long after the last of the main session's tasks of a turn ended a
 *  restart may still resume it with them (delegationGroupRecoveryVerdict). */
const DELEGATION_GROUP_RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;

/** Requests whose run ended without an answer: after a restart, a quit or a lost turn. */
export class RequestRecovery {
  /** Groups of the main session's tasks of a turn that ended before this
   *  process started, looked at once (recoverDelegationGroupsOfEndedTurns). */
  private readonly delegationGroupsRecovered = new Set<string>();
  /** Chats whose ended turns' tasks were looked at since this process
   *  started: the look is made at a chat's first read, not on every read. */
  private readonly delegationRecoveryLookedChats = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "delegation" | "host" | "participantRequests" | "permissionRequests" | "requesterResumes" | "runOwners"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress">
  ) {}

  markOrphanedParticipantRequestsInterrupted(
    conversation: Conversation,
    options: { ignoreLocalRequestLocks?: boolean; ignoreProtectedExternalRuns?: boolean } = {}
  ): boolean {
    let changed = false;
    for (const message of conversation.messages) {
      if (this.markOrphanedParticipantRequestInterrupted(conversation, message, options)) {
        changed = true;
      }
    }
    return changed;
  }

  markOrphanedParticipantRequestInterrupted(
    conversation: Conversation,
    message: ChatMessage,
    options: { ignoreLocalRequestLocks?: boolean; ignoreProtectedExternalRuns?: boolean } = {}
  ): boolean {
    const batch = message.metadata?.participantRequest;
    if (!batch) {
      return false;
    }
    const backedPendingTargetIds = pendingParticipantRequestApprovalTargetIds(conversation, batch);
    const hasOrphanedPendingApproval = batch.items.some((item) =>
      item.status === "pending_approval" && !backedPendingTargetIds.has(item.targetParticipantId)
    );
    const canInterruptRunning = batch.status === "running" || batch.status === "resuming_requester";
    if (!hasOrphanedPendingApproval && !canInterruptRunning) {
      return false;
    }
    if (
      canInterruptRunning &&
      options.ignoreLocalRequestLocks !== true &&
      (this.chat.participantRequests.participantRequestRunners.has(message.id) || this.chat.requesterResumes.participantRequestAutoResumes.has(message.id) || this.chat.permissionRequests.heldParticipantRequests.has(message.id) ||
        (batch.delegation?.turnId !== undefined && this.chat.requesterResumes.delegationGroupResumes.has(turnSegmentKey(conversation.id, batch.delegation.turnId))))
    ) {
      return false;
    }
    if (
      canInterruptRunning &&
      options.ignoreProtectedExternalRuns !== true &&
      this.participantRequestHasProtectedExternalRun(conversation, message.id)
    ) {
      return false;
    }
    const now = new Date().toISOString();
    const reason = PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION;
    const nextBatch = terminalParticipantRequestBatch(
      batch,
      "interrupted",
      reason,
      now,
      (item) =>
        item.status === "running" ||
        item.status === "resuming_requester" ||
        (item.status === "pending_approval" && !backedPendingTargetIds.has(item.targetParticipantId))
    );
    if (nextBatch === batch) {
      return false;
    }
    message.metadata = {
      ...message.metadata,
      participantRequest: nextBatch
    };
    // A task of the main session, or a request made with
    // app_chat_request_participants, that a restart ended: the others of its
    // turn may have ended before, and nothing else would resume it now.
    // Before the chat's first look since the app started, that look (right
    // after this, recoverDelegationGroupsOfEndedTurns) weighs it; after it,
    // it is weighed here once its last task has ended.
    const turnId = nextBatch.delegation?.turnId;
    const recoveryKey = requesterResumeRecoveryKey(conversation.id, message.id, nextBatch);
    // Only work a restart cut short: a request whose approval card went
    // away was ended here before (no resume, as it never ran).
    if (recoveryKey && (turnId || canInterruptRunning) && this.delegationRecoveryLookedChats.has(conversation.id)) {
      const group = delegationTurnGroup(conversation, message, nextBatch);
      if (!this.delegationGroupsRecovered.has(recoveryKey) && !group.some((entry) => participantRequestHasUnfinishedItems(entry.batch) ||
        participantRequestWaitsOnPermissionCard(conversation, entry.message, entry.batch))) {
        this.delegationGroupsRecovered.add(recoveryKey);
        const verdict = this.delegationGroupRecoveryVerdict(conversation, turnId, group.map((entry) => entry.message));
        if (verdict === "resume") {
          this.scheduleDelegationGroupResume(conversation.id, message.id);
        } else {
          this.logDelegationGroupSettled(conversation.id, group.map((entry) => entry.message.id), verdict, false);
        }
      }
    }
    return true;
  }

  /**
   * The requests a restart left a requester waiting on: the main session's
   * tasks of a turn that does not run here (any more), and a request made
   * with app_chat_request_participants on its own (each is a "group" below).
   * A restart ended that turn or that wait, or cut short the resume that
   * answered it.
   * Nothing in memory looks at them again then (liveTurnSegments and
   * delegatingTurns are this process's), so the first read of the chat after
   * the app started looks once per group whose requester runs here and whose
   * tasks have all ended. The main session is resumed with every answer, as
   * at its turn's end, only while nothing has gone on since
   * (delegationGroupRecoveryVerdict): no resume of them was begun, nobody
   * wrote to it after them, and they ended within a day. Any other group is
   * settled quietly; a resume a restart cut short ("resuming_requester" with
   * no resume going on here, which would hold every later look) stops
   * holding either way. Returns whether a request changed.
   */
  recoverDelegationGroupsOfEndedTurns(conversation: Conversation): boolean {
    // A machine that does not know yet which machine it is cannot tell whose
    // main session runs here: it looks once it does.
    if (this.delegationRecoveryLookedChats.has(conversation.id) || (this.chat.host.machineRuntime && !this.chat.host.hostMachineId)) return false;
    this.delegationRecoveryLookedChats.add(conversation.id);
    // The main session's tasks by the turn that gave them; a request made
    // with app_chat_request_participants on its own: a quit or a restart
    // cuts the wait for its answers short the same way (its resume is
    // skipped while quitting, and nothing here waits for it after), and
    // with mention wake-ups off in the sessions view nothing else brings
    // its requester back to them.
    const groups = new Map<string, { turnId?: string; messages: ChatMessage[] }>();
    for (const message of conversation.messages) {
      const batch = message.metadata?.participantRequest;
      const key = batch ? requesterResumeRecoveryKey(conversation.id, message.id, batch) : undefined;
      if (!batch || !key) continue;
      const turnId = batch.delegation?.turnId;
      const group = groups.get(key) ?? { turnId, messages: [] };
      group.messages.push(message);
      groups.set(key, group);
    }
    let changed = false;
    for (const [key, { turnId, messages }] of groups) {
      if (this.chat.delegation.liveTurnSegments.has(key) || this.chat.delegation.delegatingTurns.has(key) || this.chat.requesterResumes.delegationGroupResumes.has(key) ||
        this.delegationGroupsRecovered.has(key)) continue;
      if (messages.some((message) => this.chat.requesterResumes.participantRequestAutoResumes.has(message.id) || this.chat.participantRequests.participantRequestRunners.has(message.id) || this.chat.permissionRequests.heldParticipantRequests.has(message.id))) continue;
      const batches = messages.map((message) => message.metadata!.participantRequest!);
      // A task still at work looks again itself when it ends; one whose
      // member waits on the User's permission card is resumed by its
      // approval (applyPermissionResumeToParticipantRequest), with the answer.
      if (batches.some((batch) => participantRequestHasUnfinishedItems(batch))) continue;
      if (messages.some((message) => participantRequestWaitsOnPermissionCard(conversation, message, message.metadata!.participantRequest!))) continue;
      const requester = chatParticipants(conversation).find((participant) => participant.id === batches[0]!.requesterParticipantId);
      if (!requester || !this.chat.host.ownsParticipant(requester)) continue;
      this.delegationGroupsRecovered.add(key);
      const cutShort = batches.some((batch) => batch.status === "resuming_requester");
      if (cutShort) {
        const now = new Date().toISOString();
        for (const message of messages) {
          updateParticipantRequestBatch(conversation, message.id, (current) => current.status === "resuming_requester"
            ? { ...current, status: rollupParticipantRequestStatus(current.items), updatedAt: now }
            : current);
        }
        changed = true;
      }
      const verdict = this.delegationGroupRecoveryVerdict(conversation, turnId, messages);
      if (verdict !== "resume") {
        // Old requests of a long chat are weighed at every start: an old
        // request on its own is settled without a line each time.
        if (verdict !== "too-old" || turnId || cutShort) {
          this.logDelegationGroupSettled(conversation.id, messages.map((message) => message.id), verdict, cutShort);
        }
        continue;
      }
      void this.deps.debugLogs.write("chat.participant-request.auto-resume.recovered", {
        conversationId: conversation.id,
        requestMessageIds: messages.map((message) => message.id),
        cutShort
      }).catch(() => undefined);
      this.scheduleDelegationGroupResume(conversation.id, messages[0]!.id);
    }
    return changed;
  }

  /**
   * Whether a restart may still resume the requester with the tasks of one
   * of the main session's turns, or with one request made with
   * app_chat_request_participants, all ended: only when no resume of them was begun (a
   * resume line written may have done its work already), nothing was
   * written to the chat after they ended by the User or by another turn of
   * the main session, and the last of them ended within a day. A task the
   * restart itself ended counts as ended when it was given: when it really
   * stopped is not known, and a resume nobody expects any more is worse than
   * none.
   */
  private delegationGroupRecoveryVerdict(
    conversation: Conversation,
    turnId: string | undefined,
    messages: readonly ChatMessage[]
  ): "resume" | "resume-already-made" | "moved-on" | "too-old" {
    const batches = messages.flatMap((message) => message.metadata?.participantRequest ? [message.metadata.participantRequest] : []);
    if (batches.some((batch) => batch.autoResumeMessageId)) {
      return "resume-already-made";
    }
    const endedAt = Math.max(...batches.flatMap((batch) => batch.items.map((item) => Date.parse(
      item.status === "interrupted" && item.error === PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION ? item.createdAt : item.updatedAt
    ))).filter(Number.isFinite));
    // Cheap first: every start weighs each old request of a long chat again.
    if (!Number.isFinite(endedAt) || Date.now() - endedAt > DELEGATION_GROUP_RECOVERY_MAX_AGE_MS) {
      return "too-old";
    }
    if (this.delegationGroupResumeWasMade(conversation, messages)) {
      return "resume-already-made";
    }
    const requesterId = batches[0]?.requesterParticipantId;
    const ownIds = new Set(messages.map((message) => message.id));
    // The requester's own turn that asked is not "going on": its messages
    // carry that turn's turnSegmentId (its reply and the posts it sent with
    // app_chat_send_message). For a request stored before it kept its turn,
    // that turn is the one of the requester's reply to the message the
    // request answered; with neither, any later message of the requester
    // counts as going on (no resume rather than one nobody expects).
    const askingTurn = turnId ?? batches[0]?.requesterTurnSegmentId;
    const requestTrigger = batches[0]?.triggerMessageId;
    // Stored before: its turn is the one of its reply to that message.
    const askingTurns = new Set(askingTurn ? [askingTurn] : requestTrigger === undefined ? [] : conversation.messages.flatMap((message) =>
      message.role === "participant" && message.participantId === batches[0]?.requesterParticipantId &&
        message.metadata?.sourceMessageId === requestTrigger && message.metadata?.turnSegmentId ? [message.metadata.turnSegmentId] : []));
    const sameTurn = (message: ChatMessage): boolean =>
      (message.metadata?.turnSegmentId !== undefined && askingTurns.has(message.metadata.turnSegmentId)) ||
      (!askingTurn && requestTrigger !== undefined && message.metadata?.sourceMessageId === requestTrigger);
    const movedOn = conversation.messages.some((message) => {
      if (ownIds.has(message.id) || !(Date.parse(message.createdAt) > endedAt)) return false;
      return message.role === "user" ||
        (message.role === "participant" && message.participantId === requesterId && !sameTurn(message));
    });
    return movedOn ? "moved-on" : "resume";
  }

  private logDelegationGroupSettled(conversationId: string, requestMessageIds: string[], reason: string, cutShort: boolean): void {
    void this.deps.debugLogs.write("chat.participant-request.auto-resume.settled", {
      conversationId,
      requestMessageIds,
      reason,
      cutShort
    }).catch(() => undefined);
  }

  /** Whether a resume of these tasks was already made (its trigger is in the
   *  chat): one that failed is not made again on its own. */
  private delegationGroupResumeWasMade(conversation: Conversation, messages: readonly ChatMessage[]): boolean {
    const ids = new Set(messages.map((message) => message.id));
    return conversation.messages.some((message) => message.role === "system" &&
      typeof message.metadata?.sourceMessageId === "string" && ids.has(message.metadata.sourceMessageId) &&
      message.content.startsWith(`${PARTICIPANT_REQUEST_AUTO_RESUME_PREFIX} @`));
  }

  private scheduleDelegationGroupResume(conversationId: string, requestMessageId: string): void {
    const timer = setTimeout(() => {
      void this.chat.requesterResumes.autoResumeParticipantRequest(conversationId, requestMessageId, this.deps.onReviewProgress, { groupCheck: true }).catch((error) => {
        void this.deps.debugLogs.write("chat.participant-request.auto-resume.error", {
          conversationId,
          requestMessageId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, 0);
    timer.unref?.();
  }

  private participantRequestHasProtectedExternalRun(conversation: Conversation, requestMessageId: string): boolean {
    return conversation.messages.some((message) =>
      message.role === "participant" &&
      message.status === "pending" &&
      (message.metadata?.parentMessageId === requestMessageId || message.metadata?.sourceMessageId === requestMessageId) &&
      this.chat.runOwners.isMessageRunProtectedByExternalOwner(conversation, message)
    );
  }

  /** True while a target of this request still has a live run in this chat: the
   *  delegation is being worked on right now, whatever the requester is doing. */
  participantRequestIsStillRunning(
    conversation: Conversation,
    batch: ChatParticipantRequestBatch
  ): boolean {
    const working = new Set<string>();
    for (const meta of this.chat.activeRuns.chatRunMeta.values()) {
      if (meta.conversationId === conversation.id) working.add(meta.participantId);
    }
    if (working.size === 0) return false;
    return batch.items.some((item) =>
      (item.status === "pending_approval" || item.status === "running" || item.status === "resuming_requester")
      && working.has(item.targetParticipantId));
  }
}
