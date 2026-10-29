import type { ChatMessage, ChatPendingChoice, ChatServerCardMark } from "../../../shared/types";

/** A card of a member on another device that was answered on the User's
 *  server (here or elsewhere) and that its machine has not applied yet: the
 *  message shows it answered and waiting, never asks again. */
export function chatMessageCards(message: ChatMessage): {
  choice?: ChatPendingChoice;
  choiceAnswered?: ChatServerCardMark;
  mentionAnswered?: ChatServerCardMark;
} {
  const mark = message.metadata?.serverCard?.state === "answered" ? message.metadata.serverCard : undefined;
  const mentionAnswered = mark?.cardId === `mention:${message.id}` ? mark : undefined;
  const choiceAnswered = mark?.cardId === `choice:${message.id}` ? mark : undefined;
  const stored = message.metadata?.pendingChoice;
  if (!stored || !choiceAnswered || stored.status !== "pending") return { choice: stored, mentionAnswered };
  const answer = choiceAnswered.answer;
  const choice: ChatPendingChoice = answer.cancel === true
    ? { ...stored, status: "cancelled" }
    : {
        ...stored,
        status: "selected",
        ...(typeof answer.selectedOptionId === "string" ? { selectedOptionId: answer.selectedOptionId } : {}),
        ...(typeof answer.customAnswer === "string" ? { customAnswer: answer.customAnswer } : {}),
        ...(typeof answer.note === "string" ? { note: answer.note } : {})
      };
  return { choice, choiceAnswered, mentionAnswered };
}
