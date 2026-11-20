import assert from "node:assert/strict";
import test from "node:test";
import type { SetStateAction } from "react";
import { act, create } from "react-test-renderer";

import type { SendChatMessageRequest, StartReviewResult } from "../../shared/types";
import type { AppState } from "./app-state";
import { useChatActions, type ChatActions } from "./use-chat-actions";
import type { ConversationActions } from "./use-conversation-actions";

const conversation = {
  id: "chat-sessions",
  title: "Login bug",
  kind: "chat",
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  messages: [],
  findings: [],
  metadata: { participants: [{ id: "p-drew", handle: "drew", roleConfigId: "generic-participant", kind: "codex-cli" }] }
};

function harness(answer: (request: SendChatMessageRequest) => Promise<StartReviewResult>) {
  const requests: SendChatMessageRequest[] = [];
  (globalThis as { window?: unknown }).window = {
    consensus: { sendChatMessage: (request: SendChatMessageRequest) => { requests.push(request); return answer(request); } }
  };
  let draft = "the main composer's own draft";
  let error: string | undefined;
  const state = {
    conversation,
    chatMessageDraft: draft,
    progressLogRef: { current: [] },
    setChatMessageDraftForConversation: (_conversationId: string, value: SetStateAction<string>) => {
      draft = typeof value === "function" ? value(draft) : value;
    },
    setConversation: () => undefined,
    setMessagePage: () => undefined,
    setError: (value: string | undefined) => { error = value; },
    setWarnings: () => undefined,
    settings: { providers: [] },
    setSettings: () => undefined
  } as unknown as AppState;
  let actions: ChatActions | undefined;
  function Harness(): null {
    actions = useChatActions(state, {} as ConversationActions);
    return null;
  }
  const renderer = create(<Harness />);
  return { requests, renderer, actions: () => actions!, draft: () => draft, error: () => error };
}

test("a member panel's message goes to exactly that member and leaves the main composer's draft alone", async () => {
  const h = harness(() => Promise.reject(new Error("stop after the request")));
  let sent: boolean | undefined;
  await act(async () => {
    sent = await h.actions().sendChatMessage({ content: "Also check logout", targetParticipantIds: ["p-drew"], skillMentions: [] });
  });
  assert.equal(sent, false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0]!.targetParticipantIds, ["p-drew"]);
  assert.equal(h.requests[0]!.content, "Also check logout");
  assert.equal(h.requests[0]!.chatThreadRootId, undefined);
  assert.equal(h.draft(), "the main composer's own draft", "neither cleared before the send nor restored over after it failed");
  assert.equal(h.error(), "stop after the request");
  h.renderer.unmount();
});

test("a message from the main composer names no targets", async () => {
  const h = harness(() => Promise.reject(new Error("stop")));
  await act(async () => { await h.actions().sendChatMessage({ content: "Fix the login bug" }); });
  assert.equal("targetParticipantIds" in h.requests[0]!, false);
  h.renderer.unmount();
});
