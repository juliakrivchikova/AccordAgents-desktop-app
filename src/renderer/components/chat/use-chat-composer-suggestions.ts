import { useState } from "react";
import { withoutLeadingMention } from "../../../shared/mainSession";

/** A member's next-prompt suggestion, addressed to that member. */
export interface ChatComposerSuggestion {
  participantId: string;
  handle: string;
  text: string;
  /** Offered as plain text, without the member's handle (the sessions
   *  view's composer, which writes to that member only). */
  withoutHandle?: boolean;
}

export interface ChatComposerSuggestionsState {
  /** What Tab or → puts into the empty composer: `@handle suggestion`. */
  offered?: string;
  count: number;
  /** 1-based position of the offered suggestion among `count`. */
  position: number;
  /** Applies the CLI's keys on an empty composer and says which one it took. */
  handleKey: (event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">) => "accept" | "cycle" | undefined;
}

/** The CLI predicts what the User would type, so a suggestion that already
 *  addresses members (the User wrote `@a @b …` last time) is used as it is;
 *  otherwise it goes to the member that suggested it. */
export function chatComposerSuggestionText(suggestion: ChatComposerSuggestion): string {
  if (suggestion.withoutHandle) {
    return withoutLeadingMention(suggestion.text.trim(), suggestion.handle).trim();
  }
  return suggestion.text.trimStart().startsWith("@") ? suggestion.text.trim() : `@${suggestion.handle} ${suggestion.text}`;
}

/**
 * The main composer's next-prompt suggestions in the sessions view: the main
 * session's own, offered as the text it would send, without its handle (the
 * composer writes only to it, and the view shows no handles). Another
 * member's suggestion is for that member's session, which this composer does
 * not write to. The classic view's are as before (`sessionsMainId` unset).
 */
export function sessionsComposerSuggestions(
  suggestions: ChatComposerSuggestion[],
  sessionsMainId: string | undefined
): ChatComposerSuggestion[] {
  if (!sessionsMainId) return suggestions;
  return suggestions
    .filter((suggestion) => suggestion.participantId === sessionsMainId)
    .map((suggestion) => ({ ...suggestion, withoutHandle: true }));
}

/**
 * The dedicated CLI shows its suggestion as grey text in an empty input; Tab
 * or → places it there and Enter sends it, typing hides it. Several members
 * can each have one here, newest first; ↑/↓ switch between them while the
 * composer is empty (they do nothing else there).
 */
export function useChatComposerSuggestions(
  suggestions: ChatComposerSuggestion[] | undefined,
  draft: string
): ChatComposerSuggestionsState {
  const list = suggestions ?? [];
  const listKey = list.map((suggestion) => `${suggestion.participantId}\u0000${suggestion.text}`).join("\u0001");
  // A changed list starts again from its newest suggestion.
  const [selection, setSelection] = useState({ listKey, index: 0 });
  const index = selection.listKey === listKey ? Math.min(selection.index, Math.max(list.length - 1, 0)) : 0;
  const current = draft === "" && list.length > 0 ? list[index] : undefined;
  return {
    offered: current ? chatComposerSuggestionText(current) : undefined,
    count: current ? list.length : 0,
    position: current ? index + 1 : 0,
    handleKey: (event) => {
      if (!current || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return undefined;
      }
      if (event.key === "Tab" || event.key === "ArrowRight") {
        return "accept";
      }
      if (list.length > 1 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelection({ listKey, index: (index + step + list.length) % list.length });
        return "cycle";
      }
      return undefined;
    }
  };
}
