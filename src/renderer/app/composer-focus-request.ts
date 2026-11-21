/**
 * A chat whose main composer should take the keyboard once it is shown: a
 * chat just made by Fork to new chat opens with its composer focused and
 * empty (the first message there makes the fork). Asked before the chat is
 * opened, taken once by that chat's main composer when it appears.
 */
const pending = new Set<string>();

export function requestComposerFocus(conversationId: string): void {
  pending.add(conversationId);
}

/** Whether this chat's composer was asked to take the keyboard; asked once. */
export function takeComposerFocusRequest(conversationId: string | undefined): boolean {
  if (!conversationId || !pending.has(conversationId)) return false;
  pending.delete(conversationId);
  return true;
}
