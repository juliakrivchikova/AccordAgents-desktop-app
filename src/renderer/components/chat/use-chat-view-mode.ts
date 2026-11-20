import { useCallback, useRef, useState } from "react";

import { canSwitchChatView, chatViewFor } from "../../../shared/mainSession";
import type { ChatViewMode, ChatViewState, Conversation } from "../../../shared/types";
import { cleanIpcError } from "../../lib/ipc-error";

export interface ChatViewModeState {
  view: ChatViewMode;
  /** Only a chat with a main session has two views. */
  canSwitch: boolean;
  setView: (view: ChatViewMode) => void;
}

/**
 * The chat's view (docs/main-session.md): the saved one, or the one the User
 * just picked while her server takes it. A failed switch goes back to the
 * saved view and says why.
 */
export function useChatViewMode(input: {
  conversation: Pick<Conversation, "id" | "metadata">;
  defaultView?: ChatViewMode;
  /** The view her server saved, to put into the open chat. */
  onSaved?: (saved: ChatViewState) => void;
  onError?: (message: string) => void;
}): ChatViewModeState {
  const { conversation } = input;
  const canSwitch = canSwitchChatView(conversation.metadata);
  const saved = chatViewFor(conversation.metadata, input.defaultView);
  const [picked, setPicked] = useState<{ conversationId: string; view: ChatViewMode; requestId: number }>();
  const requestIdRef = useRef(0);
  const callbacksRef = useRef({ onSaved: input.onSaved, onError: input.onError });
  callbacksRef.current = { onSaved: input.onSaved, onError: input.onError };
  const view = canSwitch && picked?.conversationId === conversation.id ? picked.view : saved;
  const viewRef = useRef(view);
  viewRef.current = view;

  const setView = useCallback((next: ChatViewMode) => {
    if (!canSwitch || next === viewRef.current) {
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const conversationId = conversation.id;
    const settle = (): void => setPicked((current) => (current?.requestId === requestId ? undefined : current));
    setPicked({ conversationId, view: next, requestId });
    void window.consensus.setChatView({ conversationId, view: next }).then((result) => {
      if (!result) {
        throw new Error("This chat was not found.");
      }
      callbacksRef.current.onSaved?.(result);
      settle();
    }).catch((caught: unknown) => {
      settle();
      callbacksRef.current.onError?.(`Could not switch the view: ${cleanIpcError(caught)}`);
    });
  }, [canSwitch, conversation.id]);

  return { view, canSwitch, setView };
}
