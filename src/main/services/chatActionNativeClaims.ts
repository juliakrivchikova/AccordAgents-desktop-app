import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import type { ChatActionPayload } from "../../shared/chatActionEvents";
import type { MachineChoiceResultBody } from "../../shared/machineLink";
import type { RespondToChatChoiceRequest, ReviewProgress } from "../../shared/types";
import { ChatChoicePersistenceError, type ChatService } from "./chat";
import type { StorageService } from "./storage";
import { verifyNativeExecutorGone } from "./nativeExecutorRecovery";

export function machineChoiceResultId(decisionId: string): string { return `machine-choice-result:${decisionId}`; }

/** The signed answer is the command. The domain saves its validated selection
 * before claiming native continuation; a receipt failure retries publication,
 * never the continuation. Concurrent answers wait for the target's outcome. */
export class MachineChoiceExecutor {
  private readonly active = new Map<string, Promise<MachineChoiceResultBody>>();
  private readonly targets = new Map<string, Promise<unknown>>();
  private readonly retained = new Map<string, MachineChoiceResultBody>();

  constructor(private readonly options: {
    storage: StorageService;
    deviceId: string;
    chat: Pick<ChatService, "respondToChoice">;
    progress?: (progress: ReviewProgress, conversationId: string) => void;
    runtimeIdentity(): Promise<NativeRuntimeIdentity>;
    canApply?(): boolean;
    nativeProcessDbPath?: string;
    publish(body: MachineChoiceResultBody): Promise<void>;
  }) {}

  hasActiveWork(): boolean { return this.active.size > 0 || this.retained.size > 0; }

  private async result(decisionId: string, conversationId: string, choiceId: string): Promise<MachineChoiceResultBody | undefined> {
    const event = await this.options.storage.getChatEvent(machineChoiceResultId(decisionId));
    if (!event) return undefined;
    const body = await this.options.storage.deviceEventBlobs().hydrate(event.payload) as MachineChoiceResultBody;
    if (event.originId !== this.options.deviceId || event.kind !== "machine.choice.result" || event.conversationId !== conversationId ||
        body?.type !== event.kind || body.conversationId !== conversationId || body.choiceId !== choiceId || body.decisionId !== decisionId || typeof body.ok !== "boolean") {
      throw new Error("The retained choice result has inconsistent identities or ownership.");
    }
    return body;
  }

  applyAction(event: ChatEventEnvelope, payload: ChatActionPayload): Promise<MachineChoiceResultBody> {
    const detail = payload.detail;
    if (event.kind !== "choice.answered" || !payload.targetKey?.startsWith("choice:") || !payload.targetKey.slice(7) ||
        !detail || typeof detail.sourceMessageId !== "string" || !detail.sourceMessageId) {
      throw new Error("The choice action has invalid identities.");
    }
    const current = this.active.get(event.eventId);
    if (current) return current;
    const target = JSON.stringify([event.conversationId, payload.targetKey]);
    const previous = this.targets.get(target) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.applyOnce(event, payload));
    this.targets.set(target, work);
    this.active.set(event.eventId, work);
    void work.finally(() => {
      this.active.delete(event.eventId);
      if (this.targets.get(target) === work) this.targets.delete(target);
    }).catch(() => undefined);
    return work;
  }

  private async publish(body: MachineChoiceResultBody): Promise<MachineChoiceResultBody> {
    this.retained.set(body.decisionId, body);
    await this.options.publish(body);
    this.retained.delete(body.decisionId);
    return body;
  }

  private async applyOnce(event: ChatEventEnvelope, payload: ChatActionPayload): Promise<MachineChoiceResultBody> {
    const choiceId = payload.targetKey.slice(7);
    const detail = payload.detail!;
    const saved = await this.result(event.eventId, event.conversationId, choiceId);
    if (saved) return saved;
    const retained = this.retained.get(event.eventId);
    if (retained) return this.publish(retained);
    const base = { type: "machine.choice.result" as const, conversationId: event.conversationId,
      choiceId, sourceMessageId: detail.sourceMessageId as string, decisionId: event.eventId };
    const owner = await this.options.runtimeIdentity();
    const commands = this.options.storage.nativeCommands();
    const previous = await commands.targetEffect(event.conversationId, payload.targetKey);
    if (previous) {
      const pendingResult = this.retained.get(previous.eventId);
      if (pendingResult) await this.publish(pendingResult);
      const prior = await this.result(previous.eventId, event.conversationId, choiceId);
      if (prior) return this.publish({ ...base, ok: false, choice: prior.choice,
        error: "This choice has already been answered; its earlier outcome stands." });
      if (previous.runtimeId !== owner.runtimeId && this.options.nativeProcessDbPath && !await verifyNativeExecutorGone({
        ...previous, generation: 0, released: false
      }, this.options.nativeProcessDbPath)) {
        throw new Error("Waiting for the previous choice executor's verified shutdown.");
      }
      return this.publish({ ...base, ok: false, uncertain: true,
        error: "This answer crossed its execution boundary; continuation was not confirmed and was not repeated." });
    }
    const request: RespondToChatChoiceRequest = {
      conversationId: event.conversationId, sourceMessageId: base.sourceMessageId, choiceId,
      runId: `choice-response:${event.eventId}`,
      ...(typeof detail.selectedOptionId === "string" ? { selectedOptionId: detail.selectedOptionId } : {}),
      ...(typeof detail.customAnswer === "string" ? { customAnswer: detail.customAnswer } : {}),
      ...(typeof detail.note === "string" ? { note: detail.note } : {}), ...(detail.cancel === true ? { cancel: true } : {})
    };
    let claimFailure: unknown;
    let claimed = false;
    let body: MachineChoiceResultBody;
    try {
      if (this.options.canApply?.() === false) throw new ChatChoicePersistenceError("The machine is shutting down; this answer remains queued.");
      const result = await this.options.chat.respondToChoice(request, undefined, progress => this.options.progress?.(progress, event.conversationId), {
        decisionEventId: event.eventId,
        beforeApply: async participantId => {
          try {
            if (this.options.canApply?.() === false) throw new Error("The machine is shutting down; this answer remains queued.");
            claimed = await commands.claimTarget({ ...owner, eventId: event.eventId, conversationId: event.conversationId,
              targetKey: payload.targetKey, participantId });
            if (!claimed) throw new Error("Another executor claimed this choice; waiting for its result.");
            if (this.options.canApply?.() === false) throw new Error("The machine shut down after claiming this answer; continuation was not confirmed.");
          } catch (error) { claimFailure = error; throw error; }
        }
      });
      body = { ...base, ok: true,
        choice: result.conversation.messages.find(message => message.id === base.sourceMessageId)?.metadata?.pendingChoice };
    } catch (error) {
      if (error instanceof ChatChoicePersistenceError || (claimFailure && !claimed)) throw error;
      body = { ...base, ok: false, ...(claimed ? { uncertain: true } : {}), error: error instanceof Error ? error.message : String(error) };
    }
    return this.publish(body);
  }
}
