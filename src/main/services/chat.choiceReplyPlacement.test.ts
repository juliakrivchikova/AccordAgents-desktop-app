import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatMessageHiddenFromTimeline, chatMessageVisualThreadRootId } from "../../shared/chatParticipantRequestThreads";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import type { ChatMessage, ChatParticipant, ChatRoleConfig, Conversation, ParticipantConfig } from "../../shared/types";
import { ChatService } from "./chat";
import { timelineEventsFromSnapshot } from "./mobileTimeline";

/**
 * A member answers a choice where its card stands (the User, 2026-11-04): in
 * the card's thread when the card is in one, otherwise on the main timeline,
 * never in a new thread under the card. Driven through the real send, turn
 * and choice paths, with the member's CLI played by the test; placement is
 * read with the helper the desktop and the phone draw threads with.
 */

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = { id: "generic-participant", label: "Generic participant", instructions: "Answer directly.", version: 1, updatedAt: NOW };
const ASKING = ["Which store should I use?", "", "User choice:", "T: Store", "Q: Which store?", "O1: SQLite | fast", "O2: Files", "R: O1"].join("\n");
const ANSWER = "Going with SQLite.";

function member(id: string, handle: string): ChatParticipant {
  return { id, handle, roleConfigId: ROLE.id, kind: "codex-cli", agentMode: "default", permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()) };
}
const taylor = member("taylor-id", "taylor");
const drew = member("drew-id", "drew");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Each member's replies, in order; a member with none left says "ok". */
function harness(replies: Record<string, string[]>, messages: ChatMessage[] = []) {
  const initial: Conversation = { id: "chat-placement", title: "Plans", kind: "chat", createdAt: NOW, updatedAt: NOW, messages, findings: [],
    metadata: { participants: [taylor, drew], participantSessions: [] } };
  const storage = {
    current: clone(initial),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(saved: Conversation): Promise<void> {
      this.current = clone(saved);
    },
    async conversationIdsWithPendingChoices(): Promise<string[]> {
      return this.current.messages.some((message) => message.metadata?.pendingChoice?.status === "pending") ? [this.current.id] : [];
    }
  };
  const settings = {
    async getPublicSettings() {
      return { chatRoleConfigs: [ROLE], chatBehaviorRules: [], providers: [{ kind: "codex-cli", enabled: true }], chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT };
    }
  };
  const runs: string[] = [];
  const cliRunner = {
    async detectAgents() { return [{ kind: "codex-cli", label: "Codex CLI", installed: true }]; },
    async run(participant: ParticipantConfig) {
      runs.push(participant.id);
      return { participant, ok: true, content: replies[participant.id]?.shift() ?? "ok", durationMs: 1 };
    }
  };
  const service = new ChatService(storage as never, settings as never, cliRunner as never, { async write() {} } as never);
  const internals = service as unknown as {
    ensureHistoryFiles: () => Promise<string>;
    choiceExpiryTimers: Map<string, { timer: NodeJS.Timeout }>;
  };
  internals.ensureHistoryFiles = async () => tmpdir();
  const stored = () => storage.current;
  const settle = async () => {
    await until(() => !stored().messages.some((message) => message.status === "pending") && stored().metadata.running !== true);
    await service.settleChatSaves();
  };
  const send = async (content: string, thread?: ChatMessage) => {
    await service.sendMessage({
      conversationId: initial.id, content,
      // As the desktop's thread composer sends (conversation-panel onSendThread).
      ...(thread ? { threadId: thread.metadata?.threadId ?? thread.id, parentMessageId: thread.id, chatThreadRootId: thread.id } : {})
    });
    const sent = [...stored().messages].reverse().find((message) => message.role === "user" && message.content === content);
    assert.ok(sent, "the message was taken");
    await until(() => stored().messages.some((message) => message.role === "participant" && message.metadata?.sourceMessageId === sent.id &&
      message.status !== "pending"));
    await settle();
  };
  const asking = () => stored().messages.find((message) => message.metadata?.pendingChoice)!;
  const answerChoice = async () => {
    const card = asking();
    const choice = card.metadata!.pendingChoice!;
    await service.respondToChoice({ conversationId: initial.id, sourceMessageId: card.id, choiceId: choice.id, selectedOptionId: choice.options[0].id });
    await until(() => stored().messages.some((message) => message.content === ANSWER && message.status !== "pending"));
    await settle();
    return stored().messages.find((message) => message.content === ANSWER)!;
  };
  const choiceAnswer = () => stored().messages.find((message) => message.role === "user" && message.metadata?.sourceMessageId === asking().id)!;
  const rootOf = (message: ChatMessage) => chatMessageVisualThreadRootId(stored(), message);
  const visible = (message: ChatMessage) => !chatMessageHiddenFromTimeline(stored(), message);
  const stopTimers = () => {
    for (const { timer } of internals.choiceExpiryTimers.values()) clearTimeout(timer);
    internals.choiceExpiryTimers.clear();
  };
  const phoneEvents = () => timelineEventsFromSnapshot(stored(), 1_000);
  return { stored, runs, send, asking, answerChoice, choiceAnswer, rootOf, visible, phoneEvents, stopTimers };
}

