import type { ChatPromptSuggestion, ChatPromptSuggestionsUpdate } from "../../../../shared/types";
import {
  CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE, ChatPromptSuggestionStore, type ChatMemberPromptSuggestion
} from "../../chatPromptSuggestions";
import type { ChatModules } from "../modules";

/** The next message members suggest to the User. */
export class PromptSuggestions {
  private promptSuggestionsListener?: (update: ChatPromptSuggestionsUpdate) => void;
  private promptSuggestionForwarder?: (suggestion: ChatMemberPromptSuggestion) => void;
  readonly suggestions = new ChatPromptSuggestionStore((update) => this.promptSuggestionsListener?.(update));

  constructor(private readonly chat: Pick<ChatModules, "host">) {}

  /** Desktop: where changes to a chat's next-prompt suggestions are pushed. */
  setPromptSuggestionsListener(listener: ((update: ChatPromptSuggestionsUpdate) => void) | undefined): void {
    this.promptSuggestionsListener = listener;
  }

  /** Machines transport, machine side: hands a member's next-prompt
   *  suggestion to the desktop, which decides whether it is still on offer. */
  setPromptSuggestionForwarder(forwarder: ((suggestion: ChatMemberPromptSuggestion) => void) | undefined): void {
    this.promptSuggestionForwarder = forwarder;
  }

  listPromptSuggestions(conversationId: string): ChatPromptSuggestion[] {
    return this.suggestions.list(conversationId);
  }

  /** A member's CLI predicted the User's next prompt after the reply of
   *  `runId`: kept on the desktop, forwarded there from a machine. `sourceMachineId`
   *  names the machine it came from; without it, the CLI ran here. */
  receiveMemberPromptSuggestion(suggestion: ChatMemberPromptSuggestion, sourceMachineId?: string): void {
    if (this.chat.host.machineRuntime) {
      try {
        this.promptSuggestionForwarder?.(suggestion);
      } catch {
        // A suggestion is optional; losing one must not disturb the turn.
      }
      return;
    }
    this.suggestions.suggestionReceived(
      suggestion.conversationId,
      suggestion.participantId,
      suggestion.runId,
      suggestion.text,
      sourceMachineId ?? CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE
    );
  }
}
