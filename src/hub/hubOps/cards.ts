import { approvedMessageId, keptApproval } from "../hubMachineScope";
import type { HubDevice } from "../../shared/hubProtocol";
import { HUB_CARD_ANSWERED_FIRST } from "../../shared/hubCards";
import type { HubCard, HubFeedEntry, HubOp, HubOpEffect, HubOpResult } from "../../shared/hubOps";
import { contentHash, homeDeviceId, reject } from "./chatRecords";
import type { Outcome } from "./types";
import type { HubOpsModules } from "./modules";
import type { HubOpsDependencies } from "./dependencies";

/** Cards the User answers. */
export class Cards {
  constructor(
    private readonly ops: Pick<HubOpsModules, "chatCache">,
    private readonly deps: Pick<HubOpsDependencies, "storage">
  ) {}

  /** Cards a member waits on (Д9): raised by the device the member runs on,
   *  answered once from any device, settled by the device that raised it. */
  async applyCard(
    device: HubDevice,
    op: Extract<HubOp, { kind: "card.raise" | "card.answer" | "card.settle" }>,
    devices: HubDevice[],
    place: { opId: string; seq: number; acceptedAt: string }
  ): Promise<Outcome> {
    const { opId, seq, acceptedAt } = place;
    const store = this.deps.storage.hubOps();
    const conversation = await this.ops.chatCache.load(op.conversationId);
    if (!conversation) return reject(opId, "There is no such chat.");
    const current = await store.card(op.cardId);
    if (current && current.conversationId !== op.conversationId) return reject(opId, "This card belongs to another chat.");
    const placeCard = async (card: HubCard, alsoSql = ""): Promise<Outcome> => {
      const effect: HubOpEffect = { kind: op.kind, card } as HubOpEffect;
      const result: HubOpResult = { opId, status: "accepted", seq, card };
      const entry: HubFeedEntry = { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect };
      await store.execute(`${store.cardSql(card)} ${alsoSql} ${store.insertSql({ ...entry, kind: op.kind, result })}`);
      return { result, applied: { deviceId: device.deviceId, entry, conversation } };
    };
    if (op.kind === "card.raise") {
      // A card always names its member, and only the device that member
      // runs on raises it (Д4): a copy of the chat never does.
      if (!op.participantId) return reject(opId, "A card names its member.");
      const home = homeDeviceId(conversation, op.participantId, devices);
      if (home !== device.deviceId) return reject(opId, "Only the device this member runs on raises its cards.");
      if (current && current.raisedBy !== device.deviceId) return reject(opId, "Another device raised this card.");
      if (current && (current.participantId !== op.participantId || current.cardKind !== op.cardKind)) return reject(opId, "A card keeps its member and its kind.");
      // Answered: the answer stands until its device settles it; what the
      // card shows does not change under it.
      if (current && current.state === "answered") return { result: { opId, status: "accepted", seq: seq - 1, card: current } };
      // Settled and raised again by its device: the member waits on it again
      // (its device could not apply the answer it got, and said why when it
      // settled it), so it is asked again, from the start.
      return placeCard({
        cardId: op.cardId, conversationId: op.conversationId, cardKind: op.cardKind, participantId: op.participantId,
        ...(op.messageId ? { messageId: op.messageId } : {}),
        raisedBy: device.deviceId, raisedAt: current?.raisedAt ?? acceptedAt, card: op.card, state: "pending"
      });
    }
    if (!current) return reject(opId, "There is no such card.");
    if (op.kind === "card.answer") {
      if (current.state !== "pending") return reject(opId, "This card was already answered.");
      // The User answers from her computer or her phones (Д2). A machine shows
      // her nothing to answer: it only says that its own member's policy
      // allowed what one of its cards asks (`auto`).
      if (device.role === "machine" && (current.raisedBy !== device.deviceId || (op.answer as { auto?: unknown }).auto !== true)) {
        return reject(opId, "A machine does not answer for the User.");
      }
      const answered: HubCard = { ...current, state: "answered", answer: op.answer, answeredBy: device.deviceId, answeredAt: acceptedAt, answerOpId: opId };
      // What she approves on a machine's card is kept as she saw it, with the
      // request it approved as it read then: the machine is held to it after
      // the card is settled or asked again (hubMachineScope.ts). Her new
      // answer to a card replaces what she approved on it before.
      let kept = "";
      if (device.role !== "machine" && devices.some((item) => item.role === "machine" && item.deviceId === current.raisedBy)) {
        kept = store.supersedeApprovalsSql(op.conversationId, current.cardId, acceptedAt);
        if ((op.answer as { approve?: unknown }).approve === true && (op.answer as { auto?: unknown }).auto !== true) {
          const messageId = approvedMessageId(answered);
          const message = messageId ? conversation.messages.find((item) => item.id === messageId) : undefined;
          const slim = keptApproval(answered);
          if (slim) kept += store.userApprovalSql(slim, message ? contentHash(message.content) : undefined);
        }
      }
      return placeCard(answered, kept);
    }
    if (current.raisedBy !== device.deviceId) return reject(opId, "Only the device that raised this card settles it.");
    if (current.state === "settled") return { result: { opId, status: "accepted", seq: seq - 1, card: current } };
    // Closed with no answer (a choice that expired) only while nobody answered
    // it: an answer that got here first is applied by that device instead.
    if ((op.outcome as { unanswered?: unknown }).unanswered === true && current.state === "answered") {
      return reject(opId, HUB_CARD_ANSWERED_FIRST);
    }
    // A settle that says which answer it is about settles only that answer:
    // one sent for an earlier answer never closes the card asked again since.
    const forAnswer = (op.outcome as { answerOpId?: unknown }).answerOpId;
    if (typeof forAnswer === "string" && forAnswer && forAnswer !== current.answerOpId) {
      return reject(opId, "This card's answer is not the one this settles.");
    }
    return placeCard({ ...current, state: "settled", outcome: op.outcome, settledAt: acceptedAt });
  }

  /** Cards not settled yet. */
  async openCards(conversationId?: string): Promise<HubCard[]> {
    return this.deps.storage.hubOps().openCards(conversationId);
  }
}
