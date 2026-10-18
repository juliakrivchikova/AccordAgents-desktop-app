import { useEffect, useMemo, useState } from "react";
import type { ChatParticipant, ChatPromptSuggestion } from "../../../shared/types";
import type { ChatComposerSuggestion } from "./use-chat-composer-suggestions";

interface LoadedSuggestions {
  conversationId: string;
  suggestions: ChatPromptSuggestion[];
}

/**
 * The open chat's next-prompt suggestions, as the main process keeps them.
 * Only this chat's are ever returned: a list loaded for another chat is
 * discarded, and nothing is shown until this chat's list is known.
 */
export function useChatPromptSuggestions(
  conversationId: string,
  participants: ChatParticipant[]
): { suggestions: ChatComposerSuggestion[]; dismiss: () => void; reload: () => void } {
  const [loaded, setLoaded] = useState<LoadedSuggestions | undefined>();
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let updated = false;
    const unsubscribe = window.consensus.onChatPromptSuggestions?.((update) => {
      if (update.conversationId !== conversationId) {
        return;
      }
      updated = true;
      setLoaded({ conversationId, suggestions: update.suggestions });
    });
    void window.consensus.getChatPromptSuggestions?.(conversationId)?.then((suggestions) => {
      // A pushed update is newer than this answer.
      if (!cancelled && !updated) {
        setLoaded({ conversationId, suggestions });
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [conversationId, reloads]);
  const own = loaded?.conversationId === conversationId ? loaded.suggestions : undefined;
  const suggestions = useMemo(() => {
    const handles = new Map(participants.map((participant) => [participant.id, participant.handle]));
    return (own ?? []).flatMap((suggestion): ChatComposerSuggestion[] => {
      const handle = handles.get(suggestion.participantId);
      return handle ? [{ participantId: suggestion.participantId, handle, text: suggestion.text }] : [];
    });
  }, [own, participants]);
  return {
    suggestions,
    // Sending clears them in the main process too; this only spares the
    // emptied composer from showing them until that update arrives.
    dismiss: () => setLoaded({ conversationId, suggestions: [] }),
    // After a send that did not go through, show what is still on offer.
    reload: () => setReloads((value) => value + 1)
  };
}
