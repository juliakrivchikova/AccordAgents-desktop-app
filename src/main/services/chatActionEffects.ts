/**
 * What a peer actually does when a decision made somewhere else arrives.
 *
 * Only the peer that holds the request acts on it. Native approvals claim the
 * shared execution ledger before applying and keep their result for retries;
 * an event-log receipt by itself is not an execution lock.
 *
 * Built once and shared by the desktop and the machine runtime, so a card
 * answered from the phone is applied the same way wherever the member lives.
 */

import type { ChatActionEffectPort } from "./chatActionApplier";
import type { ChatActionEmitter } from "./chatActionEmitter";
import type { Conversation, RespondToChatAppToolApprovalRequest } from "../../shared/types";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatActionPayload } from "../../shared/chatActionEvents";
import type { MachineApprovalResultBody } from "../../shared/machineLink";

export interface ChatActionEffectChat {
  ownsAppToolApproval?(conversationId: string, approvalId: string): Promise<boolean | undefined>;
  respondToAppToolApproval(request: RespondToChatAppToolApprovalRequest): Promise<Conversation | undefined>;
  respondToChoice(request: {
    conversationId: string;
    sourceMessageId: string;
    choiceId: string;
    selectedOptionId?: string;
    customAnswer?: string;
    note?: string;
    cancel?: boolean;
  }): Promise<unknown>;
  cancelRun(runId: string): boolean;
  conversationIdForRun(runId: string): string | undefined;
}

export interface ChatActionEffectStorage {
  getConversation(conversationId: string): Promise<Conversation | undefined>;
}

/**
 * The durable boundary an answer with a native effect crosses.
 *
 * "taken" means this runtime may act. "already-acted" means someone else did
 * and its outcome stands. "uncertain" means a claim exists with no receipt --
 * the effect may or may not have reached the provider, and repeating it is the
 * one thing that must not happen.
 */
export type NativeTargetClaim = "taken" | "already-acted" | "uncertain";

export interface ChatActionNativeClaims {
  claimTarget(event: ChatEventEnvelope, targetKey: string, participantId: string): Promise<NativeTargetClaim>;
}

