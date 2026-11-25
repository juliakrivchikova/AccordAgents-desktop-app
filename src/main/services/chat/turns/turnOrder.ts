import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import type { ParticipantTurnReservation } from "../types";

export function isMobileOriginRun(runId: string): boolean {
  return runId.startsWith("mobile-");
}

export function normalizedMobileEventId(value: string | undefined): string | undefined {
  const eventId = value?.trim();
  return eventId || undefined;
}

export function hasMobileEventMessage(conversation: Conversation, mobileEventId: string): boolean {
  return conversation.messages.some((message) =>
    message.role === "user" &&
    message.metadata?.appMessageSource === "mobile-relay" &&
    message.metadata?.mobileEventId === mobileEventId
  );
}

function isMobileRelayTrigger(triggerMessage: ChatMessage, runId: string): boolean {
  return isMobileOriginRun(runId) || triggerMessage.metadata?.appMessageSource === "mobile-relay";
}

export async function waitForParticipantTurnReservation(reservation: ParticipantTurnReservation, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Chat run cancelled.");
  }
  if (!signal) {
    await reservation.wait();
    return;
  }

  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      reservation.wait(),
      new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error("Chat run cancelled."));
        signal.addEventListener("abort", abortListener, { once: true });
      })
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }

  if (signal.aborted) {
    throw new Error("Chat run cancelled.");
  }
}

export function chainParticipantTurn(
  queues: Map<string, Promise<void>>,
  key: string
): { queued: boolean; previousReady: Promise<void>; release: () => void } {
  const previous = queues.get(key);
  const previousTurn = previous ?? Promise.resolve();
  let releaseCurrent!: () => void;
  let released = false;
  let previousTurnSettled = !previous;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const previousReady = previousTurn.catch(() => undefined).then(() => {
    previousTurnSettled = true;
  });
  const chained = previousReady.then(() => current);
  const clearQueueIfTail = (): void => {
    if (queues.get(key) === chained) {
      queues.delete(key);
    }
  };
  queues.set(key, chained);
  return {
    queued: Boolean(previous),
    previousReady,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      releaseCurrent();
      if (previousTurnSettled) {
        clearQueueIfTail();
      } else {
        void chained.finally(clearQueueIfTail);
      }
    }
  };
}

/** As in the dedicated CLI, a suggestion follows a reply to what the User
 *  typed or chose: not a member's request or a reply that failed. */
export function offersPromptSuggestionAfter(
  participant: ChatParticipant,
  triggerMessage: ChatMessage,
  messages: ChatMessage[],
  signal: AbortSignal
): boolean {
  if (participant.kind !== "claude-code" || triggerMessage.role !== "user" || signal.aborted) {
    return false;
  }
  const reply = [...messages].reverse().find((message) => message.role === "participant" && message.participantId === participant.id);
  return reply?.status === "done";
}
