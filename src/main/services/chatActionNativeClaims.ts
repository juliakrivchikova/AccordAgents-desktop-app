import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import { chatActionReceiptEventId } from "./chatActionEmitter";
import type { ChatActionNativeClaims, NativeTargetClaim } from "./chatActionEffects";
import type { StorageService } from "./storage";

/**
 * Admission for an answer that wakes something native.
 *
 * An approval already crossed a durable row before its effect. A choice did
 * not: it was admitted by asking whether a receipt event existed, which is a
 * read and not a claim. Two answers arriving together both saw no receipt and
 * both told the provider; a crash between telling it and writing the receipt
 * told it again on the next start. The provider has no idea it was answered
 * twice, and the member acts on the second answer as if it were new.
 *
 * So the same row, in the same table, taken before the effect. What this
 * cannot do is tell whether an effect that has a claim and no receipt reached
 * the provider — nothing can, from here — so that is reported as uncertain and
 * never repeated. Repeating it is the one outcome that is always wrong.
 */
export function createNativeTargetClaims(deps: {
  storage: Pick<StorageService, "nativeCommands" | "getChatEvent">;
  runtimeIdentity(): Promise<NativeRuntimeIdentity>;
  /** False while this runtime is shutting down: an answer stays queued rather
   *  than being half-applied by a process that is going away. */
  canApply?(): boolean;
}): ChatActionNativeClaims {
  return {
    async claimTarget(event: ChatEventEnvelope, targetKey: string, participantId: string): Promise<NativeTargetClaim> {
      const commands = deps.storage.nativeCommands();
      // The receipt is the record that it was carried out here. It outranks
      // everything else: re-projection must not act again.
      if (await deps.storage.getChatEvent(chatActionReceiptEventId(targetKey))) return "already-acted";
      // A claim with no receipt: either this runtime died between the two, or
      // another one is still inside the effect. Neither can be confirmed from
      // here, and both are answered the same way -- not repeated.
      if (await commands.targetEffect(event.conversationId, targetKey)) return "uncertain";
      if (deps.canApply?.() === false) throw new Error("This runtime is shutting down; the answer remains queued.");
      const owner = await deps.runtimeIdentity();
      const claimed = await commands.claimTarget({ ...owner, eventId: event.eventId,
        conversationId: event.conversationId, targetKey, participantId });
      if (!claimed) return "uncertain";
      if (deps.canApply?.() === false) {
        throw new Error("This runtime shut down while recording the claim; the answer was not carried out.");
      }
      return "taken";
    }
  };
}
