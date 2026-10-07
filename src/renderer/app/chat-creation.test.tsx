import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Conversation, ReviewProgress, StartReviewResult } from "../../shared/types";
import { useAppState, type AppState } from "./app-state";
import { DEFAULT_SETTINGS } from "./constants";
import { useAppEffects } from "./use-app-effects";
import { useAppViewModel } from "./use-app-view-model";
import { useChatActions, type ChatActions } from "./use-chat-actions";
import { useConversationActions, type ConversationActions } from "./use-conversation-actions";
import { ConversationPanel } from "../components/conversation/conversation-panel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const conversation = (): Conversation => ({ id: "created", title: "hello", kind: "chat",
  createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
  messages: [], findings: [], metadata: { running: false, participants: [] } });

async function harness() {
  const creation = deferred<StartReviewResult>();
  const sent = deferred<StartReviewResult>();
  const opened = deferred<{ conversation: Conversation }>();
  const calls: string[] = [];
  let saved = conversation();
  let state!: AppState;
  let actions!: ChatActions;
  let navigation!: ConversationActions;
  let progress!: (event: ReviewProgress) => void;
  let createRunId: string | undefined;
  window.consensus = {
    onConversationDeleted: () => () => {},
    onConversationUpdated: () => () => {},
    onReviewProgress: callback => { progress = callback; return () => {}; },
    createChatConversation: request => { calls.push("create"); createRunId = request.runId; return creation.promise; },
    sendChatMessage: request => { calls.push(`send:${request.runId}`); return sent.promise; },
    cancelReview: async runId => { calls.push(`stop:${runId}`); },
    getConversation: async () => saved,
    openConversation: () => opened.promise,
    getSettings: async () => state.settings,
    setChatArchived: async request => {
      assert.equal(request.onlyIfEmpty, true);
      calls.push("archive-if-empty");
      if (saved.messages.every(item => item.role === "system") && !saved.metadata.running) {
        saved = { ...saved, metadata: { ...saved.metadata, archived: true } };
      }
      return saved;
    },
    listConversations: async () => []
  } as unknown as typeof window.consensus;
  function Harness() {
    state = useAppState();
    navigation = useConversationActions(state);
    actions = useChatActions(state, navigation);
    useAppEffects(state, async () => {}, async () => [], async () => {});
    const view = useAppViewModel(state);
    // The coordinating creation path is real; ChatConversationView itself is
    // covered separately once the created conversation is selected.
    return state.conversation ? null : <ConversationPanel state={state} view={view}
      chatActions={actions} conversationActions={navigation} openingConversationDescription="Loading"
      reviewDecisionActions={{} as never} reviewPlanActions={{} as never} settingsActions={{} as never}
      artifacts={{} as never} onOpenAccord={() => {}} />;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    state.setSettings({ ...DEFAULT_SETTINGS, assistantProviderKind: "codex-cli",
      chatRoleConfigs: [{ id: "administrator", label: "Chat Assistant", instructions: "Assist the user.",
        version: 1, builtIn: true, updatedAt: "2026-09-13T00:00:00.000Z" }],
      providers: [{ kind: "codex-cli", label: "Codex", enabled: true }] });
    state.setAgents([{ kind: "codex-cli", label: "Codex", installed: true, detection: "detected",
      runnable: "ready", authentication: "ready", lastCheckedAt: new Date().toISOString() }]);
    state.setQuestion("Draft must survive");
    state.setRepoPath("/project");
    state.setNewChatRepoFileMentions([{ path: "src/main.ts" }]);
  });
  return { renderer, creation, sent, opened, calls, state: () => state, actions: () => actions, navigation: () => navigation,
    progress: (event: ReviewProgress) => progress(event), runId: () => createRunId,
    saved: (value: Conversation) => { saved = value; } };
}

