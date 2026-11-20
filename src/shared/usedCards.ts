import type { ChatPendingChoice } from "./types";

// A used card is one line (the User, 2026-11-16): what was asked, then who
// asked and how it ended. The desktop and the phone say the same words.

export interface ChoiceOutcome {
  /** The option she picked, her own answer, or that nothing was sent. */
  text: string;
  /** When it ended, for the clock beside the words. */
  at?: string;
}

/** How an answered, cancelled or expired choice ends; undefined while it asks. */
export function choiceOutcome(
  choice: Pick<ChatPendingChoice, "status" | "options" | "selectedOptionId" | "customAnswer" | "selectedAt" | "cancelledAt" | "expiredAt">
): ChoiceOutcome | undefined {
  if (choice.status === "cancelled") {
    // Closed by the app (she went on, or its member left) reads as expired.
    if (choice.expiredAt) return { text: "Expired", at: choice.expiredAt };
    return { text: "Cancelled", ...(choice.cancelledAt ? { at: choice.cancelledAt } : {}) };
  }
  if (choice.status !== "selected") return undefined;
  const option = choice.options?.find((item) => item.id === choice.selectedOptionId);
  const custom = typeof choice.customAnswer === "string" ? choice.customAnswer.replace(/\s+/g, " ").trim() : "";
  return { text: option?.label ?? (custom || "Answered"), ...(choice.selectedAt ? { at: choice.selectedAt } : {}) };
}
