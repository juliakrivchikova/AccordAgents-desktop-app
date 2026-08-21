import type { ChatSearchMessageMatch, Conversation } from "../../shared/types";
import { executeChatActivityFocus } from "../../shared/chatActivityFocus";
import { errorText } from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";

export async function focusConversationMessage({
  state,
  target,
  openConversation,
  ensureTargetMessagesLoaded
}: {
  state: AppState;
  target: Pick<ChatSearchMessageMatch, "conversationId" | "messageId" | "threadRootId">;
  openConversation: (conversationId: string) => Promise<Conversation | undefined>;
  ensureTargetMessagesLoaded: (
    conversation: Conversation,
    messageId: string,
    threadRootId: string | undefined,
    isCurrent: () => boolean
  ) => Promise<boolean>;
}): Promise<void> {
  const pendingFocusNonce = state.chatMessageFocusNonceRef.current + 1;
  state.chatMessageFocusNonceRef.current = pendingFocusNonce;
  state.setError(undefined);
  state.setChatMessageFocusRequest({
    conversationId: target.conversationId,
    messageId: target.messageId,
    threadRootId: target.threadRootId,
    nonce: pendingFocusNonce,
    pending: true
  });
  let conversationRequestId: number | undefined;
  const isCurrent = (): boolean =>
    state.chatMessageFocusNonceRef.current === pendingFocusNonce &&
    (conversationRequestId === undefined || state.openConversationRequestRef.current === conversationRequestId);
  const clear = (): void => {
    state.setChatMessageFocusRequest((current) => current?.nonce === pendingFocusNonce ? undefined : current);
  };
  const result = await executeChatActivityFocus<Conversation, typeof target>({
    isCurrent,
    openConversation: async () => {
      const conversation = await openConversation(target.conversationId);
      conversationRequestId = state.openConversationRequestRef.current;
      return conversation;
    },
    resolveTarget: () => target.messageId.trim() ? target : undefined,
    onTargetResolved: () => undefined,
    ensureTargetLoaded: (conversation, resolvedTarget) => ensureTargetMessagesLoaded(
      conversation,
      resolvedTarget.messageId,
      resolvedTarget.threadRootId,
      isCurrent
    ),
    beforeCommit: waitForNextFrame,
    commit: (resolvedTarget) => {
      state.setChatMessageFocusRequest({
        conversationId: resolvedTarget.conversationId,
        messageId: resolvedTarget.messageId,
        threadRootId: resolvedTarget.threadRootId,
        nonce: pendingFocusNonce
      });
    },
    clear,
    fail: (caught) => state.setError(errorText(caught))
  });
  if (result === "missing" && isCurrent()) {
    state.setError("The selected search result is no longer available.");
  }
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    requestAnimationFrame(finish);
    window.setTimeout(finish, 50);
  });
}
