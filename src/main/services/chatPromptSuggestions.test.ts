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

/** A member's reply to the User as the desktop sees it: started, its result
 *  known, then stored and judged eligible. */
function reply(suggestions: ChatPromptSuggestionStore, conversationId: string, participantId: string, runId: string, source = LOCAL): void {
  suggestions.replyStarted(conversationId, participantId, runId);
  suggestions.replyEnded(conversationId, participantId, runId);
  suggestions.replyFinished(conversationId, participantId, runId, source);
}

test("a reply to the User offers the suggestion its CLI sends, and only in that chat", () => {
  const { suggestions, updates } = store();
  reply(suggestions, "chat-a", "taylor", "run-1");
  suggestions.suggestionReceived("chat-a", "taylor", "run-1", "  run the tests  ", LOCAL);
  assert.deepEqual(texts(suggestions, "chat-a"), ["taylor: run the tests"]);
  assert.deepEqual(texts(suggestions, "chat-b"), []);
  assert.deepEqual(updates.map((update) => update.conversationId), ["chat-a"]);
});

test("each member keeps its latest suggestion, newest first, until the User sends", () => {
  const { suggestions, updates } = store();
  reply(suggestions, "chat", "taylor", "run-1");
  suggestions.suggestionReceived("chat", "taylor", "run-1", "run the tests", LOCAL);
  reply(suggestions, "chat", "drew", "run-2", "machine-1");
  suggestions.suggestionReceived("chat", "drew", "run-2", "commit this", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit this", "taylor: run the tests"]);

  suggestions.userMessageSent("chat");
  assert.deepEqual(texts(suggestions, "chat"), []);
  assert.deepEqual(updates.at(-1), { conversationId: "chat", suggestions: [] });
});

test("a member starting another reply withdraws its suggestion; a late one for the old reply is never offered", () => {
  const { suggestions } = store();
  reply(suggestions, "chat", "taylor", "run-1");
  suggestions.suggestionReceived("chat", "taylor", "run-1", "run the tests", LOCAL);
  // A reply the member starts on its own (a background task finished) too.
  suggestions.replyStarted("chat", "taylor", "self-run");
  assert.deepEqual(texts(suggestions, "chat"), []);

  reply(suggestions, "chat", "taylor", "run-2");
  suggestions.suggestionReceived("chat", "taylor", "run-1", "stale", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
  suggestions.suggestionReceived("chat", "taylor", "run-2", "push it", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), ["taylor: push it"]);
});

test("two messages to one member at once: the first reply's end does not bring its suggestion back", () => {
  const { suggestions } = store();
  suggestions.replyStarted("chat", "taylor", "run-1");
  suggestions.userMessageSent("chat");
  suggestions.replyStarted("chat", "taylor", "run-2");
  suggestions.replyEnded("chat", "taylor", "run-1");
  suggestions.replyFinished("chat", "taylor", "run-1", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "for the first message", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), [], "the member is already answering the newer message");

  // The newer reply's own suggestion may arrive before its end is known here.
  suggestions.suggestionReceived("chat", "taylor", "run-2", "for the second message", LOCAL);
  suggestions.replyEnded("chat", "taylor", "run-2");
  suggestions.replyFinished("chat", "taylor", "run-2", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), ["taylor: for the second message"]);
});

test("a suggestion is never offered for a reply that was not to the User, or that ended before the User sent again", () => {
  const { suggestions, updates } = store();
  // A member request: started, but never judged eligible.
  suggestions.replyStarted("chat", "taylor", "request-run");
  suggestions.replyEnded("chat", "taylor", "request-run");
  suggestions.suggestionReceived("chat", "taylor", "request-run", "do it", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);

  // Ended, then the User sent to someone else while the result was stored.
  suggestions.replyStarted("chat", "drew", "run-1");
  suggestions.replyEnded("chat", "drew", "run-1");
  suggestions.userMessageSent("chat");
  suggestions.replyFinished("chat", "drew", "run-1", "machine-1");
  suggestions.suggestionReceived("chat", "drew", "run-1", "too late", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), []);
  assert.equal(updates.length, 0, "nothing on offer ever changed");

  // Still running when the User sent to someone else: its reply came after that message.
  suggestions.replyStarted("chat", "taylor", "run-2");
  suggestions.userMessageSent("chat");
  suggestions.replyEnded("chat", "taylor", "run-2");
  suggestions.replyFinished("chat", "taylor", "run-2", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-2", "next step", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), ["taylor: next step"]);
});

test("from a machine: a suggestion that arrives before its reply's result is offered once the result arrives", () => {
  const { suggestions, advance } = store();
  suggestions.replyStarted("chat", "drew", "run-1");
  suggestions.suggestionReceived("chat", "drew", "run-1", "commit this", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), []);
  advance(5_000);
  suggestions.replyEnded("chat", "drew", "run-1");
  suggestions.replyFinished("chat", "drew", "run-1", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit this"]);

  suggestions.replyStarted("chat", "drew", "run-2");
  suggestions.suggestionReceived("chat", "drew", "run-2", "too old", "machine-1");
  advance(CHAT_PROMPT_SUGGESTION_EARLY_TTL_MS + 1);
  suggestions.replyEnded("chat", "drew", "run-2");
  suggestions.replyFinished("chat", "drew", "run-2", "machine-1");
  assert.deepEqual(texts(suggestions, "chat"), [], "an expired early suggestion is not offered");
});

test("a suggestion is taken only from where its reply ran", () => {
  const { suggestions } = store();
  reply(suggestions, "chat", "drew", "run-1", "machine-1");
  suggestions.suggestionReceived("chat", "drew", "run-1", "from another machine", "machine-2");
  suggestions.suggestionReceived("chat", "drew", "run-1", "from the desktop", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);

  suggestions.replyStarted("chat", "taylor", "run-2");
  suggestions.suggestionReceived("chat", "taylor", "run-2", "early from elsewhere", "machine-2");
  suggestions.replyEnded("chat", "taylor", "run-2");
  suggestions.replyFinished("chat", "taylor", "run-2", LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
});

test("empty or overlong suggestions are dropped; a removed member or deleted chat leaves nothing behind", () => {
  const { suggestions } = store();
  reply(suggestions, "chat", "taylor", "run-1");
  suggestions.suggestionReceived("chat", "taylor", "run-1", "   ", LOCAL);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "x".repeat(CHAT_PROMPT_SUGGESTION_MAX_CHARS + 1), LOCAL);
  assert.deepEqual(texts(suggestions, "chat"), []);
  suggestions.suggestionReceived("chat", "taylor", "run-1", "run it", LOCAL);
  reply(suggestions, "chat", "drew", "run-2");
  suggestions.suggestionReceived("chat", "drew", "run-2", "commit", LOCAL);

  suggestions.forgetParticipant("chat", "taylor");
  assert.deepEqual(texts(suggestions, "chat"), ["drew: commit"]);
  suggestions.forgetConversation("chat");
  assert.deepEqual(texts(suggestions, "chat"), []);
});
