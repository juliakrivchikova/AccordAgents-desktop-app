import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { AgentHealth, Conversation, StartReviewResult } from "../../shared/types";
import { useAppState, type AppState } from "./app-state";
import { DEFAULT_SETTINGS } from "./constants";
import { useAppEffects } from "./use-app-effects";
import { useAppViewModel } from "./use-app-view-model";
import { useChatActions, type ChatActions } from "./use-chat-actions";
import { useConversationActions, type ConversationActions } from "./use-conversation-actions";
import { useAppNavigation, type AppNavigation } from "./use-app-navigation";
import { ConversationPanel } from "../components/conversation/conversation-panel";
import { toast } from "sonner";
import { takeComposerFocusRequest } from "./composer-focus-request";
import { upsertConversationSummary } from "./conversation-summaries";

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
  const detect = deferred<AgentHealth[]>();
  const calls: string[] = [];
  let saved = conversation();
  let state!: AppState;
  let actions!: ChatActions;
  let navigation!: ConversationActions;
  let appNavigation!: AppNavigation;
  let createRunId: string | undefined;
  let announce: ((update: Conversation) => void) | undefined;
  window.consensus = {
    onConversationDeleted: () => () => {},
    onConversationUpdated: (callback: (update: Conversation) => void) => { announce = callback; return () => {}; },
    onReviewProgress: () => () => {},
    detectAgents: () => { calls.push("detect"); return detect.promise; },
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
    appNavigation = useAppNavigation(state, navigation);
    useAppEffects(state, async () => {}, async () => [], async () => {});
    const view = useAppViewModel(state);
    // The coordinating creation path is real; ChatConversationView itself is
    // covered separately once the created conversation is selected.
    return state.conversation ? null : <ConversationPanel state={state} view={view}
      chatActions={actions} conversationActions={navigation}
      reviewDecisionActions={{} as never} reviewPlanActions={{} as never} settingsActions={{} as never}
      artifacts={{} as never} onOpenAccord={() => {}} />;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    state.setSettings({ ...DEFAULT_SETTINGS, assistantProviderKind: "codex-cli",
      chatRoleConfigs: [{ id: "administrator", label: "Chat Assistant", instructions: "Assist the user.",
        version: 1, builtIn: true, updatedAt: "2026-09-13T00:00:00.000Z" },
      { id: "main-session", label: "Main session", instructions: "Work on the User's requests.",
        version: 1, builtIn: true, updatedAt: "2026-11-20T00:00:00.000Z" }],
      providers: [{ kind: "codex-cli", label: "Codex", enabled: true }] });
    state.setAgents([{ kind: "codex-cli", label: "Codex", installed: true, detection: "detected",
      runnable: "ready", authentication: "ready", lastCheckedAt: new Date().toISOString() }]);
    state.setQuestion("Draft must survive");
    state.setRepoPath("/project");
    state.setNewChatRepoFileMentions([{ path: "src/main.ts" }]);
  });
  return { renderer, creation, sent, opened, detect, calls, state: () => state, actions: () => actions, navigation: () => navigation, appNavigation: () => appNavigation,
    runId: () => createRunId,
    /** The app's snapshot of a chat, as conversations:updated announces it. */
    announce: (update: Conversation) => announce?.(update),
    saved: (value: Conversation) => { saved = value; } };
}

test("Stop while the chat is being made preserves the draft and unlocks retry", async () => {
  const h = await harness();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  assert.ok(h.runId(), h.state().error);
  // New chat stays on screen while the chat is made (no card, no blank
  // frame, the User 2026-11-22), and says nothing over its composer (the
  // User 2026-11-26: the "Creating your chat" line is gone).
  assert.equal(h.renderer.toJSON(), null);
  await act(async () => { await h.navigation().cancelReview(); });
  await act(async () => { h.creation.reject(new Error("Chat creation cancelled.")); assert.equal(await pending, false); });
  assert.equal(h.state().busy, false);
  assert.equal(h.state().question, "Draft must survive");
  assert.deepEqual(h.state().newChatRepoFileMentions, [{ path: "src/main.ts" }]);
  assert.equal(h.state().startingChatRef.current, false);
  assert.deepEqual(h.calls, ["create", `stop:${h.runId()}`]);
  await act(async () => { h.renderer.unmount(); });
});

