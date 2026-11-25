import type {
  ChatAppToolApproval, ChatAppToolApprovalRequest, ChatParticipant, ChatParticipantRemovalRequest, Conversation
} from "../../../../shared/types";
import { APP_ROSTER_REQUEST_CHANGE_TOOL } from "../../appMcp";
import { StorageService } from "../../storage";
import {
  chatAppToolApprovals, isParticipantChangeRequest, isRoleParticipantChangeRequest, matchingAppToolApprovalPolicy,
  upsertAppToolApproval
} from "../approvals/approvalRecords";
import { chatParticipants, formatHandleList } from "./identity";
import {
  isQueuedMemberAdditionApproval, isQueuedMemberRemovalApproval, laterThan, machineRemovalHandleProblem, machineRosterCardProblem,
  machineRosterDecision, type MachineRosterDecision, markAddedWithoutCard, memberAdditionTargets, memberRemovalHandles,
  memberRemovalProblem, pushMemberRemovalFailure, requesterReference, rosterChangeTargetsText
} from "./removalRules";
import { normalizeParticipantChangeRequest, normalizeRoleParticipantChangeRequest, normalizeRosterChangeRequest } from "./rosterRequests";
import { createChatMessage } from "../store/messages";
import type { ChatApprovalExecutionGuard } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** When a machine member's addition is looked at again while its User answer
 *  cannot be read here yet. */
const MEMBER_ADDITION_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

/** How long an approved member removal whose application failed waits before
 *  an idle moment tries it again. */
const MEMBER_REMOVAL_RETRY_DELAY_MS = 30_000;

/** Approved removals and additions that wait until no member works. */
export class QueuedRosterChanges {
  /** Chats holding an approved member removal that waits for idle, with a
   *  generation bumped on every new decision; an in-memory index so the idle
   *  hooks stay free for every other chat. */
  private readonly queuedMemberRemovalChats = new Map<string, number>();
  private readonly memberRemovalApplies = new Map<string, Promise<void>>();
  private readonly memberRemovalApplyAgain = new Set<string>();
  private readonly memberRemovalRetryAfter = new Map<string, number>();
  private readonly memberAdditionApplies = new Map<string, Promise<void>>();
  private readonly memberAdditionApplyAgain = new Set<string>();
  private readonly memberAdditionRetries = new Map<string, number>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "members" | "permissionRequests" | "rosterChanges" | "rosterTools" | "runOwners" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  /** The User approved a member's removal request. The decision is recorded
   *  at once and the removal is applied when the chat is idle: right now if it
   *  already is, otherwise when the asking member's turn (and any other running
   *  work) ends. */
  async approveParticipantRemoval(
    conversation: Conversation,
    approval: ChatAppToolApproval,
    request: ChatParticipantRemovalRequest,
    execution?: ChatApprovalExecutionGuard
  ): Promise<Conversation> {
    const refuse = async (): Promise<void> => {
      // Written through the chat mutation: the asking member's turn is often
      // still writing when the User answers, and `conversation` was read
      // before that.
      await this.chat.store.withChatMutation(conversation, async () => {
        const current = chatAppToolApprovals(conversation).find((item) => item.id === approval.id);
        const problem = current?.status === "pending" ? memberRemovalProblem(conversation, current, request) : undefined;
        if (!current || !problem) {
          return;
        }
        const now = new Date().toISOString();
        upsertAppToolApproval(conversation, { ...current, status: "denied", updatedAt: now, error: problem });
        pushMemberRemovalFailure(conversation, current, request, problem);
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
      });
    };
    if (memberRemovalProblem(conversation, approval, request)) {
      await refuse();
      return conversation;
    }
    await execution?.beforeApply(approval);
    let recorded = false;
    let refused = false;
    await this.chat.store.withChatMutation(conversation, async () => {
      const current = chatAppToolApprovals(conversation).find((item) => item.id === approval.id);
      if (!current || current.status !== "pending") {
        throw new Error("App tool approval request has already been answered.");
      }
      if (memberRemovalProblem(conversation, current, request)) {
        refused = true;
        return;
      }
      const now = new Date().toISOString();
      upsertAppToolApproval(conversation, {
        ...current,
        status: "approved",
        approvalScope: "once",
        memberRemovalQueuedAt: now,
        updatedAt: now
      });
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
      recorded = true;
    });
    if (refused) {
      await refuse();
      return conversation;
    }
    if (recorded) {
      // Indexed only once the decision is stored, so any idle hook that sees
      // the index also finds the stored decision. On a machine the decision
      // waits for the desktop, which receives this card and applies it.
      this.noteQueuedMemberRemoval(conversation.id);
      await this.applyQueuedMemberRemovalsOnce(conversation.id, conversation);
    }
    return conversation;
  }

