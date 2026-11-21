import { createContext, useContext, useRef } from "react";

import type { ChatProviderKind } from "../../../shared/types";

/**
 * How the sessions view names and reaches members (docs/main-session.md):
 * no handles there, as in T3 Code. A member is its provider's logo and its
 * task's title, and a mention of it in a message is a chip that opens its
 * session at the message the mention is about. Absent in the classic view.
 */
export interface ChatSessionsMemberLink {
  id: string;
  /** Its current or latest task's short title (sessionsMemberTitle). */
  title: string;
  kind?: ChatProviderKind;
  hostLabel?: string;
  /** Where a click opens its session: its reply to its latest task, else
   *  that task. */
  focusMessageId?: string;
}

export interface ChatSessionsLinks {
  mainSessionId: string;
  /** The main session's handle, written by nobody in this view. */
  mainHandle?: string;
  /** Members and former members, by lower-case handle. */
  byHandle: ReadonlyMap<string, ChatSessionsMemberLink>;
  openMember: (participantId: string, focusMessageId?: string) => void;
}

export const ChatSessionsLinksContext = createContext<ChatSessionsLinks | undefined>(undefined);

export function useChatSessionsLinks(): ChatSessionsLinks | undefined {
  return useContext(ChatSessionsLinksContext);
}

/** The same map as long as its entries are the same: the roster's states are
 *  worked out anew on every update of the chat, and every row that reads
 *  them would otherwise draw again (its markdown too) on every token. */
export function useStableMap<K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const ref = useRef(map);
  const previous = ref.current;
  if (previous !== map && (previous.size !== map.size || [...map].some(([key, value]) => previous.get(key) !== value))) {
    ref.current = map;
  }
  return ref.current;
}