test("a send that waits for the CLI check shows at once, and Stop meanwhile makes no chat", async () => {
  const h = await harness();
  const agents = h.state().agents;
  await act(async () => { h.state().setAgents(agents.map((agent) => ({ ...agent, lastCheckedAt: "2026-09-13T00:00:00.000Z" }))); });
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  assert.deepEqual(h.calls, ["detect"]);
  // Enter shows at once (the User, 2026-11-22): the send is busy while New
  // chat, with its choices, stays on screen; no run exists in main yet.
  assert.equal(h.state().busy, true);
  assert.equal(h.state().currentRunId, undefined);
  assert.equal(h.renderer.toJSON(), null, "New chat stays: no creation card over it");
  await act(async () => { await h.navigation().cancelReview(); });
  await act(async () => { h.detect.resolve(agents); assert.equal(await pending, false); });
  assert.deepEqual(h.calls, ["detect"], "Stop makes no chat and asks main for nothing");
  assert.equal(h.state().busy, false);
  assert.equal(h.state().question, "Draft must survive");
  assert.equal(h.state().startingChatRef.current, false);
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
  await act(async () => { h.creation.resolve({ conversation: conversation(), warnings: [] }); });
  await act(async () => { h.sent.resolve({ conversation: conversation(), warnings: [] }); assert.equal(await pending, true); });
  assert.deepEqual(h.calls, ["create", `send:${h.runId()}`]);
  assert.equal(h.state().conversation?.id, "created");
  assert.equal(h.state().question, "");
  assert.equal(h.state().busy, false);
  assert.equal(h.state().chatCreationRef.current, undefined);
  await act(async () => { h.renderer.unmount(); });
});

