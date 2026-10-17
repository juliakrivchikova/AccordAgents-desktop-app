import { useState } from "react";

/** A member's next-prompt suggestion, addressed to that member. */
export interface ChatComposerSuggestion {
  participantId: string;
  handle: string;
  text: string;
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

export function chatComposerSuggestionText(suggestion: ChatComposerSuggestion): string {
  return `@${suggestion.handle} ${suggestion.text}`;
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
