import type { HubCard } from "../../shared/hubOps";
import { isHubApprovalCardAnswer } from "../../shared/hubCards";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import type { ReviewProgress } from "../../shared/types";
import type { ChatService } from "./chat";
import type { StorageService } from "./storage";
import { verifyNativeExecutorGone } from "./nativeExecutorRecovery";
import { approvalInstallsScriptCode } from "../../shared/scripts";

/** The answer a card got, as the native ledger names it: one card answer,
 *  whichever device gave it and however often it is read. */
export function cardAnswerKey(card: Pick<HubCard, "cardId" | "answeredAt">): string {
  return `card-answer:${card.cardId}:${card.answeredAt ?? ""}`;
}

/**
 * What applying a card's answer came to on the member's device:
 * - `applied`: it was applied (or the request was resolved by it);
 * - `refused`: not applied and nothing was claimed; what it asked still
 *   waits, so the card is asked again (`reason` says why);
 * - `uncertain`: it crossed the point of no return without this device
 *   seeing it through; it is never repeated;
 * - `retry`: this device cannot take it right now (it is stopping, its disk
 *   refused the claim); the answer stays and is tried again.
 */
export type CardApplyResult =
  | { kind: "applied" }
  | { kind: "refused"; reason: string }
  | { kind: "uncertain"; reason: string }
  | { kind: "retry"; reason: string };

export class CardRetryError extends Error {}

/** A script that installs code is approved only where its code is shown. */
export const SCRIPT_CODE_APPROVED_ON_DESKTOP = "A script that runs code is approved on the desktop, where its code is shown.";

/**
 * Applies the User's answer to a permission or roster card, raised by this
 * device for one of its members, exactly once (agreement Д9). The answer
 * arrives from the User's server (from any device); domain validation runs
 * before the durable claim, and a native decision waits for the provider's
 * delivery receipt before it counts as applied. A claim without a confirmed
 * outcome (this device stopped in between) is reported as uncertain and
 * never repeated.
 */
export class MachineApprovalExecutor {
  private readonly active = new Map<string, Promise<CardApplyResult>>();
  /** Outcomes this runtime saw through, by answer: a second look (the feed
   *  and a reconcile reach the same answer) reports the same. */
  private readonly outcomes = new Map<string, CardApplyResult>();

  constructor(private readonly options: {
    storage: StorageService;
    chat: Pick<ChatService, "respondToAppToolApproval">;
    progress?: (progress: ReviewProgress, conversationId: string) => void;
    runtimeIdentity(): Promise<NativeRuntimeIdentity>;
    canApply?: () => boolean;
    nativeProcessDbPath?: string;
    /** The device whose card shows a script's code (this desktop on a
     *  desktop, the desktop that set it up on a machine): only its answers
     *  approve a script that installs code. */
    codeApprover: () => string | undefined;
  }) {}

  hasActiveWork(): boolean { return this.active.size > 0; }

  apply(card: HubCard): Promise<CardApplyResult> {
    const key = cardAnswerKey(card);
    const current = this.active.get(key);
    if (current) return current;
    const work = this.applyOnce(card, key);
    this.active.set(key, work);
    void work.finally(() => this.active.delete(key)).catch(() => undefined);
    return work;
  }

  private async applyOnce(card: HubCard, key: string): Promise<CardApplyResult> {
    const known = this.outcomes.get(key);
    if (known) return known;
    const answer = card.answer;
    if (card.state === "pending" || !card.answeredAt || !isHubApprovalCardAnswer(answer)) {
      return { kind: "refused", reason: "This answer is not one this card takes." };
    }
    const { storage } = this.options;
    const conversationId = card.conversationId;
    const approvalId = card.cardId;
    const owner = await this.options.runtimeIdentity();
    const previous = await storage.nativeCommands().approvalEffect(conversationId, approvalId);
    if (previous) {
      if (previous.eventId !== key) {
        // Another answer crossed the boundary before this one: what it did
        // stands; this answer is not applied.
        return { kind: "refused", reason: "This approval has already been answered; its earlier execution stands." };
      }
      if (previous.runtimeId !== owner.runtimeId && this.options.nativeProcessDbPath && !await verifyNativeExecutorGone({
        ...previous, generation: 0, released: false
      }, this.options.nativeProcessDbPath)) {
        return { kind: "retry", reason: "Waiting for the previous approval executor's verified shutdown." };
      }
      return this.remember(key, { kind: "uncertain", reason: "This approval already crossed its execution boundary; delivery was not confirmed and the action was not repeated." });
    }
    let claimFailure: unknown;
    let claimed = false;
    try {
      const conversation = await this.options.chat.respondToAppToolApproval({
        conversationId, approvalId, approve: answer.approve,
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.draftOverride ? { draftOverride: answer.draftOverride } : {}),
        ...(answer.codexDecisionId ? { codexDecisionId: answer.codexDecisionId } : {})
      }, (progress) => this.options.progress?.(progress, conversationId), {
        awaitNativeDelivery: true,
        beforeApply: async (approval) => {
          // A phone (or any device but the one that shows the code) cannot
          // approve code it never showed: refused, nothing claimed, the card
          // is asked again for the desktop.
          if (answer.approve && approvalInstallsScriptCode(approval) && card.answeredBy !== this.options.codeApprover()) {
            throw new Error(SCRIPT_CODE_APPROVED_ON_DESKTOP);
          }
          try {
            if (this.options.canApply?.() === false) throw new CardRetryError("This machine is shutting down; the answer waits for its next start.");
            claimed = await storage.nativeCommands().claimApproval({ ...owner, eventId: key, conversationId, approvalId,
              participantId: approval.requesterParticipantId });
            if (!claimed) throw new CardRetryError("Another executor claimed this approval; waiting for its outcome.");
            if (this.options.canApply?.() === false) throw new Error("The machine shut down while recording the approval claim; native input was not repeated.");
          } catch (error) { claimFailure = error; throw error; }
        }
      });
      if (!conversation) return { kind: "refused", reason: "The approval's chat no longer exists." };
      return this.remember(key, { kind: "applied" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A failed admission (a runtime on its way out, a disk that refused
      // the claim) never manufactures an outcome for a real answer.
      if (claimFailure && !claimed) return { kind: "retry", reason };
      if (claimed) return this.remember(key, { kind: "uncertain", reason });
      return { kind: "refused", reason };
    }
  }

  private remember(key: string, result: CardApplyResult): CardApplyResult {
    this.outcomes.set(key, result);
    while (this.outcomes.size > 500) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return result;
  }
}