  noteQueuedMemberRemoval(conversationId: string): void {
    this.queuedMemberRemovalChats.set(conversationId, (this.queuedMemberRemovalChats.get(conversationId) ?? 0) + 1);
    this.memberRemovalRetryAfter.delete(conversationId);
  }

  /** Drops the index only if no removal was recorded since `generation` was
   *  read; a later one keeps it for its own application. */
  private forgetQueuedMemberRemovals(conversationId: string, generation: number): void {
    if (this.queuedMemberRemovalChats.get(conversationId) === generation) {
      this.queuedMemberRemovalChats.delete(conversationId);
    }
  }

  memberRemovalApplyDue(conversationId: string): boolean {
    return this.queuedMemberRemovalChats.has(conversationId) &&
      !this.chat.activeRuns.chatHasLiveWork(conversationId) &&
      (this.memberRemovalRetryAfter.get(conversationId) ?? 0) <= Date.now();
  }

  /** Called whenever a chat may have become idle (see scheduleAutoWatchEvaluation). */
  scheduleQueuedMemberRemovals(conversationId: string): void {
    if (this.memberRemovalApplyDue(conversationId)) {
      void this.applyQueuedMemberRemovalsOnce(conversationId);
    }
  }

  /** One application per chat at a time: idle hooks that arrive meanwhile
   *  ask for one more pass instead of each reading the whole chat. Never
   *  rejects; a failed pass is logged and retried at a later idle moment. */
  applyQueuedMemberRemovalsOnce(
    conversationId: string,
    held?: Conversation,
    options: { afterRestart?: boolean } = {}
  ): Promise<void> {
    const inFlight = this.memberRemovalApplies.get(conversationId);
    if (inFlight) {
      this.memberRemovalApplyAgain.add(conversationId);
      return inFlight;
    }
    const run = (async () => {
      let passHeld = held;
      let passOptions = options;
      try {
        do {
          this.memberRemovalApplyAgain.delete(conversationId);
          await this.applyQueuedMemberRemovals(conversationId, passHeld, passOptions);
          passHeld = undefined;
          passOptions = {};
        } while (this.memberRemovalApplyAgain.has(conversationId));
        this.memberRemovalRetryAfter.delete(conversationId);
      } catch (error) {
        // The decision stays stored; every idle hook would otherwise repeat a
        // failing full read and write of the chat.
        this.memberRemovalRetryAfter.set(conversationId, Date.now() + MEMBER_REMOVAL_RETRY_DELAY_MS);
        void this.deps.debugLogs.write("chat.member-removal.apply-error", {
          conversationId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.memberRemovalApplies.delete(conversationId);
        this.memberRemovalApplyAgain.delete(conversationId);
      }
    })();
    this.memberRemovalApplies.set(conversationId, run);
    return run;
  }

  /** Nothing may be running anywhere in the chat: not here, and not a turn a
   *  machine or another app instance runs for one of its members. */
  private memberRemovalMustWait(conversation: Conversation): boolean {
    return this.chat.members.memberRemovalBlockedByLiveWork(conversation) ||
      this.chat.runOwners.storedMetadataHasProtectedLiveRuns(conversation.metadata) ||
      conversation.messages.some((message) =>
        message.role === "participant" &&
        message.status === "pending" &&
        this.chat.runOwners.isMessageRunProtectedByExternalOwner(conversation, message)
      );
  }

  /** Applies every approved member removal of a chat once nothing runs in it.
   *  A removal that can no longer be made is closed with the reason. */
  private async applyQueuedMemberRemovals(
    conversationId: string,
    held?: Conversation,
    options: { afterRestart?: boolean } = {}
  ): Promise<void> {
    const generation = this.queuedMemberRemovalChats.get(conversationId);
    if (generation === undefined || this.chat.activeRuns.chatHasLiveWork(conversationId)) {
      return;
    }
    if (!options.afterRestart) {
      // Idle hooks fire often (every machine delta, for one); look at the saved
      // copy this process already holds before reading the whole chat. The run
      // that just ended has only queued the save that clears `running`. Never
      // `held`: a turn that ended while the decision was being recorded
      // cleared `running` in storage, not in `held`.
      await this.chat.store.waitForQueuedSave(conversationId);
      const known = (await this.chat.store.readStoredChatStateForRefresh(conversationId)).stored;
      if (!known || known.kind !== "chat" || !chatAppToolApprovals(known).some((approval) => isQueuedMemberRemovalApproval(approval))) {
        this.forgetQueuedMemberRemovals(conversationId, generation);
        return;
      }
      // A turn a machine or another instance runs keeps it waiting too; its
      // end (its reply arriving) is another idle hook.
      if (known.metadata.running === true || this.memberRemovalMustWait(known)) {
        return;
      }
    }
    // After a restart the turn that was running when the app quit is still
    // marked as running; requireChat below sweeps it, exactly as opening the
    // chat does, so that flag is not a reason to wait.
    await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
      if (!this.queuedMemberRemovalChats.has(conversationId) || this.chat.activeRuns.chatHasLiveWork(conversationId)) {
        return;
      }
      // requireChat recovers a run no live process owns any more (the same
      // recovery every chat read does) before the idle check below.
      const conversation = held ?? await this.chat.store.requireChat(conversationId);
      const retired: ChatParticipant[] = [];
      await this.chat.store.withChatMutation(conversation, async () => {
        const queued = chatAppToolApprovals(conversation).filter((approval) => isQueuedMemberRemovalApproval(approval));
        if (queued.length === 0) {
          this.forgetQueuedMemberRemovals(conversationId, generation);
          return;
        }
        if (this.memberRemovalMustWait(conversation)) {
          return;
        }
        const now = new Date().toISOString();
        let answerUnread = false;
        let changed = false;
        for (const approval of queued) {
          const request = approval.request;
          // An error a later answer drew ("already answered") is not this
          // removal's outcome.
          const { memberRemovalQueuedAt: _queuedAt, error: _error, ...decided } = approval;
          const decidedAt = laterThan(approval.updatedAt);
          const refuse = (reason: string): void => {
            upsertAppToolApproval(conversation, { ...decided, status: "cancelled", error: reason, rosterChangeSettledAt: decidedAt, updatedAt: decidedAt });
            pushMemberRemovalFailure(conversation, approval, request, reason);
            changed = true;
          };
          const present = new Set(chatParticipants(conversation).map((participant) => participant.id));
          // A member the User already removed by hand is simply gone.
          const targetIds = request.operations.map((operation) => operation.participantId).filter((id) => present.has(id));
          if (approval.homeMachineId) {
            // A machine member's: applied only for the User's confirmed
            // answer, and only while it is still a valid request here.
            const decision = await machineRosterDecision(conversation, approval);
            if (!decision.ok && decision.waiting) {
              answerUnread = true;
              continue;
            }
            const remaining = { ...request, operations: request.operations.filter((operation) => present.has(operation.participantId)) };
            // One its member's policy allowed: only under this desktop's own
            // rules for that member, exactly as a machine member's addition.
            const requesterHere = chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
            const policyProblem = approval.status === "auto-applied" &&
              (!requesterHere || await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(requesterHere) !== "allow")
              ? `@${approval.requesterHandle} may not make this change without your approval; it can ask again.`
              : undefined;
            const problem = !decision.ok
              ? decision.problem
              : policyProblem ?? machineRosterCardProblem(conversation, undefined, approval) ??
                (remaining.operations.length > 0 ? memberRemovalProblem(conversation, approval, remaining) ?? machineRemovalHandleProblem(conversation, remaining) : undefined);
            if (problem) {
              refuse(problem);
              continue;
            }
          }
          try {
            const removed = targetIds.length > 0 ? this.chat.members.removeParticipantsInMutation(conversation, targetIds, now) : [];
            retired.push(...removed);
            upsertAppToolApproval(conversation, {
              ...decided,
              appliedParticipantIds: removed.map((participant) => participant.id),
              rosterChangeSettledAt: decidedAt,
              updatedAt: decidedAt
            });
            const requester = requesterReference(conversation, approval);
            conversation.messages.push(createChatMessage(
              "system",
              removed.length > 0
                ? `Removed ${formatHandleList(removed.map((participant) => `@${participant.handle}`))} from this chat at ${requester}'s request.`
                : `${memberRemovalHandles(request)} had already left this chat; nothing was removed at ${requester}'s request.`,
              undefined,
              { threadId: "system", rosterChange: { approvalId: approval.id, outcome: "applied", appliedParticipantIds: removed.map((participant) => participant.id) } }
            ));
            changed = true;
          } catch (error) {
            refuse(error instanceof Error ? error.message : String(error));
          }
        }
        if (changed) {
          conversation.updatedAt = now;
          await this.chat.store.saveConversation(conversation);
        }
        // A machine member's removal whose answer is not read yet keeps the
        // chat indexed: the machine's report of it schedules it again.
        if (!answerUnread) this.forgetQueuedMemberRemovals(conversationId, generation);
      });
      this.chat.members.retireRemovedMembers(conversationId, retired);
    });
  }

