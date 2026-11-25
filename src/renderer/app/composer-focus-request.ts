/**
 * A chat whose main composer should take the keyboard once it is shown: a
 * chat just made by Fork to new chat opens with its composer focused and
 * empty (the first message there makes the fork). Asked when the chat is
 * opened, taken once by that chat's main composer: at once when it is
 * already on screen, otherwise when it appears. Opening another chat (or
 * none) drops it, so it never takes the keyboard on a later visit.
 */
const pending = new Set<string>();
const listeners = new Set<() => void>();

export function requestComposerFocus(conversationId: string): void {
  pending.add(conversationId);
  for (const listener of [...listeners]) listener();
}

/** Whether this chat's composer was asked to take the keyboard; asked once. */
export function takeComposerFocusRequest(conversationId: string | undefined): boolean {
  if (!conversationId || !pending.has(conversationId)) return false;
  pending.delete(conversationId);
  return true;
}

/** Another chat (or none) is being opened: a request for any other chat is void. */
export function dropComposerFocusRequestsExcept(conversationId: string | undefined): void {
  for (const id of [...pending]) {
    if (id !== conversationId) pending.delete(id);
  }
}

/** Called on every new request, for a composer already on screen. */
export function onComposerFocusRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
