import { useEffect, useMemo, useState } from "react";
import type { ChatBackgroundTask } from "../../../shared/types";

interface LoadedBackgroundTasks {
  conversationId: string;
  byParticipant: Record<string, ChatBackgroundTask[]>;
  environmentPending: string[];
}

export interface ChatBackgroundTasksState {
  tasks: ReadonlyMap<string, readonly ChatBackgroundTask[]>;
  /** Members whose background tasks keep them on the environment variables
   *  their process started with. */
  environmentPending: ReadonlySet<string>;
}

const EMPTY: ChatBackgroundTasksState = { tasks: new Map(), environmentPending: new Set() };

/**
 * Live background work of the open chat's members (Claude Code
 * `run_in_background`), as the main process sees it, and which of them it
 * keeps on old environment values. Not stored with the chat: it lives only
 * as long as the CLI process that runs it.
 *
 * Each time a chat is opened its list is loaded afresh; changes pushed while
 * that load is on its way are applied on top of its answer, never dropped.
 */
export function useChatBackgroundTasks(conversationId: string | undefined): ChatBackgroundTasksState {
  const [loaded, setLoaded] = useState<LoadedBackgroundTasks | undefined>();
  useEffect(() => {
    if (!conversationId) {
      setLoaded(undefined);
      return undefined;
    }
    let cancelled = false;
    let base: { tasks: Record<string, ChatBackgroundTask[]>; pending: string[] } | undefined;
    const pushed = new Map<string, { tasks: ChatBackgroundTask[]; environmentPending: boolean }>();
    const publish = (): void => {
      if (cancelled || !base) {
        return;
      }
      const byParticipant = { ...base.tasks };
      const pending = new Set(base.pending);
      for (const [participantId, update] of pushed) {
        if (update.tasks.length > 0) {
          byParticipant[participantId] = update.tasks;
        } else {
          delete byParticipant[participantId];
        }
        if (update.environmentPending && update.tasks.length > 0) {
          pending.add(participantId);
        } else {
          pending.delete(participantId);
        }
      }
      setLoaded({ conversationId, byParticipant, environmentPending: Array.from(pending) });
    };
    setLoaded({ conversationId, byParticipant: {}, environmentPending: [] });
    const unsubscribe = window.consensus.onChatBackgroundTasks?.((event) => {
      if (event.conversationId !== conversationId) {
        return;
      }
      pushed.set(event.participantId, { tasks: event.tasks, environmentPending: event.environmentPending === true });
      publish();
    });
    const answer = Promise.all([
      window.consensus.getChatBackgroundTasks?.(conversationId) ?? Promise.resolve({}),
      window.consensus.getChatEnvironmentPending?.(conversationId).catch(() => []) ?? Promise.resolve([])
    ]);
    void answer.then(([tasks, pending]) => {
      base = { tasks: tasks ?? {}, pending: Array.isArray(pending) ? pending : [] };
      publish();
    }).catch(() => {
      base = { tasks: {}, pending: [] };
      publish();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [conversationId]);
  const own = loaded && loaded.conversationId === conversationId ? loaded : undefined;
  return useMemo(() => (own
    ? { tasks: new Map(Object.entries(own.byParticipant)), environmentPending: new Set(own.environmentPending) }
    : EMPTY), [own]);
}
