import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPromptSuggestionsUpdate } from "../../shared/types";
import {
  CHAT_PROMPT_SUGGESTION_EARLY_TTL_MS,
  CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE as LOCAL,
  CHAT_PROMPT_SUGGESTION_MAX_CHARS,
  ChatPromptSuggestionStore
} from "./chatPromptSuggestions";

function store(): { suggestions: ChatPromptSuggestionStore; updates: ChatPromptSuggestionsUpdate[]; advance: (ms: number) => void } {
  const updates: ChatPromptSuggestionsUpdate[] = [];
  let now = Date.parse("2026-10-17T20:00:00.000Z");
  const suggestions = new ChatPromptSuggestionStore((update) => updates.push(update), () => now);
  return { suggestions, updates, advance: (ms) => { now += ms; } };
}

const texts = (suggestions: ChatPromptSuggestionStore, conversationId: string): string[] =>
  suggestions.list(conversationId).map((suggestion) => `${suggestion.participantId}: ${suggestion.text}`);

test("a reply to the User offers the suggestion its CLI sends, and only in that chat", () => {
  const { suggestions, updates } = store();
  suggestions.replyFinished("chat-a", "taylor", "run-1", LOCAL);
  suggestions.suggestionReceived("chat-a", "taylor", "run-1", "  run the tests  ", LOCAL);
  assert.deepEqual(texts(suggestions, "chat-a"), ["taylor: run the tests"]);
  assert.deepEqual(texts(suggestions, "chat-b"), []);
  assert.deepEqual(updates.map((update) => update.conversationId), ["chat-a"]);
});

test("each member keeps its latest suggestion, newest first, until the User sends", () => {
  const { suggestions, updates } = store();
  suggestions.replyFinished("chat", "taylor", "run-1", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "run the tests", LOCAL);
  suggestions.replyFinished("chat", "drew", "run-2", "machine-1");
  suggestions.suggestionReceived("chat", "drew", "run-2", "commit this", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit this", "taylor: run the tests"]);

  suggestions.userMessageSent("chat");
  assert.deepEqual(texts(suggestions, "chat"), []);
  assert.deepEqual(updates.at(-1), { conversationId: "chat", suggestions: [] });
});

test("a member starting another reply withdraws its suggestion; a late one for the old reply is ignored", () => {
  const { suggestions } = store();
  suggestions.replyFinished("chat", "taylor", "run-1", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "run the tests", LOCAL);
  suggestions.replyStarted("chat", "taylor");
  assert.deepEqual(texts(suggestions, "chat"), []);

  suggestions.replyFinished("chat", "taylor", "run-2", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "stale", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
  suggestions.suggestionReceived("chat", "taylor", "run-2", "push it", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), ["taylor: push it"]);
});

test("a suggestion is never offered for a reply that was not to the User, or after the User sent again", () => {
  const { suggestions, updates } = store();
  // A member request: the desktop never marks it finished for suggestions.
  suggestions.suggestionReceived("chat", "taylor", "request-run", "do it", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);

  suggestions.replyFinished("chat", "taylor", "run-1", LOCAL);
  suggestions.userMessageSent("chat");
  suggestions.suggestionReceived("chat", "taylor", "run-1", "too late", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
  assert.equal(updates.length, 0, "nothing on offer ever changed");
});

test("from a machine: a suggestion that arrives before its reply's result is offered once the result arrives", () => {
  const { suggestions, advance } = store();
  suggestions.suggestionReceived("chat", "drew", "run-1", "commit this", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), []);
  advance(5_000);
  suggestions.replyFinished("chat", "drew", "run-1", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit this"]);

  suggestions.suggestionReceived("chat", "drew", "run-2", "too old", "machine-1");
  advance(CHAT_PROMPT_SUGGESTION_EARLY_TTL_MS + 1);
  suggestions.replyFinished("chat", "drew", "run-2", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit this"], "an expired early suggestion is not offered");
});

test("a suggestion is taken only from where its reply ran", () => {
  const { suggestions } = store();
  suggestions.replyFinished("chat", "drew", "run-1", "machine-1");
  suggestions.suggestionReceived("chat", "drew", "run-1", "from another machine", "machine-2");
  suggestions.suggestionReceived("chat", "drew", "run-1", "from the desktop", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);

  suggestions.suggestionReceived("chat", "taylor", "run-2", "early from elsewhere", "machine-2");
  suggestions.replyFinished("chat", "taylor", "run-2", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
});

test("empty or overlong suggestions are dropped; a removed member or deleted chat leaves nothing behind", () => {
  const { suggestions } = store();
  suggestions.replyFinished("chat", "taylor", "run-1", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "   ", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "x".repeat(CHAT_PROMPT_SUGGESTION_MAX_CHARS + 1), LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "run it", LOCAL);
  suggestions.replyFinished("chat", "drew", "run-2", LOCAL);
  suggestions.suggestionReceived("chat", "drew", "run-2", "commit", LOCAL);

  suggestions.forgetParticipant("chat", "taylor");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit"]);
  suggestions.forgetConversation("chat");
  assert.deepEqual(texts(suggestions, "chat"), []);
});
