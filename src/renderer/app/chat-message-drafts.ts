import { useCallback, useState, type SetStateAction } from "react";

/**
 * One value per chat, such as the composer's unsent text. A chat with no entry
 * has the empty value. Kept in renderer memory only: it lives as long as the
 * app window.
 */
export type PerChat<T> = Readonly<Record<string, T>>;

export function perChatValue<T>(values: PerChat<T>, conversationId: string | undefined, empty: T): T {
  return conversationId !== undefined && Object.prototype.hasOwnProperty.call(values, conversationId)
    ? values[conversationId]
    : empty;
}

export function applyPerChatValue<T>(
  values: PerChat<T>,
  conversationId: string,
  value: SetStateAction<T>,
  empty: T,
  isEmpty: (value: T) => boolean
): PerChat<T> {
  const previous = perChatValue(values, conversationId, empty);
  const next = typeof value === "function" ? (value as (current: T) => T)(previous) : value;
  if (sameValue(next, previous)) {
    // Keep the map, so an update that changes nothing (a pick list filtered
    // on every keystroke) does not re-render the whole app.
    return values;
  }
  if (isEmpty(next)) {
    return withoutPerChatValue(values, conversationId);
  }
  return { ...values, [conversationId]: next };
}

function sameValue(next: unknown, previous: unknown): boolean {
  if (Object.is(next, previous)) {
    return true;
  }
  return Array.isArray(next) && Array.isArray(previous) &&
    next.length === previous.length &&
    next.every((item, index) => Object.is(item, previous[index]));
}

export function withoutPerChatValue<T>(values: PerChat<T>, conversationId: string): PerChat<T> {
  if (!Object.prototype.hasOwnProperty.call(values, conversationId)) {
    return values;
  }
  const { [conversationId]: _removed, ...rest } = values;
  return rest;
}

export interface PerChatState<T> {
  /** The open chat's value; the empty value when no chat is open. */
  value: T;
  /** Changes the open chat's value; does nothing when no chat is open. */
  setForOpenChat: React.Dispatch<SetStateAction<T>>;
  /** Changes one chat's value, whichever chat is open by then. */
  setForChat: (conversationId: string, value: SetStateAction<T>) => void;
  /** Forgets one chat's value. */
  clear: (conversationId: string) => void;
}

/**
 * `empty` and `isEmpty` must be stable (module constants): an emptied value
 * leaves no entry behind, and the open chat's value keeps its identity
 * between renders.
 */
export function usePerChatState<T>(
  openConversationId: string | undefined,
  empty: T,
  isEmpty: (value: T) => boolean
): PerChatState<T> {
  const [values, setValues] = useState<PerChat<T>>({});
  const setForChat = useCallback((conversationId: string, value: SetStateAction<T>) => {
    setValues((current) => applyPerChatValue(current, conversationId, value, empty, isEmpty));
  }, [empty, isEmpty]);
  const setForOpenChat = useCallback<React.Dispatch<SetStateAction<T>>>((value) => {
    if (openConversationId !== undefined) {
      setForChat(openConversationId, value);
    }
  }, [openConversationId, setForChat]);
  const clear = useCallback((conversationId: string) => {
    setValues((current) => withoutPerChatValue(current, conversationId));
  }, []);
  return { value: perChatValue(values, openConversationId, empty), setForOpenChat, setForChat, clear };
}
