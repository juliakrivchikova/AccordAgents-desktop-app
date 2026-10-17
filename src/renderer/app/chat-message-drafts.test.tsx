import assert from "node:assert/strict";
import test from "node:test";
import type { SetStateAction } from "react";
import { act, create } from "react-test-renderer";

import type { Conversation } from "../../shared/types";
import { useAppState, type AppState } from "./app-state";
import { applyPerChatValue, perChatValue, withoutPerChatValue } from "./chat-message-drafts";
import { useChatActions, type ChatActions } from "./use-chat-actions";
import type { ConversationActions } from "./use-conversation-actions";

function chat(id: string): Conversation {
  return {
    id,
    title: id,
    kind: "chat",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    messages: [],
    findings: [],
    metadata: {}
  } as unknown as Conversation;
}

function installMemoryLocalStorage(): void {
  const values = new Map<string, string>();
  (globalThis as any).window = {
    ...((globalThis as any).window ?? {}),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); }
    }
  };
}

test("per-chat values keep one entry per chat and drop emptied ones", () => {
  const isEmpty = (value: string) => value.length === 0;
  const empty = {};
  const a = applyPerChatValue(empty, "a", "hello", "", isEmpty);
  assert.deepEqual(a, { a: "hello" });
  const ab = applyPerChatValue(a, "b", (current) => current + "world", "", isEmpty);
  assert.deepEqual(ab, { a: "hello", b: "world" });
  assert.equal(applyPerChatValue(ab, "a", "hello", "", isEmpty), ab, "an unchanged value keeps the same map");
  assert.deepEqual(applyPerChatValue(ab, "a", "", "", isEmpty), { b: "world" }, "an emptied value leaves no entry behind");
  assert.deepEqual(withoutPerChatValue(ab, "b"), { a: "hello" });
  assert.equal(withoutPerChatValue(ab, "missing"), ab);
  assert.equal(perChatValue(ab, undefined, ""), "");
  assert.equal(perChatValue(ab, "missing", ""), "");
  assert.equal(perChatValue({}, "constructor", ""), "", "an id that names an Object prototype key is still an empty chat");
  const isEmptyList = (value: readonly unknown[]) => value.length === 0;
  const pick = { path: "src/a.ts" };
  const picks = applyPerChatValue<{ path: string }[]>({}, "a", [pick], [], isEmptyList);
  assert.equal(
    applyPerChatValue(picks, "a", (current) => current.filter(() => true), [], isEmptyList),
    picks,
    "a filtered copy with the same picks keeps the same map, so typing does not re-render the app"
  );
});

test("each chat keeps its own unsent text while the User switches between chats", () => {
  installMemoryLocalStorage();
  let state: AppState | undefined;
  function Harness(): null {
    state = useAppState();
    return null;
  }
  const renderer = create(<Harness />);
  const current = (): AppState => {
    assert.ok(state);
    return state;
  };

  act(() => { current().setConversation(chat("chat-a")); });
  act(() => { current().setChatMessageDraft("typed in A"); });
  assert.equal(current().chatMessageDraft, "typed in A");

  act(() => { current().setConversation(chat("chat-b")); });
  assert.equal(current().chatMessageDraft, "", "another chat starts empty");
  act(() => { current().setChatMessageDraft((value) => value + "typed in B"); });

  act(() => { current().setConversation(chat("chat-a")); });
  assert.equal(current().chatMessageDraft, "typed in A", "coming back shows the text typed there");
  act(() => { current().setChatComposerFileMentions([{ path: "src/a.ts" }]); });
  act(() => { current().setConversation(chat("chat-b")); });
  assert.deepEqual(current().chatComposerFileMentions, [], "another chat has none of A's picks");
  act(() => { current().setConversation(chat("chat-a")); });
  assert.deepEqual(current().chatComposerFileMentions, [{ path: "src/a.ts" }], "A's picks come back with its text");

  act(() => { current().setConversation(undefined); });
  assert.equal(current().chatMessageDraft, "", "no open chat has no draft");
  act(() => { current().setChatMessageDraft("typed with no chat open"); });

  act(() => { current().setConversation(chat("chat-b")); });
  assert.equal(current().chatMessageDraft, "typed in B", "text typed with no chat open never lands in a chat");

  act(() => { current().setChatMessageDraftForConversation("chat-a", "set for A while B is open"); });
  act(() => { current().setChatComposerSkillMentions([{ frontmatterName: "review-skill" } as never]); });
  assert.equal(current().chatMessageDraft, "typed in B");
  assert.equal(current().chatComposerSkillMentions.length, 1);
  act(() => { current().clearChatMessageDraft("chat-b"); });
  assert.equal(current().chatMessageDraft, "");
  assert.equal(current().chatComposerSkillMentions.length, 0, "deleting a chat forgets its picks too");
  act(() => { current().setConversation(chat("chat-a")); });
  assert.equal(current().chatMessageDraft, "set for A while B is open");
  renderer.unmount();
});

test("a failed send restores the draft into the chat it was typed in, not the chat open now", async () => {
  let rejectSend: ((reason: Error) => void) | undefined;
  (globalThis as any).window = {
    consensus: {
      sendChatMessage: () => new Promise((_, reject) => {
        rejectSend = reject;
      })
    }
  };
  const drafts: Record<string, string> = { "chat-a": "typed in A" };
  const state = {
    conversation: chat("chat-a"),
    get chatMessageDraft() { return drafts[state.conversation.id] ?? ""; },
    progressLogRef: { current: [] },
    setChatMessageDraft: () => { throw new Error("send must name the chat it clears or restores"); },
    setChatMessageDraftForConversation: (conversationId: string, value: SetStateAction<string>) => {
      const previous = drafts[conversationId] ?? "";
      drafts[conversationId] = typeof value === "function" ? value(previous) : value;
    },
    setConversation: () => undefined,
    setError: () => undefined,
    setWarnings: () => undefined
  } as unknown as AppState & { conversation: { id: string } };
  let actions: ChatActions | undefined;
  function Harness(): null {
    actions = useChatActions(state, {} as ConversationActions);
    return null;
  }
  const renderer = create(<Harness />);
  let sendPromise: Promise<boolean> | undefined;
  act(() => {
    sendPromise = actions?.sendChatMessage();
  });
  assert.equal(drafts["chat-a"], "");

  (state as { conversation: unknown }).conversation = chat("chat-b");
  rejectSend?.(new Error("Claude Code was not detected."));
  await act(async () => {
    await sendPromise;
  });

  assert.equal(drafts["chat-a"], "typed in A");
  assert.equal(drafts["chat-b"] ?? "", "", "the chat opened meanwhile must not receive A's text");
  renderer.unmount();
});
