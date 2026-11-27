import type { ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION } from "../constants";
import { chatParticipants } from "../members/identity";
import { delegationTurnGroup, requesterResumeRecoveryKey, turnSegmentKey } from "./delegationGroups";
import { endWaitOnUnresumedOwnRequest, itemWaitsOnOwnRequests, markOwnRequestResumeEnded, requestWaitingOnOwnRequest } from "./ownRequests";
import {
  isOpenParticipantRequestStatus, participantRequestHasUnfinishedItems, participantRequestWaitsOnPermissionCard,
  pendingParticipantRequestApprovalTargetIds, rollupParticipantRequestStatus, settleRequestsAnsweredWith, terminalParticipantRequestBatch,
  updateParticipantRequestBatch
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
      | "activeRuns" | "appQuit" | "delegation" | "host" | "participantRequests" | "permissionRequests" | "requesterResumes" | "runOwners"
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
    // What a sweep keeps because its member waits on its own requests is
    // waited on where its requester runs (that device may have learnt of it
    // only now: the member answered a card on another device).
    if (this.delegationRecoveryLookedChats.has(conversation.id)) this.armOwnRequestWait(conversation, message);
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
    // A request that went out with another in one turn has no runner of its
    // own: it ends when that one does (settleRequestsAnsweredWith), not here
    // while that one is still open.
    const leadOpen = (item: ChatParticipantRequestItem): boolean => {
      const lead = item.answeredWith && conversation.messages.find((candidate) => candidate.id === item.answeredWith!.requestMessageId)
        ?.metadata?.participantRequest?.items.find((candidate) => candidate.targetParticipantId === item.targetParticipantId);
      return Boolean(lead && isOpenParticipantRequestStatus(lead.status));
    };
    const nextBatch = terminalParticipantRequestBatch(
      batch,
      "interrupted",
      reason,
      now,
      (item) =>
        // A member that ended its turn waiting on its own requests goes on
        // once resumed with their answers, after a restart too: its answer is
        // still to come (resumeOwnRequestWait waits for it again).
        (((item.status === "running" && !itemWaitsOnOwnRequests(conversation, message, item)) || item.status === "resuming_requester") && !leadOpen(item)) ||
        (item.status === "pending_approval" && !backedPendingTargetIds.has(item.targetParticipantId))
    );
    if (nextBatch === batch) {
      return false;
    }
    message.metadata = {
      ...message.metadata,
      participantRequest: nextBatch
    };
    // The requests that went out with it end with it.
    settleRequestsAnsweredWith(conversation, message.id, nextBatch);
    // A task of the main session, or a request made with
    // app_chat_request_participants, that a restart ended: the others of its
    // turn may have ended before, and nothing else would resume it now.
    // Before the chat's first look since the app started, that look (right
    // after this, recoverDelegationGroupsOfEndedTurns) weighs it; after it,
    // it is weighed here once its last task has ended.
    // Only work a restart cut short: a request whose approval card went
    // away was ended here before (no resume, as it never ran).
    if (nextBatch.delegation?.turnId || canInterruptRunning) this.weighRequestARestartEnded(conversation, message);
    // A request of a member's own whose approval card went away: it is not
    // asked, and its member is not resumed from it: a request waiting on its
    // answer ends (its own device writes that).
    else if (this.delegationRecoveryLookedChats.has(conversation.id)) this.endWaitsOnUnresumed(conversation, [message.id]);
    return true;
  }

  /** A request a restart ended, once the chat's first look since the app
   *  started was made (before it, that look weighs it): once its last task
   *  has ended, its requester is resumed with the answers, or it is settled
   *  (delegationGroupRecoveryVerdict). Not resumed: a request that waited on
   *  this one's requester (its own request, ownRequests.ts) ends as well and
   *  is weighed the same way. */
  private weighRequestARestartEnded(conversation: Conversation, message: ChatMessage): void {
    const batch = message.metadata?.participantRequest;
    const recoveryKey = batch ? requesterResumeRecoveryKey(conversation.id, message.id, batch) : undefined;
    if (!batch || !recoveryKey || !this.delegationRecoveryLookedChats.has(conversation.id)) return;
    const group = delegationTurnGroup(conversation, message, batch);
    if (this.delegationGroupsRecovered.has(recoveryKey) || group.some((entry) => participantRequestHasUnfinishedItems(entry.batch) ||
      participantRequestWaitsOnPermissionCard(conversation, entry.message, entry.batch))) return;
    this.delegationGroupsRecovered.add(recoveryKey);
    const verdict = this.delegationGroupRecoveryVerdict(conversation, batch.delegation?.turnId, group.map((entry) => entry.message));
    if (verdict === "resume") {
      this.scheduleDelegationGroupResume(conversation.id, message.id);
      return;
    }
    this.logDelegationGroupSettled(conversation.id, group.map((entry) => entry.message.id), verdict, false);
    this.endWaitsOnUnresumed(conversation, group.map((entry) => entry.message.id));
  }

  /** Requests of a member's own that will not resume it (a restart decided
   *  so; one older than a day no request waits on any more): what waited on
   *  them ends interrupted when it is this device's to end, and is weighed as
   *  a request a restart ended, with the requests that went out with it; each
   *  of them is marked so (markOwnRequestResumeEnded) for the device that
   *  waits on it. Returns whether one changed. */
  private endWaitsOnUnresumed(conversation: Conversation, ownRequestMessageIds: readonly string[], awaited = awaitedMembersOf(conversation)): boolean {
    let changed = false;
    const participants = chatParticipants(conversation);
    for (const id of ownRequestMessageIds) {
      const own = conversation.messages.find((message) => message.id === id);
      // Cheap first (a start weighs every old request of a long chat): only
      // a member some open request waits on has a request waiting on it.
      if (!own?.metadata?.participantRequest || !awaited.has(own.metadata.participantRequest.requesterParticipantId)) continue;
      const waitingOn = own ? requestWaitingOnOwnRequest(conversation, own) : undefined;
      const requester = participants.find((participant) => participant.id === waitingOn?.message.metadata?.participantRequest?.requesterParticipantId);
      // Only the device whose request it is writes it; another one ends it
      // when it reads the mark.
      const waiting = requester && this.chat.host.ownsParticipant(requester) ? endWaitOnUnresumedOwnRequest(conversation, id) : undefined;
      // The mark is the member's own device's to write (its request).
      const member = participants.find((participant) => participant.id === own.metadata?.participantRequest?.requesterParticipantId);
      if (member && this.chat.host.ownsParticipant(member) && markOwnRequestResumeEnded(conversation, id, "not-made")) changed = true;
      if (!waiting) continue;
      changed = true;
      this.weighRequestARestartEnded(conversation, waiting);
      for (const linked of conversation.messages) {
        if (linked.metadata?.participantRequest?.items.some((item) => item.answeredWith?.requestMessageId === waiting.id)) {
          this.weighRequestARestartEnded(conversation, linked);
        }
      }
    }
    return changed;
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
    let awaited: Set<string> | undefined;
    const awaitedMembers = (): Set<string> => (awaited ??= awaitedMembersOf(conversation));
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
        // Its requester is not resumed: a request that waited on it ends.
        if (this.endWaitsOnUnresumed(conversation, messages.map((message) => message.id), awaitedMembers())) changed = true;
        continue;
      }
      void this.deps.debugLogs.write("chat.participant-request.auto-resume.recovered", {
        conversationId: conversation.id,
        requestMessageIds: messages.map((message) => message.id),
        cutShort
      }).catch(() => undefined);
      this.scheduleDelegationGroupResume(conversation.id, messages[0]!.id);
    }
    // What the look left waiting on its member's own requests is waited on
    // again, after the look (it may have ended some of them).
    this.waitAgainOnOwnRequests(conversation);
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

  /** At the chat's first look since the app started: each request whose
   *  member waits on its own requests (a restart left it running) is waited
   *  on again where its requester runs. */
  private waitAgainOnOwnRequests(conversation: Conversation): void {
    for (const message of conversation.messages) this.armOwnRequestWait(conversation, message);
  }

  /** A request whose member waits on its own requests, with no wait for it
   *  here, is waited on here when its requester runs here (not while the app
   *  quits). */
  private armOwnRequestWait(conversation: Conversation, message: ChatMessage): void {
    const batch = message.metadata?.participantRequest;
    // Not while one waits for it here already (its runner, or the resume
    // after a permission card that holds it).
    if (!batch || this.chat.appQuit.quitting || this.chat.participantRequests.participantRequestRunners.has(message.id) ||
      this.chat.permissionRequests.heldParticipantRequests.has(message.id)) return;
    // Cheap first: a sweep looks at every request of the chat.
    if (!batch.items.some((item) => item.status === "running" && item.replyMessageId && !item.answeredWith)) return;
    const requester = chatParticipants(conversation).find((participant) => participant.id === batch.requesterParticipantId);
    if (!requester || !this.chat.host.ownsParticipant(requester)) return;
    // One that went out with another waits as that one does (answeredWith).
    if (!batch.items.some((item) => !item.answeredWith && itemWaitsOnOwnRequests(conversation, message, item))) return;
    const timer = setTimeout(() => this.chat.participantRequests.resumeOwnRequestWait(conversation.id, message.id), 0);
    timer.unref?.();
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

/** The members an open request waits on with a reply so far (a request
 *  waiting on such a member's own requests is one of them). */
function awaitedMembersOf(conversation: Conversation): Set<string> {
  const members = new Set<string>();
  for (const message of conversation.messages) {
    for (const item of message.metadata?.participantRequest?.items ?? []) {
      if (item.status === "running" && item.replyMessageId) members.add(item.targetParticipantId);
    }
  }
  return members;
}
