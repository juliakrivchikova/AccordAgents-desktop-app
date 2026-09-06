import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { MachineApprovalDecisionBody, MachineApprovalResultBody } from "../../shared/machineLink";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import type { ChatAppToolApproval, ChatAppToolApprovalPolicy, Conversation } from "../../shared/types";
import type { ChatService } from "./chat";
import type { StorageService } from "./storage";
import { verifyNativeExecutorGone } from "./nativeExecutorRecovery";

export function machineApprovalResultId(decisionId: string): string { return `machine-approval-result:${decisionId}`; }

/** The event delivery may retry; the approved native effect may not. Domain
 * validation runs before the SQL claim, and a native decision waits for the
 * provider adapter's delivery receipt before success is published. */
export class MachineApprovalExecutor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly results = new Map<string, MachineApprovalResultBody>();
  private readonly outcomes = new Map<string, Pick<MachineApprovalResultBody, "ok" | "error" | "uncertain">>();

  constructor(private readonly options: {
    storage: StorageService;
    deviceId: string;
    chat: Pick<ChatService, "respondToAppToolApproval">;
    getConversation(id: string): Promise<Conversation | undefined>;
    runtimeIdentity(): Promise<NativeRuntimeIdentity>;
    canApply?: () => boolean;
    nativeProcessDbPath?: string;
    publish(body: MachineApprovalResultBody): Promise<void>;
  }) {}

  hasActiveWork(): boolean { return this.active.size > 0; }

  private async hasResult(decisionId: string, conversationId: string, approvalId: string): Promise<boolean> {
    const event = await this.options.storage.getChatEvent(machineApprovalResultId(decisionId));
    if (!event) return false;
    if (event.originId !== this.options.deviceId || event.kind !== "machine.approval.result" || event.conversationId !== conversationId) {
      throw new Error("The retained approval receipt has inconsistent ownership.");
    }
    const body = await this.options.storage.deviceEventBlobs().hydrate(event.payload) as Partial<MachineApprovalResultBody>;
    if (body?.type !== event.kind || body.conversationId !== conversationId || body.approvalId !== approvalId || body.decisionId !== decisionId || typeof body.ok !== "boolean") {
      throw new Error("The retained approval receipt has inconsistent identities.");
    }
    return true;
  }

  apply(event: ChatEventEnvelope, decision: MachineApprovalDecisionBody): Promise<void> {
    const current = this.active.get(event.eventId);
    if (current) return current;
    const work = this.applyOnce(event, decision);
    this.active.set(event.eventId, work);
    void work.finally(() => this.active.delete(event.eventId)).catch(() => undefined);
    return work;
  }

  private async applyOnce(event: ChatEventEnvelope, decision: MachineApprovalDecisionBody): Promise<void> {
    if (!decision.decisionId || decision.decisionId !== event.eventId || event.kind !== decision.type || event.conversationId !== decision.conversationId) {
      throw new Error("The approval decision has inconsistent identities.");
    }
    const { storage } = this.options;
    if (await this.hasResult(event.eventId, decision.conversationId, decision.approvalId)) return;
    const retained = this.results.get(event.eventId);
    if (retained) {
      await this.options.publish(retained);
      this.results.delete(event.eventId);
      this.outcomes.delete(event.eventId);
      return;
    }
    const owner = await this.options.runtimeIdentity();
    const previous = await storage.nativeCommands().approvalEffect(decision.conversationId, decision.approvalId);
    let result: Pick<MachineApprovalResultBody, "ok" | "error" | "uncertain">;
    const knownOutcome = this.outcomes.get(event.eventId);
    if (knownOutcome) result = knownOutcome;
    else if (previous && await this.hasResult(previous.eventId, decision.conversationId, decision.approvalId)) {
      result = { ok: false, error: "This approval has already been answered; its earlier execution receipt is unchanged." };
    } else if (previous) {
      if (previous.runtimeId !== owner.runtimeId && (!this.options.nativeProcessDbPath || !await verifyNativeExecutorGone({
        ...previous, generation: 0, released: false
      }, this.options.nativeProcessDbPath))) {
        throw new Error("Waiting for the previous approval executor's verified shutdown.");
      }
      result = { ok: false, uncertain: true, error: "This approval already crossed its execution boundary; delivery was not confirmed and the action was not repeated." };
    } else {
      let claimFailure: unknown;
      let claimed = false;
      try {
        const conversation = await this.options.chat.respondToAppToolApproval({
          conversationId: decision.conversationId, approvalId: decision.approvalId,
          approve: decision.approve, scope: decision.scope, draftOverride: decision.draftOverride, codexDecisionId: decision.codexDecisionId
        }, undefined, {
          awaitNativeDelivery: true,
          beforeApply: async (approval) => {
            try {
              if (this.options.canApply?.() === false) throw new Error("The machine is shutting down; this decision remains queued.");
              if (approval.homeMachineId) throw new Error("This approval is owned by another machine.");
              claimed = await storage.nativeCommands().claimApproval({ ...owner, eventId: event.eventId,
                conversationId: decision.conversationId, approvalId: decision.approvalId, participantId: approval.requesterParticipantId });
              if (!claimed) throw new Error("Another executor claimed this approval; waiting for its receipt.");
              if (this.options.canApply?.() === false) throw new Error("The machine shut down while recording the approval claim; native input was not repeated.");
            } catch (error) { claimFailure = error; throw error; }
          }
        });
        if (!conversation) throw new Error("The approval's conversation no longer exists.");
        result = { ok: true };
      } catch (error) {
        // A failed pre-effect disk claim is retryable. Do not manufacture a
        // terminal rejection and silently lose a valid User decision.
        if (claimFailure) throw claimFailure;
        result = { ok: false, ...(claimed ? { uncertain: true } : {}), error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.outcomes.set(event.eventId, result);
    const conversation = await this.options.getConversation(decision.conversationId);
    const metadata = conversation?.metadata as { pendingAppToolApprovals?: ChatAppToolApproval[]; appToolApprovalPolicies?: ChatAppToolApprovalPolicy[] } | undefined;
    const approval = metadata?.pendingAppToolApprovals?.find(item => item.id === decision.approvalId);
    const body: MachineApprovalResultBody = {
      type: "machine.approval.result", conversationId: decision.conversationId, approvalId: decision.approvalId,
      decisionId: event.eventId, ...result, ...(approval ? { approval } : {}),
      ...(metadata?.appToolApprovalPolicies ? { policies: metadata.appToolApprovalPolicies } : {})
    };
    this.results.set(event.eventId, body);
    await this.options.publish(body);
    this.results.delete(event.eventId);
    this.outcomes.delete(event.eventId);
  }
}