export function createChatActionEffects(deps: {
  chat: ChatActionEffectChat;
  emitter: Pick<ChatActionEmitter, "beginExecution" | "recordExecution">;
  storage: ChatActionEffectStorage;
  applyApproval?: (event: ChatEventEnvelope, payload: ChatActionPayload) => Promise<MachineApprovalResultBody>;
  /** Absent only where nothing native can be reached; then a receipt lookup is
   *  all there is, and that is stated rather than assumed to be a lock. */
  nativeClaims?: ChatActionNativeClaims;
  /** This machine's enrolled id, on a machine runtime; absent on a desktop.
   *  A member with no home machine lives on the desktop, so the two answer the
   *  same question from opposite sides without either guessing. */
  homeMachineId?: () => string | undefined;
}): ChatActionEffectPort {
  const ownsMember = (conversation: Conversation | undefined, participantId: string | undefined): boolean => {
    if (!participantId) return false;
    const participants = (conversation?.metadata as { participants?: Array<{ id: string; homeMachineId?: string }> } | undefined)
      ?.participants ?? [];
    const participant = participants.find((item) => item.id === participantId);
    if (!participant) return false;
    return (participant.homeMachineId ?? undefined) === (deps.homeMachineId?.() ?? undefined);
  };
  return {
    ...(deps.applyApproval ? { applyApproval: async (event: ChatEventEnvelope, payload: ChatActionPayload) => {
      const result = await deps.applyApproval!(event, payload);
      const effect = result.ok ? `${payload.detail?.approve === true ? "allowed" : "denied"} the app tool request`
        : result.error ?? "The approval's application was not confirmed.";
      if ((result.ok || result.uncertain) && await deps.emitter.beginExecution(payload.targetKey)) {
        await deps.emitter.recordExecution({ conversationId: event.conversationId, targetKey: payload.targetKey,
          effect, ...(result.uncertain ? { uncertain: true } : {}) });
      }
      return effect;
    } } : {}),
    async owns(conversationId, targetKey) {
      const run = /^run:(.+)$/.exec(targetKey);
      if (run) return deps.chat.conversationIdForRun(run[1]) !== undefined;
      const approval = /^approval:(.+)$/.exec(targetKey);
      if (approval) {
        if (deps.chat.ownsAppToolApproval) return deps.chat.ownsAppToolApproval(conversationId, approval[1]);
        const conversation = await deps.storage.getConversation(conversationId);
        const pending = (conversation?.metadata as { pendingAppToolApprovals?: Array<{ id: string; status: string }> } | undefined)
          ?.pendingAppToolApprovals ?? [];
        return pending.some((entry) => entry.id === approval[1] && entry.status === "pending");
      }
      const choice = /^choice:(.+)$/.exec(targetKey);
      if (choice) {
        // A choice belongs to the peer the member lives on. Any active run in
        // the chat used to be enough, so a copy with unrelated work in flight
        // claimed answers it did not own. Tying it to the run that raised it is
        // wrong in the other direction: the User answers after the turn has
        // ended, when that run is no longer anywhere.
        const conversation = await deps.storage.getConversation(conversationId);
        const message = (conversation?.messages ?? []).find((item) => item.metadata?.pendingChoice?.id === choice[1]);
        if (!message) return undefined;
        return ownsMember(conversation, message.participantId);
      }
      return false;
    },

    async claim(targetKey, event) {
      const choice = /^choice:(.+)$/.exec(targetKey);
      if (!choice || !deps.nativeClaims || !event) return deps.emitter.beginExecution(targetKey);

      // The same admission an approval takes, for the same reason: the answer
      // wakes a native request that is waiting, and that can happen once.
      const conversation = await deps.storage.getConversation(event.conversationId);
      const message = (conversation?.messages ?? []).find((item) => item.metadata?.pendingChoice?.id === choice[1]);
      const participantId = message?.participantId ?? "";
      // Not knowing whose request this is means not being able to claim it.
      // Returning false here would tell the User it had already been acted on,
      // which is a different and untrue thing.
      if (!participantId) throw new Error("This answer's request has no member to claim it against.");
      const outcome = await deps.nativeClaims.claimTarget(event, targetKey, participantId);
      if (outcome === "taken") return true;
      if (outcome === "uncertain") return { uncertain: true,
        detail: "This answer already crossed its execution boundary; delivery was not confirmed and it was not repeated." };
      return false;
    },

    async perform(request) {
      const detail = (request.payload.detail ?? {}) as Record<string, unknown>;
      if (request.kind === "permission.decided") {
        const approvalId = request.targetKey.replace(/^approval:/, "");
        await deps.chat.respondToAppToolApproval({
          conversationId: request.conversationId,
          approvalId,
          approve: detail.approve === true,
          ...(detail.scope === "once" || detail.scope === "chat" ? { scope: detail.scope } : {}),
          ...(typeof detail.codexDecisionId === "string" ? { codexDecisionId: detail.codexDecisionId }
            : typeof detail.decisionId === "string" ? { codexDecisionId: detail.decisionId } : {}),
          ...(detail.draftOverride && typeof detail.draftOverride === "object"
            ? { draftOverride: detail.draftOverride as RespondToChatAppToolApprovalRequest["draftOverride"] } : {})
        });
        return `${detail.approve === true ? "allowed" : "denied"} the app tool request`;
      }
      if (request.kind === "choice.answered") {
        const choiceId = request.targetKey.replace(/^choice:/, "");
        await deps.chat.respondToChoice({
          conversationId: request.conversationId,
          sourceMessageId: typeof detail.sourceMessageId === "string" ? detail.sourceMessageId : "",
          choiceId,
          ...(typeof detail.selectedOptionId === "string" ? { selectedOptionId: detail.selectedOptionId } : {}),
          ...(typeof detail.customAnswer === "string" ? { customAnswer: detail.customAnswer } : {}),
          ...(typeof detail.note === "string" ? { note: detail.note } : {}),
          ...(detail.cancel === true ? { cancel: true } : {})
        });
        return detail.cancel === true ? "cancelled the choice" : "answered the choice";
      }
      if (request.kind === "turn.stop.requested") {
        const runId = request.targetKey.replace(/^run:/, "");
        const stopped = deps.chat.cancelRun(runId);
        // Honest either way: a Stop the runtime could not confirm is recorded
        // as uncertain rather than as a completed stop.
        if (!stopped) throw new Error("The run is no longer active here.");
        // cancelRun only requests cancellation. Native closure is confirmed
        // asynchronously by the run owner and its terminal result.
        return "requested the run to stop";
      }
      throw new Error(`No effect for ${request.kind}.`);
    },

    record(request) {
      return deps.emitter.recordExecution(request);
    }
  };
}