async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a card on the main timeline: the member's answer goes on the main timeline, no thread under the card", async (t) => {
  const h = harness({ [taylor.id]: [ASKING, ANSWER] });
  t.after(h.stopTimers);
  await h.send("@taylor which store?");
  const card = h.asking();
  assert.equal(h.rootOf(card), undefined, "the card is on the main timeline");

  const reply = await h.answerChoice();
  assert.equal(h.rootOf(reply), undefined, "the reply is on the main timeline");
  assert.equal(h.visible(reply), true);
  assert.equal(reply.metadata?.chatThreadRootId, undefined);
  const answer = h.choiceAnswer();
  assert.equal(answer.metadata?.hiddenFromTimeline, true, "her pick shows only on the card");
  assert.equal(answer.metadata?.chatThreadRootId, undefined);
  assert.equal(answer.metadata?.parentMessageId, card.id);
  const underCard = h.stored().messages.filter((message) => h.visible(message) && h.rootOf(message) === card.id);
  assert.deepEqual(underCard, [], "nothing is shown in a thread under the card");
  assert.equal(h.stored().messages.find((message) => message.id === card.id)?.metadata?.pendingChoice?.status, "selected");
  // The phone draws it on the main timeline too, and never gets the hidden pick.
  const phone = h.phoneEvents();
  assert.equal(phone.find((event) => event.id === reply.id)?.threadRootId, undefined);
  assert.ok(phone.some((event) => event.id === reply.id));
  assert.equal(phone.some((event) => event.id === answer.id), false);
});

test("a card in a thread: the member's answer stays in that thread", async (t) => {
  const h = harness({ [taylor.id]: ["Let's plan.", ASKING, ANSWER] });
  t.after(h.stopTimers);
  await h.send("@taylor let's plan");
  const root = h.stored().messages.find((message) => message.role === "user")!;
  await h.send("@taylor which store?", root);
  const card = h.asking();
  assert.equal(h.rootOf(card), root.id, "the card is in the thread");

  const reply = await h.answerChoice();
  assert.equal(h.rootOf(reply), root.id, "the reply is in the card's thread");
  assert.equal(h.visible(reply), true);
  const answer = h.choiceAnswer();
  assert.equal(answer.metadata?.hiddenFromTimeline, true);
  assert.equal(answer.metadata?.chatThreadRootId, root.id);
  const underCard = h.stored().messages.filter((message) => h.visible(message) && h.rootOf(message) === card.id);
  assert.deepEqual(underCard, [], "no thread opens under the card inside the thread");
  assert.equal(h.phoneEvents().find((event) => event.id === reply.id)?.threadRootId, root.id);
});

test("a card in a member request's thread, with no stored thread root: the answer stays in that thread", async (t) => {
  // @drew asked @taylor on the main timeline; @taylor's reply, which carries
  // the card, is drawn in the request's thread only through the request.
  const at = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
  const ask: ChatMessage = { id: "ask", role: "user", content: "@drew check with taylor", createdAt: at(0), status: "done" };
  const request: ChatMessage = {
    id: "request", role: "participant", participantId: drew.id, participantLabel: "@drew", content: "Asking @taylor.", createdAt: at(1), status: "done",
    metadata: {
      parentMessageId: ask.id, sourceMessageId: ask.id,
      participantRequest: {
        id: "batch", requesterParticipantId: drew.id, requesterHandle: "drew", source: "mcp", resumeRequester: false, status: "answered", depth: 0,
        createdAt: at(1), updatedAt: at(2), triggerMessageId: ask.id,
        items: [{ targetParticipantId: taylor.id, targetHandle: "taylor", prompt: "Which store?", status: "answered", replyMessageId: "card", createdAt: at(1), updatedAt: at(2) }]
      }
    }
  };
  const card: ChatMessage = {
    id: "card", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Which store should I use?", createdAt: at(2), status: "done",
    metadata: {
      parentMessageId: request.id, sourceMessageId: request.id,
      pendingChoice: { id: "choice-1", title: "Store", question: "Which store?", options: [{ id: "sqlite", label: "SQLite" }, { id: "files", label: "Files" }], status: "pending", askedAt: at(2) }
    }
  };
  const h = harness({ [taylor.id]: [ANSWER] }, [ask, request, card]);
  t.after(h.stopTimers);
  assert.equal(h.rootOf(h.asking()), request.id, "the card is in the request's thread");

  const reply = await h.answerChoice();
  assert.equal(h.rootOf(reply), request.id, "the reply is in the request's thread");
  assert.equal(h.visible(reply), true);
  assert.equal(h.choiceAnswer().metadata?.chatThreadRootId, request.id);
  const underCard = h.stored().messages.filter((message) => h.visible(message) && h.rootOf(message) === card.id);
  assert.deepEqual(underCard, [], "no thread opens under the card");
});

test("after a main-timeline card is answered, her next message without a mention goes on with that member", async (t) => {
  const h = harness({ [taylor.id]: [ASKING, ANSWER, "Next step."], [drew.id]: ["Hi."] });
  t.after(h.stopTimers);
  await h.send("@taylor which store?");
  await h.send("@drew hi");
  await h.answerChoice();
  const before = h.runs.length;
  await h.send("what next?");
  assert.deepEqual(h.runs.slice(before), [taylor.id], "the newest member on the main timeline is the one that answered the card");
});