test("New Chat shows only its own preparation progress; Stop preserves the draft and unlocks retry", async () => {
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  assert.ok(h.runId(), h.state().error);
  assert.match(JSON.stringify(h.renderer.toJSON()), /Starting chat/);
  assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()), /No conversation selected/);
  await act(async () => {
    h.progress({ runId: h.runId()!, phase: "initial", message: "Copying project · 42%", createdAt: new Date().toISOString() });
    h.progress({ runId: "other-chat", phase: "initial", message: "UNRELATED", createdAt: new Date().toISOString() });
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.match(JSON.stringify(h.renderer.toJSON()), /42%/);
  assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()), /UNRELATED/);
  await act(async () => { await h.navigation().cancelReview(); });
  assert.match(JSON.stringify(h.renderer.toJSON()), /Stopping preparation/);
  await act(async () => { h.creation.reject(new Error("Chat creation cancelled.")); assert.equal(await pending, false); });
  assert.equal(h.state().busy, false);
  assert.equal(h.state().question, "Draft must survive");
  assert.deepEqual(h.state().newChatRepoFileMentions, [{ path: "src/main.ts" }]);
  assert.equal(h.state().startingChatRef.current, false);
  assert.deepEqual(h.calls, ["create", `stop:${h.runId()}`]);
  await act(async () => { h.renderer.unmount(); });
});

test("Stop after persistence but before the create reply never dispatches the first message", async () => {
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  await act(async () => { await h.navigation().cancelReview(); });
  await act(async () => { h.creation.resolve({ conversation: conversation(), warnings: [] }); assert.equal(await pending, false); });
  assert.equal(h.state().conversation, undefined);
  assert.equal(h.state().question, "Draft must survive");
  assert.deepEqual(h.calls, ["create", `stop:${h.runId()}`, "archive-if-empty"]);
  await act(async () => { h.renderer.unmount(); });
});

test("a send failure after persistence keeps the delivered message and does not archive the chat", async () => {
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  await act(async () => { h.creation.resolve({ conversation: conversation(), warnings: [] }); });
  const delivered = conversation();
  delivered.messages.push({ id: "user-message", role: "user", content: "Draft must survive", createdAt: delivered.createdAt });
  h.saved(delivered);
  await act(async () => { h.sent.reject(new Error("failed after ingest")); assert.equal(await pending, false); });
  assert.equal(h.state().conversation?.messages[0].id, "user-message");
  assert.equal(h.state().error, "failed after ingest");
  assert.equal(h.state().conversation?.metadata.archived, undefined);
  await act(async () => { h.renderer.unmount(); });
});

test("successful creation sends once, clears the draft, and a duplicate Start cannot join it", async () => {
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  await act(async () => { assert.equal(await h.actions().startChat(), false); });
  // Activity opened while the chat was being created: Back lands on the new chat.
  h.state().chatBeforeActivityRef.current = {};
  await act(async () => { h.creation.resolve({ conversation: conversation(), warnings: [] }); });
  assert.deepEqual(h.state().chatBeforeActivityRef.current, { conversationId: "created" });
  await act(async () => { h.sent.resolve({ conversation: conversation(), warnings: [] }); assert.equal(await pending, true); });
  assert.deepEqual(h.calls, ["create", `send:${h.runId()}`]);
  assert.equal(h.state().conversation?.id, "created");
  assert.equal(h.state().question, "");
  assert.equal(h.state().busy, false);
  assert.equal(h.state().chatCreationRef.current, undefined);
  await act(async () => { h.renderer.unmount(); });
});

test("Back from an Activity preview drops it, keeps the draft, and gives it a dot only for news it never showed", async () => {
  const h = await harness();
  const [before, after] = ["2026-09-13T00:00:00.000Z", "2026-09-13T00:00:05.000Z"];
  // [last viewed, loaded as a preview at, dot]
  const cases = [[before, undefined, true], [after, undefined, false], [undefined, before, true], [undefined, after, false], [undefined, undefined, false]] as const;
  for (const [lastViewed, previewLoadedAt, dot] of cases) {
    await act(async () => {
      h.state().lastViewedAtRef.current = lastViewed ? { preview: lastViewed } : {};
      h.state().previewLoadedAtRef.current = previewLoadedAt ? { preview: previewLoadedAt } : {};
      h.state().setUnreadConversationIds(new Set());
      h.state().setConversation({ ...conversation(), id: "preview", updatedAt: after });
    });
    await act(async () => { h.navigation().returnToNewChatDraft(); });
    assert.equal(h.state().conversation, undefined);
    assert.equal(h.state().question, "Draft must survive");
    assert.equal(h.state().unreadConversationIds.has("preview"), dot, `viewed ${lastViewed}, previewed ${previewLoadedAt}`);
  }
  await act(async () => { h.renderer.unmount(); });
});

