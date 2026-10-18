import type { ChatPromptSuggestion, ChatPromptSuggestionsUpdate } from "../../shared/types";

/** A suggestion longer than this is not a prompt the User would type. */
export const CHAT_PROMPT_SUGGESTION_MAX_CHARS = 500;
/** How long a suggestion may wait for its reply's end to be known here (a
 *  member on a machine: the suggestion and the turn's result travel apart). */
export const CHAT_PROMPT_SUGGESTION_EARLY_TTL_MS = 120_000;
/** Where a member's reply ran when it ran on this desktop; otherwise the id of
 *  the machine that ran it. A suggestion is taken only from where its reply ran. */
export const CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE = "this-desktop";

/** One suggestion as a member's CLI sent it, before the desktop decides
 *  whether it is still on offer. Also the machine-to-desktop payload. */
export interface ChatMemberPromptSuggestion {
  conversationId: string;
  participantId: string;
  /** The run whose reply the suggestion follows. */
  runId: string;
  text: string;
}

interface EarlySuggestion {
  participantId: string;
  text: string;
  source: string;
  receivedAt: number;
}

interface ConversationSuggestions {
  /** Counts the User's messages in this chat; a reply that ended before the
   *  latest one is not followed by a suggestion. */
  userMessages: number;
  /** The suggestion on offer per member; at most one each. */
  shown: Map<string, ChatPromptSuggestion & { order: number }>;
  /** Per member, its newest reply: only that reply's suggestion is wanted. */
  latestRun: Map<string, string>;
  /** Per member, how many User messages there were when its newest reply ended. */
  ended: Map<string, { runId: string; userMessages: number }>;
  /** Per member, the reply to the User whose suggestion may still arrive. */
  awaiting: Map<string, { runId: string; source: string }>;
  /** Suggestions whose reply is not known here to have ended yet, by run. */
  early: Map<string, EarlySuggestion>;
}

/**
 * The next-prompt suggestions Claude Code members' CLIs send after a reply
 * (`--prompt-suggestions`), kept per chat in memory as the dedicated CLI keeps
 * its one. A suggestion is offered only for a member's newest reply, only for
 * a reply to the User's own message, and only while the User has sent nothing
 * in that chat since the reply ended. Nothing here is stored on disk.
 */
export class ChatPromptSuggestionStore {
  private readonly conversations = new Map<string, ConversationSuggestions>();
  private order = 0;

  constructor(
    private readonly onChange: (update: ChatPromptSuggestionsUpdate) => void,
    private readonly now: () => number = Date.now
  ) {}

  list(conversationId: string): ChatPromptSuggestion[] {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return [];
    }
    return Array.from(state.shown.values())
      .sort((left, right) => right.order - left.order)
      .map(({ order: _order, ...suggestion }) => suggestion);
  }

  /** The User sent a message in this chat: every suggestion there is stale. */
  userMessageSent(conversationId: string): void {
    const state = this.state(conversationId);
    state.userMessages += 1;
    const changed = state.shown.size > 0;
    state.shown.clear();
    state.awaiting.clear();
    state.early.clear();
    if (changed) {
      this.emit(conversationId);
    }
  }

  /** A member started a reply (the same run again is not a new reply): what
   *  it suggested after an earlier one no longer follows its newest reply,
   *  and the CLI drops a pending one the same way. */
  replyStarted(conversationId: string, participantId: string, runId: string): void {
    const state = this.state(conversationId);
    if (state.latestRun.get(participantId) === runId) {
      return;
    }
    state.latestRun.set(participantId, runId);
    state.ended.delete(participantId);
    state.awaiting.delete(participantId);
    if (state.shown.delete(participantId)) {
      this.emit(conversationId);
    }
  }

  /** The member's reply ended (its result is known here), whatever comes of
   *  it; called before the result is stored, which can take a while. */
  replyEnded(conversationId: string, participantId: string, runId: string): void {
    const state = this.state(conversationId);
    if (state.latestRun.get(participantId) === runId) {
      state.ended.set(participantId, { runId, userMessages: state.userMessages });
    }
  }

  /** A member's reply to the User's own message ended successfully: its CLI
   *  may now send a suggestion for it. */
  replyFinished(conversationId: string, participantId: string, runId: string, source: string): void {
    const state = this.state(conversationId);
    this.expireEarly(state);
    if (state.latestRun.get(participantId) !== runId) {
      return;
    }
    const ended = state.ended.get(participantId);
    if (ended?.runId === runId && ended.userMessages !== state.userMessages) {
      return;
    }
    state.awaiting.set(participantId, { runId, source });
    const early = state.early.get(runId);
    if (early && early.participantId === participantId && early.source === source) {
      state.early.delete(runId);
      this.accept(conversationId, state, participantId, early.text);
    }
  }

  /** A member's CLI, where `source` ran it, sent a suggestion after the reply
   *  of `runId`. */
  suggestionReceived(conversationId: string, participantId: string, runId: string, text: string, source: string): void {
    const suggestion = text.trim();
    if (!suggestion || suggestion.length > CHAT_PROMPT_SUGGESTION_MAX_CHARS) {
      return;
    }
    const state = this.state(conversationId);
    this.expireEarly(state);
    const awaited = state.awaiting.get(participantId);
    if (awaited?.runId === runId && awaited.source === source) {
      this.accept(conversationId, state, participantId, suggestion);
      return;
    }
    // Its reply's end may not be known here yet (a member on a machine).
    state.early.set(runId, { participantId, text: suggestion, source, receivedAt: this.now() });
  }

  forgetParticipant(conversationId: string, participantId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return;
    }
    state.latestRun.delete(participantId);
    state.ended.delete(participantId);
    state.awaiting.delete(participantId);
    for (const [runId, early] of state.early) {
      if (early.participantId === participantId) {
        state.early.delete(runId);
      }
    }
    if (state.shown.delete(participantId)) {
      this.emit(conversationId);
    }
  }

  forgetConversation(conversationId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return;
    }
    this.conversations.delete(conversationId);
    if (state.shown.size > 0) {
      this.emit(conversationId);
    }
  }

  private accept(conversationId: string, state: ConversationSuggestions, participantId: string, text: string): void {
    state.awaiting.delete(participantId);
    this.order += 1;
    state.shown.set(participantId, {
      participantId,
      text,
      createdAt: new Date(this.now()).toISOString(),
      order: this.order
    });
    this.emit(conversationId);
  }

  private state(conversationId: string): ConversationSuggestions {
    let state = this.conversations.get(conversationId);
    if (!state) {
      state = {
        userMessages: 0,
        shown: new Map(),
        latestRun: new Map(),
        ended: new Map(),
        awaiting: new Map(),
        early: new Map()
      };
      this.conversations.set(conversationId, state);
    }
    return state;
  }

  private expireEarly(state: ConversationSuggestions): void {
    const cutoff = this.now() - CHAT_PROMPT_SUGGESTION_EARLY_TTL_MS;
    for (const [runId, early] of state.early) {
      if (early.receivedAt < cutoff) {
        state.early.delete(runId);
      }
    }
  }

  private emit(conversationId: string): void {
    try {
      this.onChange({ conversationId, suggestions: this.list(conversationId) });
    } catch {
      // A listener failure must not break the chat flow that reported the change.
    }
  }
}