// The User, 2026-11-22: a "Loading chat" card flashed for a tenth of a second
// on every open. A quick open keeps the screen as it was; a slow one shows
// only a thin bar.
test("opening a chat shows no loading card: the screen stays, then only a bar if the wait lasts", async () => {
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  let loading!: Promise<void>;
  await act(async () => { loading = h.navigation().openConversation("slow"); });
  assert.equal(h.state().openingConversationId, "slow");
  assert.equal(h.renderer.toJSON(), null, "the New chat screen stays: no panel, no card");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  const shown = JSON.stringify(h.renderer.toJSON());
  assert.doesNotMatch(shown, /app-loading-state/);
  assert.equal(h.renderer.root.findAll((node) => node.props?.role === "progressbar").length, 1, "a slow open shows the bar");
  await act(async () => { h.opened.resolve({ conversation: { ...conversation(), id: "slow" } }); await loading; });
  assert.equal(h.state().conversation?.id, "slow");
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

test("a rename while the chat's member is answering changes only the open chat's name; its live reply stays", async () => {
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  const live: Conversation = { ...conversation(), id: "chat-a", title: "Old name",
    metadata: { running: true, activeRunIds: ["run-1"], participants: [] },
    messages: [{ id: "reply-1", role: "participant", participantId: "member-1", content: "Half of an answer", status: "pending",
      createdAt: "2026-09-13T00:00:01.000Z", metadata: { runId: "run-1" } }] };
  const renamed: Array<{ conversationId: string; title: string }> = [];
  Object.assign(window.consensus, {
    openConversation: async () => ({ conversation: live }),
    renameChatConversation: async (request: { conversationId: string; title: string }) => {
      renamed.push(request);
      return { conversationId: request.conversationId, title: "New name" };
    }
  });
  await act(async () => { await h.navigation().openConversation("chat-a"); });
  const before = h.state().conversation!;
  let ok = false;
  await act(async () => { ok = await h.actions().renameChatConversation("New name"); });
  assert.equal(ok, true);
  assert.deepEqual(renamed, [{ conversationId: "chat-a", title: "New name" }]);
  const after = h.state().conversation!;
  assert.equal(after.title, "New name");
  assert.equal(after.messages, before.messages, "the live reply is left as shown");
  assert.equal(after.metadata, before.metadata, "and so is the run state");
  assert.equal(h.state().error, undefined);
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

// Without a Toaster on screen, sonner keeps every notice until it is dismissed by id.
function clearNotices(): void {
  for (const item of toast.getToasts()) toast.dismiss(item.id);
}

// Fork to new chat takes up to a second or so to make its chat. What she
// opened meanwhile is her later choice: the fork does not replace it nor take
// its keyboard; it is listed and a notice offers to open it. Driven through
// the app's own navigation (sidebar, Settings, Back), as App.tsx
// wires it.
async function forkHarness() {
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const h = await harness();
  const chat = (id: string): Conversation => ({ ...conversation(), id, title: id });
  const fork: Conversation = { ...chat("fork"), title: "source (fork)" };
  Object.assign(window.consensus, {
    openConversation: async (id: string) => ({ conversation: id === "fork" ? fork : chat(id) }),
    listConversations: async () => upsertConversationSummary([], fork)
  });
  await act(async () => { await h.navigation().openConversation("source"); });
  assert.equal(h.state().conversation?.id, "source");
  clearNotices();
  // Nothing left over from an earlier test.
  takeComposerFocusRequest("fork");
  let pending!: Promise<boolean>;
  const startFork = async () => {
    await act(async () => {
      pending = h.actions().forkChatParticipantToNewChat("member", { openChat: (id) => h.appNavigation().openChat(id) });
    });
  };
  const finishFork = async (outcome: "made" | "refused" = "made") => {
    await act(async () => {
      if (outcome === "made") h.creation.resolve({ conversation: fork, warnings: [] });
      else h.creation.reject(new Error("@member cannot be forked to a new chat: Codex CLI requires sign-in."));
      await pending;
    });
    return pending;
  };
  // What it says once made or refused (the "Forking…" notice is checked elsewhere).
  const notices = () => toast.getToasts().filter((item) => "title" in item && (item as { type?: string }).type !== "loading").map((item) => ({
    type: (item as { type?: string }).type, title: (item as { title?: unknown }).title,
    action: (item as { action?: { label?: unknown } }).action?.label
  }));
  const clickOpen = async () => {
    const notice = toast.getToasts().find((item) => "title" in item && item.title === "Forked to a new chat: source (fork)") as { action?: { onClick: (event: unknown) => void } } | undefined;
    assert.ok(notice?.action, "the notice offers Open");
    // A click on Open puts the keyboard on the notice's button; sonner would
    // hand it back to what had it before once the notice goes, over the
    // fork's composer. Open lets go of it first.
    const toaster = document.createElement("ol");
    toaster.dataset.sonnerToaster = "true";
    const button = document.createElement("button");
    toaster.append(button);
    document.body.append(toaster);
    button.focus();
    assert.equal(document.activeElement, button);
    await act(async () => { notice.action!.onClick({}); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.notEqual(document.activeElement, button, "the notice's button lets go of the keyboard");
    toaster.remove();
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { h, fork, startFork, finishFork, notices, clickOpen, settle };
}

test("a fork made after she opened another chat leaves that chat on screen with its keyboard, lists the fork and offers to open it", async () => {
  const f = await forkHarness();
  await f.startFork();
  await act(async () => { f.h.appNavigation().openChat("other"); });
  await f.settle();
  assert.equal(await f.finishFork(), true);
  assert.equal(f.h.state().conversation?.id, "other", "the chat she opened stays");
  assert.equal(f.h.state().railView, "chats");
  assert.equal(f.h.state().startingChatRef.current, false, "a new chat may start");
  assert.equal(takeComposerFocusRequest("fork"), false, "the fork's composer is not asked to take the keyboard");
  assert.ok(f.h.state().summaries.some((summary) => summary.id === "fork"), "the fork is listed");
  assert.deepEqual(f.notices(), [{ type: "success", title: "Forked to a new chat: source (fork)", action: "Open" }]);
  // Open, from the notice: the fork opens with its keyboard, as the sidebar opens a chat.
  await f.clickOpen();
  assert.equal(f.h.state().conversation?.id, "fork");
  assert.equal(takeComposerFocusRequest("fork"), true);
  clearNotices();
  await act(async () => { f.h.renderer.unmount(); });
});

test("a fork made after she went to New chat or Settings leaves her there; Open takes her to it", async () => {
  for (const leave of ["new chat", "settings"] as const) {
    const f = await forkHarness();
    await f.startFork();
    await act(async () => {
      if (leave === "new chat") await f.h.navigation().newChatSession();
      else f.h.appNavigation().openSettingsSection("general");
    });
    await f.settle();
    assert.equal(await f.finishFork(), true, leave);
    assert.equal(f.h.state().railView, leave === "new chat" ? "chats" : leave, leave);
    assert.equal(f.h.state().conversation?.id, leave === "new chat" ? undefined : "source", leave);
    assert.equal(takeComposerFocusRequest("fork"), false, leave);
    assert.deepEqual(f.notices(), [{ type: "success", title: "Forked to a new chat: source (fork)", action: "Open" }], leave);
    await f.clickOpen();
    assert.deepEqual({ railView: f.h.state().railView, open: f.h.state().conversation?.id, keyboard: takeComposerFocusRequest("fork") },
      { railView: "chats", open: "fork", keyboard: true }, `${leave}: Open shows the fork in Chats with its keyboard`);
    clearNotices();
    await act(async () => { f.h.renderer.unmount(); });
  }
});

test("Open on a fork's notice never leaves its keyboard request behind for a later visit", async () => {
  const f = await forkHarness();
  await f.startFork();
  await act(async () => { f.h.appNavigation().openChat("other"); });
  await f.settle();
  await f.finishFork();
  // Open, then another chat before the fork has loaded: the fork's request goes.
  const notice = toast.getToasts().find((item) => "title" in item && item.title === "Forked to a new chat: source (fork)") as { action: { onClick: (event: unknown) => void } };
  await act(async () => {
    notice.action.onClick({});
    f.h.appNavigation().openChat("third");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(f.h.state().conversation?.id, "third");
  assert.equal(takeComposerFocusRequest("fork"), false, "dropped when another chat opened");
  clearNotices();
  await act(async () => { f.h.renderer.unmount(); });
});

test("a fork she stayed for opens with its keyboard, also after Settings and back, or a click on her chat", async () => {
  for (const meanwhile of ["nothing", "Settings and back", "the same chat clicked"] as const) {
    const f = await forkHarness();
    await f.startFork();
    const nav = () => f.h.appNavigation();
    if (meanwhile === "Settings and back") {
      await act(async () => { nav().openSettingsSection("general"); });
      await act(async () => { nav().returnToChats(); });
    }
    if (meanwhile === "the same chat clicked") await act(async () => { nav().openChat("source"); });
    await f.settle();
    assert.equal(f.h.state().conversation?.id, "source", `${meanwhile}: back on her chat`);
    assert.equal(await f.finishFork(), true, meanwhile);
    assert.equal(f.h.state().conversation?.id, "fork", meanwhile);
    assert.equal(f.h.state().railView, "chats", meanwhile);
    assert.equal(takeComposerFocusRequest("fork"), true, meanwhile);
    assert.deepEqual(f.notices(), [], `${meanwhile}: no notice, the chat itself is on screen`);
    await act(async () => { f.h.renderer.unmount(); });
  }
});

test("a chat she made herself is not unread: New chat, a fork she stayed for, and one made after she left; what comes after still is", async () => {
  // New chat: the app announces the chat while it is made, before it is on screen.
  const h = await harness();
  const made = conversation();
  let pending!: Promise<boolean>;
  await act(async () => { pending = h.actions().startChat(); });
  await act(async () => { h.announce(made); });
  await act(async () => { h.creation.resolve({ conversation: made, warnings: [] }); });
  const sent = { ...made, updatedAt: "2026-09-13T00:00:01.000Z" };
  await act(async () => { h.announce(sent); h.sent.resolve({ conversation: sent, warnings: [] }); assert.equal(await pending, true); });
  assert.equal(h.state().conversation?.id, "created");
  // She goes elsewhere: her own chat has no dot.
  await act(async () => { h.state().setConversation({ ...conversation(), id: "elsewhere" }); });
  assert.equal(h.state().unreadConversationIds.has("created"), false, "New chat: nothing in it she has not seen");
  // A member's reply after she left is news.
  await act(async () => { h.announce({ ...made, updatedAt: "2026-09-13T00:00:09.000Z" }); });
  assert.equal(h.state().unreadConversationIds.has("created"), true, "a reply after she left");
  await act(async () => { h.renderer.unmount(); });

  for (const stayed of [true, false]) {
    const f = await forkHarness();
    await f.startFork();
    if (!stayed) {
      await act(async () => { f.h.appNavigation().openChat("other"); });
      await f.settle();
    }
    // Announced while it is made, before she could have opened it.
    await act(async () => { f.h.announce(f.fork); });
    assert.equal(await f.finishFork(), true);
    // Announced again once made (the server's copy of it, the same moment).
    await act(async () => { f.h.announce(f.fork); });
    await act(async () => { f.h.appNavigation().openChat("third"); });
    await f.settle();
    assert.equal(f.h.state().conversation?.id, "third");
    assert.equal(f.h.state().unreadConversationIds.has("fork"), false, stayed ? "a fork she stayed for" : "a fork made after she left");
    await act(async () => { f.h.announce({ ...f.fork, updatedAt: "2026-09-13T00:00:09.000Z" }); });
    assert.equal(f.h.state().unreadConversationIds.has("fork"), true, `${stayed ? "stayed" : "left"}: what comes after is news`);
    clearNotices();
    await act(async () => { f.h.renderer.unmount(); });
  }
});

test("a fork refused after she went elsewhere says so by a notice, not in the chat she opened", async () => {
  const f = await forkHarness();
  await f.startFork();
  await act(async () => { f.h.appNavigation().openChat("other"); });
  await f.settle();
  assert.equal(await f.finishFork("refused"), false);
  assert.equal(f.h.state().conversation?.id, "other");
  assert.equal(f.h.state().error, undefined);
  assert.equal(f.h.state().startingChatRef.current, false);
  assert.deepEqual(f.notices(), [{ type: "error", title: "@member cannot be forked to a new chat: Codex CLI requires sign-in.", action: undefined }]);
  clearNotices();
  await act(async () => { f.h.renderer.unmount(); });
  // Stayed: in the chat's error, as before.
  const g = await forkHarness();
  await g.startFork();
  assert.equal(await g.finishFork("refused"), false);
  assert.equal(g.h.state().conversation?.id, "source");
  assert.match(String(g.h.state().error), /cannot be forked to a new chat/);
  assert.deepEqual(g.notices(), []);
  await act(async () => { g.h.renderer.unmount(); });
});