test("a preview still loading when Back is pressed never lands on screen or counts as viewed", async () => {
  // jsdom has no animation frames; opening a chat waits for one.
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  let loading!: Promise<void>;
  await act(async () => { loading = h.navigation().openConversation("late"); });
  assert.equal(h.state().openingConversationId, "late");
  await act(async () => { h.navigation().returnToNewChatDraft(); });
  await act(async () => { h.opened.resolve({ conversation: { ...conversation(), id: "late" } }); await loading; });
  assert.equal(h.state().conversation, undefined);
  assert.equal(h.state().openingConversationId, undefined);
  assert.equal(h.state().lastViewedAtRef.current.late, undefined);
  assert.equal(h.state().question, "Draft must survive");
  await act(async () => { h.renderer.unmount(); });
});

// The User, 2026-10-07: "I'm on one screen and it throws me to another". A card
// answered in one chat landed seconds later and replaced the chat opened since.
test("a late card answer never takes the screen back from the chat opened since", async () => {
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  const answer = deferred<StartReviewResult>();
  const chat = (id: string): Conversation => ({ ...conversation(), id, title: id });
  Object.assign(window.consensus, {
    openConversation: async (id: string) => ({ conversation: chat(id) }),
    respondToChatChoice: () => answer.promise
  });
  await act(async () => { await h.navigation().openConversation("chat-a"); });
  assert.equal(h.state().conversation?.id, "chat-a");
  let pending!: Promise<void>;
  await act(async () => { pending = h.actions().respondToChatChoice("message-1", "choice-1", { cancel: true }); });
  await act(async () => { await h.navigation().openConversation("chat-b"); });
  assert.equal(h.state().conversation?.id, "chat-b");
  await act(async () => { answer.resolve({ conversation: { ...chat("chat-a"), title: "answered" }, warnings: ["about chat A"] }); await pending; });
  assert.equal(h.state().conversation?.id, "chat-b");
  assert.deepEqual(h.state().warnings, []);
  await act(async () => { h.renderer.unmount(); });
});

test("a card answer that lands while its chat is still open updates that chat", async () => {
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  const chat = (id: string): Conversation => ({ ...conversation(), id, title: id });
  Object.assign(window.consensus, {
    openConversation: async (id: string) => ({ conversation: chat(id) }),
    respondToChatChoice: async () => ({ conversation: { ...chat("chat-a"), title: "answered" }, warnings: [] })
  });
  await act(async () => { await h.navigation().openConversation("chat-a"); });
  await act(async () => { await h.actions().respondToChatChoice("message-1", "choice-1", { cancel: true }); });
  assert.equal(h.state().conversation?.title, "answered");
  await act(async () => { h.renderer.unmount(); });
});

test("Back from Activity while the new chat is being created still lands on the new chat", async () => {
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  // Back from Activity drops any preview first; that is not another chat opened.
  await act(async () => { h.navigation().returnToNewChatDraft(); });
  await act(async () => { h.creation.resolve({ conversation: conversation(), warnings: [] }); });
  await act(async () => { h.sent.resolve({ conversation: conversation(), warnings: [] }); assert.equal(await pending, true); });
  assert.equal(h.state().conversation?.id, "created");
  await act(async () => { h.renderer.unmount(); });
});

test("a chat opened from the sidebar while the new chat is being created stays on screen", async () => {
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  let opening!: Promise<void>;
  await act(async () => { opening = h.navigation().openConversation("other"); });
  await act(async () => { h.opened.resolve({ conversation: { ...conversation(), id: "other", title: "other" } }); await opening; });
  assert.equal(h.state().conversation?.id, "other");
  await act(async () => { h.creation.resolve({ conversation: conversation(), warnings: [] }); });
  await act(async () => { h.sent.resolve({ conversation: conversation(), warnings: [] }); assert.equal(await pending, true); });
  assert.equal(h.state().conversation?.id, "other");
  await act(async () => { h.renderer.unmount(); });
});