  /** After a restart nothing of this process runs any more, so decided
   *  removals that were waiting for a turn to end are applied now (a turn
   *  another device still runs keeps them waiting, see memberRemovalMustWait),
   *  and machine members' additions recorded before Д2 are. On the desktop;
   *  a machine resumes only its removals (resumeQueuedMemberRemovals). */
  async resumeQueuedRosterChanges(): Promise<void> {
    const storage = this.deps.storage as Partial<Pick<StorageService, "conversationIdsWithQueuedRosterChanges">>;
    if (typeof storage.conversationIdsWithQueuedRosterChanges !== "function") {
      return;
    }
    const ids = await storage.conversationIdsWithQueuedRosterChanges.call(this.deps.storage);
    for (const conversationId of ids) {
      await this.applyQueuedMemberAdditionsOnce(conversationId);
      this.noteQueuedMemberRemoval(conversationId);
      await this.applyQueuedMemberRemovalsOnce(conversationId, undefined, { afterRestart: true });
    }
  }

  /** On a machine after a restart: its own members' decided removals still
   *  waiting (Д2: the asking member's device makes them). The waiting index
   *  lives only in memory, so without this they would wait forever. */
  async resumeQueuedMemberRemovals(): Promise<void> {
    const storage = this.deps.storage as Partial<Pick<StorageService, "conversationIdsWithQueuedRosterChanges">>;
    if (typeof storage.conversationIdsWithQueuedRosterChanges !== "function") {
      return;
    }
    for (const conversationId of await storage.conversationIdsWithQueuedRosterChanges.call(this.deps.storage)) {
      this.noteQueuedMemberRemoval(conversationId);
      await this.applyQueuedMemberRemovalsOnce(conversationId, undefined, { afterRestart: true });
    }
  }

