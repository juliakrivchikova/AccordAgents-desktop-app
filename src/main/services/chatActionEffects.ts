/**
 * What a peer actually does when a decision made somewhere else arrives.
 *
 * Only the peer that holds the pending request acts on it, and only once. The
 * claim is the receipt in the event log, so the guarantee survives a restart
 * as well as a second answer from another device.
 *
 * Built once and shared by the desktop and the machine runtime, so a card
 * answered from the phone is applied the same way wherever the member lives.
 */

import type { ChatActionEffectPort } from "./chatActionApplier";
import type { ChatActionEmitter } from "./chatActionEmitter";
import type { Conversation } from "../../shared/types";

export interface ChatActionEffectChat {
  respondToAppToolApproval(request: {
    conversationId: string;
    approvalId: string;
    approve: boolean;
    scope?: never;
  }): Promise<Conversation | undefined>;
  respondToChoice(request: {
    conversationId: string;
    sourceMessageId: string;
    choiceId: string;
    selectedOptionId?: string;
    customAnswer?: string;
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
}): ChatActionEffectPort {
  return {
    async owns(conversationId, targetKey) {
      const run = /^run:(.+)$/.exec(targetKey);
      if (run) return deps.chat.conversationIdForRun(run[1]) !== undefined;
      const approval = /^approval:(.+)$/.exec(targetKey);
      if (approval) {
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
          approve: detail.approve === true
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
        return "stopped the run";
      }
      throw new Error(`No effect for ${request.kind}.`);
    },

    record(request) {
      return deps.emitter.recordExecution(request);
    }
  };
}
