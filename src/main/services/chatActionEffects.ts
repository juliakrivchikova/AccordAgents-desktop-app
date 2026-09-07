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

export function createChatActionEffects(deps: {
  chat: ChatActionEffectChat;
  emitter: Pick<ChatActionEmitter, "beginExecution" | "recordExecution">;
  storage: ChatActionEffectStorage;
  applyApproval?: (event: ChatEventEnvelope, payload: ChatActionPayload) => Promise<MachineApprovalResultBody>;
}): ChatActionEffectPort {
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
        // A choice belongs to the peer that is running the turn that raised it.
        const conversation = await deps.storage.getConversation(conversationId);
        const active = (conversation?.metadata as { activeRunIds?: string[] } | undefined)?.activeRunIds ?? [];
        return active.length > 0;
      }
      return false;
    },

    claim(targetKey) {
      return deps.emitter.beginExecution(targetKey);
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
