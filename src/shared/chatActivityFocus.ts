export type ChatActivityFocusExecutionResult = "completed" | "stale" | "missing" | "failed";

export interface ExecuteChatActivityFocusOptions<TConversation, TTarget> {
  isCurrent: () => boolean;
  openConversation: () => Promise<TConversation | undefined>;
  resolveTarget: (conversation: TConversation) => TTarget | undefined;
  onTargetResolved: (target: TTarget) => void;
  ensureTargetLoaded: (conversation: TConversation, target: TTarget) => Promise<boolean>;
  beforeCommit: () => Promise<void>;
  commit: (target: TTarget) => void;
  clear: () => void;
  fail: (error: unknown) => void;
}

export async function executeChatActivityFocus<TConversation, TTarget>(
  options: ExecuteChatActivityFocusOptions<TConversation, TTarget>
): Promise<ChatActivityFocusExecutionResult> {
  try {
    const conversation = await options.openConversation();
    if (!options.isCurrent()) {
      return "stale";
    }
    if (!conversation) {
      options.clear();
      return "missing";
    }

    const target = options.resolveTarget(conversation);
    if (!target) {
      options.clear();
      return "missing";
    }
    options.onTargetResolved(target);

    const loaded = await options.ensureTargetLoaded(conversation, target);
    if (!options.isCurrent()) {
      return "stale";
    }
    if (!loaded) {
      options.clear();
      return "missing";
    }

    await options.beforeCommit();
    if (!options.isCurrent()) {
      return "stale";
    }
    options.commit(target);
    return "completed";
  } catch (error) {
    if (!options.isCurrent()) {
      return "stale";
    }
    options.fail(error);
    options.clear();
    return "failed";
  }
}
