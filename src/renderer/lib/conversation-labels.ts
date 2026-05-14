import type { ConversationKind } from "../../shared/types";

export const labelForKind = (kind: ConversationKind): string => {
  if (kind === "code-review") {
    return "Code review";
  }
  if (kind === "implementation-plan") {
    return "Implementation plan";
  }
  if (kind === "chat") {
    return "Chat";
  }
  return "Question";
};

export const titleForKind = (kind: ConversationKind): string => {
  if (kind === "implementation-plan") {
    return "Implementation plan";
  }
  if (kind === "code-review") {
    return "Consensus review";
  }
  if (kind === "chat") {
    return "Chat";
  }
  return "Consensus question";
};

export const requiresRepo = (kind: ConversationKind): boolean =>
  kind === "code-review" || kind === "implementation-plan";