  /** One pass per chat at a time: calls that arrive meanwhile ask for one
   *  more pass. Never rejects (a failure is logged and the additions stay
   *  recorded for the next card update or restart). */
  private applyQueuedMemberAdditionsOnce(conversationId: string): Promise<void> {
    const inFlight = this.memberAdditionApplies.get(conversationId);
    if (inFlight) {
      this.memberAdditionApplyAgain.add(conversationId);
      return inFlight;
    }
    const run = (async () => {
      try {
        do {
          this.memberAdditionApplyAgain.delete(conversationId);
          await this.applyQueuedMemberAdditions(conversationId);
        } while (this.memberAdditionApplyAgain.has(conversationId));
      } catch (error) {
        void this.deps.debugLogs.write("chat.member-addition.apply-error", {
          conversationId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.memberAdditionApplies.delete(conversationId);
        this.memberAdditionApplyAgain.delete(conversationId);
      }
    })();
    this.memberAdditionApplies.set(conversationId, run);
    return run;
  }

  /** The desktop applies the additions machine members asked for, exactly as
   *  a local member's: the same preparation against this desktop's settings
   *  and the same application, under the same rules (the asking member's
   *  policy here, or the User's confirmed answer). The chat says what
   *  happened only once it has. */
  private async applyQueuedMemberAdditions(conversationId: string): Promise<void> {
    // The saved copy this process holds first: most chats it is asked about
    // (after a restart, say) hold only a waiting removal.
    await this.chat.store.waitForQueuedSave(conversationId);
    const known = (await this.chat.store.readStoredChatStateForRefresh(conversationId)).stored;
    if (!known || known.kind !== "chat" || !chatAppToolApprovals(known).some((approval) => isQueuedMemberAdditionApproval(approval))) {
      this.memberAdditionRetries.delete(conversationId);
      return;
    }
    const conversation = await this.chat.store.requireChat(conversationId).catch(() => undefined);
    if (!conversation) {
      return;
    }
    let answerUnread = false;
    for (const queued of chatAppToolApprovals(conversation).filter((approval) => isQueuedMemberAdditionApproval(approval))) {
      let decision: MachineRosterDecision | undefined;
      if (queued.homeMachineId && queued.status === "approved") {
        decision = await machineRosterDecision(conversation, queued);
        // Not reported or not read yet: the machine's report schedules it
        // again, and so does a short retry.
        if (!decision.ok && decision.waiting) {
          answerUnread = true;
          continue;
        }
      }
      let apply: () => Promise<{ participants: ChatParticipant[]; summary: string; request?: ChatAppToolApprovalRequest; label: string }>;
      let problem = decision && !decision.ok && decision.waiting === false
        ? decision.problem
        : queued.homeMachineId ? machineRosterCardProblem(conversation, undefined, queued) : undefined;
      let handles: string[] = [];
      try {
        if (problem) throw new Error(problem);
        let prepared: { managementEscalation: boolean };
        let additions: ChatParticipant[];
        if (isRoleParticipantChangeRequest(queued.request)) {
          const role = await this.chat.rosterChanges.prepareRoleParticipantChange(conversation, normalizeRoleParticipantChangeRequest(queued.request));
          prepared = role;
          additions = role.participant.participants;
          apply = async () => {
            const applied = await this.chat.rosterChanges.applyPreparedRoleParticipantChange(conversation, role);
            return { participants: applied.participants, summary: applied.summary, request: applied.request, label: "role and member request" };
          };
        } else if (isParticipantChangeRequest(queued.request)) {
          const participant = await this.chat.rosterChanges.prepareParticipantChange(conversation, normalizeParticipantChangeRequest(queued.request));
          prepared = participant;
          additions = participant.participants;
          apply = async () => ({
            participants: await this.chat.rosterChanges.applyPreparedParticipantChange(conversation, participant),
            summary: participant.summary,
            request: participant.request,
            label: "member request"
          });
        } else {
          const roster = await this.chat.rosterChanges.prepareRosterChange(conversation, normalizeRosterChangeRequest(queued.request));
          prepared = roster;
          additions = roster.participants;
          apply = async () => ({ participants: this.chat.rosterChanges.applyPreparedRosterChange(conversation, roster), summary: roster.summary, label: "app tool request" });
        }
        handles = memberAdditionTargets(queued.request).flatMap((target) => target.handle ? [target.handle] : []);
        if (queued.status === "auto-applied" && queued.homeMachineId) {
          // Applied without a card only under this desktop's own rules for
          // the asking member, exactly as its local request would be.
          const requester = chatParticipants(conversation).find((participant) => participant.id === queued.requesterParticipantId)!;
          const manage = await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(requester);
          const policy = queued.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
            matchingAppToolApprovalPolicy(conversation, requester, APP_ROSTER_REQUEST_CHANGE_TOOL, "participants.manage");
          if ((manage !== "allow" && !policy) || prepared.managementEscalation ||
            await this.chat.rosterTools.additionsExceedMainSession(conversation, requester, additions)) {
            throw new Error(`@${requester.handle} may not make this change without your approval; it can ask again.`);
          }
        }
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
        apply = async () => { throw new Error(problem); };
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        const current = chatAppToolApprovals(conversation).find((approval) => approval.id === queued.id);
        if (!current || !isQueuedMemberAdditionApproval(current)) {
          return;
        }
        const now = new Date().toISOString();
        const decidedAt = laterThan(current.updatedAt);
        const { memberAdditionQueuedAt: _queued, error: _error, ...decided } = current;
        const verb = current.status === "auto-applied" ? "Auto-applied" : "Applied";
        const requester = requesterReference(conversation, current);
        try {
          // Prepared before this chat's latest write: a member added since
          // under the same handle is not added twice.
          const taken = new Set(chatParticipants(conversation).map((participant) => participant.handle.replace(/^@/, "").toLowerCase()));
          const clash = handles.find((handle) => taken.has(handle.replace(/^@/, "").toLowerCase()));
          if (clash) throw new Error(`@${clash.replace(/^@/, "")} is already in this chat.`);
          const applied = await apply();
          if (current.status === "auto-applied") {
            markAddedWithoutCard(conversation, applied.participants, current.requesterParticipantId);
          }
          upsertAppToolApproval(conversation, {
            ...decided,
            ...(applied.request ? { request: applied.request } : {}),
            appliedParticipantIds: applied.participants.map((participant) => participant.id),
            rosterChangeSettledAt: decidedAt,
            updatedAt: decidedAt
          });
          conversation.messages.push(createChatMessage("system", `${verb} ${applied.label} from ${requester}: ${applied.summary}.`, undefined, {
            threadId: "system",
            rosterChange: { approvalId: current.id, outcome: "applied", appliedParticipantIds: applied.participants.map((participant) => participant.id) }
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          upsertAppToolApproval(conversation, { ...decided, status: "cancelled", error: message, rosterChangeSettledAt: decidedAt, updatedAt: decidedAt });
          conversation.messages.push(createChatMessage("system", `Could not add ${rosterChangeTargetsText(current)} at ${requester}'s request: ${message}`, undefined, {
            threadId: "system",
            rosterChange: { approvalId: current.id, outcome: "refused", error: message }
          }));
        }
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
      });
    }
    this.retryMemberAdditionsLater(conversationId, answerUnread);
  }

  /** A machine member's approved addition whose answer this desktop could not
   *  read yet is looked at again a few times (the machine's report of it
   *  normally arrives within moments and schedules it anyway). */
  private retryMemberAdditionsLater(conversationId: string, waiting: boolean): void {
    const attempt = this.memberAdditionRetries.get(conversationId) ?? 0;
    if (!waiting || attempt >= MEMBER_ADDITION_RETRY_DELAYS_MS.length) {
      if (!waiting) this.memberAdditionRetries.delete(conversationId);
      return;
    }
    this.memberAdditionRetries.set(conversationId, attempt + 1);
    setTimeout(() => {
      void this.applyQueuedMemberAdditionsOnce(conversationId);
    }, MEMBER_ADDITION_RETRY_DELAYS_MS[attempt]).unref?.();
  }
}
