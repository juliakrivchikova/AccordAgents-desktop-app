import type { UrgentAlertView } from "../../../../shared/urgentAlerts";
import type { ChatMessage } from "../../../../shared/types";
import { chatParticipants } from "../members/identity";
import type { ChatModules } from "../modules";

/** An urgent alert's card as the computer puts it up itself. */
export interface UnsentAlertCard {
  conversationId: string;
  participantId: string;
  messageId: string;
  text: string;
  createdAt: string;
  alert: UrgentAlertView;
}

/**
 * The red card of an urgent alert the User's server could not take, put up
 * on the computer the member runs on (docs/urgent-alerts.md). It is a
 * placeholder: never sent to the server, kept across restarts with the chat,
 * and replaced by the server's own card, which carries the same message id,
 * once the computer raises the alert there.
 */
export class UnsentAlertCards {
  constructor(private readonly chat: Pick<ChatModules, "store" | "serverPlaceholders">) {}

  /** Puts the card up, or changes the one already there; false when the
   *  chat or the member is gone, or the server's card already stands there. */
  async show(card: UnsentAlertCard): Promise<boolean> {
    return this.chat.store.withSavedConversation(card.conversationId, async (conversation) => {
      if (!conversation || conversation.kind !== "chat") return false;
      const participant = chatParticipants(conversation).find((item) => item.id === card.participantId);
      if (!participant) return false;
      const index = conversation.messages.findIndex((message) => message.id === card.messageId);
      const current = index >= 0 ? conversation.messages[index] : undefined;
      if (current && !isUnsentCard(current)) return false;
      const message: ChatMessage = {
        id: card.messageId,
        role: "participant",
        participantId: participant.id,
        participantLabel: `@${participant.handle}`,
        content: card.text,
        createdAt: current?.createdAt ?? card.createdAt,
        status: "done",
        metadata: { serverPlaceholder: true, urgentAlert: card.alert }
      };
      // Saved messages are shared with the saved copy: replaced, never edited.
      if (current) conversation.messages = conversation.messages.map((item, at) => at === index ? message : item);
      else conversation.messages = [...conversation.messages, message];
      await this.chat.store.saveConversation(conversation);
      return true;
    });
  }

  /** Changes the card while it is still this computer's; undefined when it
   *  is not there (the server's card took its place, or the chat is gone). */
  async update(conversationId: string, messageId: string, change: (alert: UrgentAlertView) => UrgentAlertView): Promise<UrgentAlertView | undefined> {
    return this.chat.store.withSavedConversation(conversationId, async (conversation) => {
      if (!conversation || conversation.kind !== "chat") return undefined;
      const index = conversation.messages.findIndex((message) => message.id === messageId);
      const current = index >= 0 ? conversation.messages[index] : undefined;
      if (!current || !isUnsentCard(current)) return undefined;
      const alert = change(current.metadata!.urgentAlert!);
      const next: ChatMessage = { ...current, metadata: { ...current.metadata, urgentAlert: alert } };
      conversation.messages = conversation.messages.map((item, at) => at === index ? next : item);
      await this.chat.store.saveConversation(conversation);
      return alert;
    });
  }

  /** Takes the card down: the server's card, under another id (a server
   *  older than this app), took its place. */
  async remove(conversationId: string, messageId: string): Promise<void> {
    await this.chat.store.withSavedConversation(conversationId, async (conversation) => {
      if (!conversation || conversation.kind !== "chat") return;
      if (!conversation.messages.some((message) => message.id === messageId && isUnsentCard(message))) return;
      // Remembered as gone, so a copy read before (a running turn's) does
      // not bring it back.
      this.chat.serverPlaceholders.removeServerPlaceholders(conversation, (message) => message.id === messageId && isUnsentCard(message));
      await this.chat.store.saveConversation(conversation);
    });
  }
}

/** This computer's own card: a placeholder the server never wrote. */
function isUnsentCard(message: ChatMessage): boolean {
  return message.metadata?.serverPlaceholder === true && message.metadata.serverSeq === undefined && Boolean(message.metadata.urgentAlert);
}
