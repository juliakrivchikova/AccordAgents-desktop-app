import { useEffect, useMemo, useState } from "react";

interface LoadedBackgroundTasks {
  conversationId: string;
  byParticipant: Record<string, string[]>;
}

const EMPTY: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * Live background work of the open chat's members (Claude Code
 * `run_in_background`), as the main process sees it. Not stored with the
 * chat: it lives only as long as the CLI process that runs it.
 *
 * Each time a chat is opened its list is loaded afresh; changes pushed while
 * that load is on its way are applied on top of its answer, never dropped.
 */
export function useChatBackgroundTasks(conversationId: string | undefined): ReadonlyMap<string, readonly string[]> {
  const [loaded, setLoaded] = useState<LoadedBackgroundTasks | undefined>();
  useEffect(() => {
    if (!conversationId) {
      setLoaded(undefined);
      return undefined;
    }
    let cancelled = false;
    let base: Record<string, string[]> | undefined;
    const pushed = new Map<string, string[]>();
    const publish = (): void => {
      if (cancelled || !base) {
        return;
      }
      const byParticipant = { ...base };
      for (const [participantId, labels] of pushed) {
        if (labels.length > 0) {
          byParticipant[participantId] = labels;
        } else {
          delete byParticipant[participantId];
        }
      }
      setLoaded({ conversationId, byParticipant });
    };
    setLoaded({ conversationId, byParticipant: {} });
    const unsubscribe = window.consensus.onChatBackgroundTasks?.((event) => {
      if (event.conversationId !== conversationId) {
        return;
      }
      pushed.set(event.participantId, event.labels);
      publish();
    });
    const answer = window.consensus.getChatBackgroundTasks?.(conversationId);
    if (answer) {
      void answer.then((byParticipant) => {
        base = byParticipant ?? {};
        publish();
      }).catch(() => {
        base = {};
        publish();
      });
    } else {
      base = {};
      publish();
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [conversationId]);
  const own = loaded && loaded.conversationId === conversationId ? loaded.byParticipant : undefined;
  return useMemo(() => (own ? new Map(Object.entries(own)) : EMPTY), [own]);
}
