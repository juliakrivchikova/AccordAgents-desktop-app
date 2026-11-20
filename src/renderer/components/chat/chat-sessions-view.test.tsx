import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { activeRunSummaryForConversation } from "../../../shared/chatActiveRuns";
import type { ChatMessage, ChatViewMode, Conversation } from "../../../shared/types";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { ChatSessionsTimelineRow, ChatSessionsWaitingLine } from "./chat-sessions-timeline-row";
import { ChatSessionsLinksContext, type ChatSessionsLinks } from "./chat-sessions-links";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import {
  DREW,
  GERA,
  MAIN,
  PARTICIPANTS,
  TAYLOR,
  chatMessage,
  sessionsConversation,
  sessionsMessages,
  disclosure
} from "./chat-sessions-fixtures.test";

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);

const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);

function sessionsOf(conversation: Conversation, view: ChatViewMode = "sessions"): ChatSessionsView | undefined {
  let result: ChatSessionsView | undefined;
  function Harness(): null {
    result = useChatSessionsView({
      conversation,
      view,
      participants: conversation.metadata.participants as typeof PARTICIPANTS,
      participantStatusById: STATUSES,
      activeRunSummary: activeRunSummaryForConversation(conversation)
    });
    return null;
  }
  const renderer = create(<Harness />);
  renderer.unmount();
  return result;
}

function itemProps(message: ChatMessage, extra: Partial<Parameters<typeof ChatMessageItem>[0]> = {}): Parameters<typeof ChatMessageItem>[0] {
  return {
    activityDisclosure: disclosure(),
    message,
    conversationId: "chat-sessions",
    participants: PARTICIPANTS,
    participantStatusById: STATUSES,
    busy: false,
    onOpenThread: noop,
    onApproveMentions: noop,
    onRejectMentions: noop,
    onRespondToChoice: noop,
    onToggleReaction: noop,
    ...extra
  };
}

function renderRow(message: ChatMessage, sessions: ChatSessionsView, opened: string[] = []): ReactTestInstance {
  let renderer: ReturnType<typeof create> | undefined;
  const open = (id: string, focus?: string): void => { opened.push(focus ? `${id}@${focus}` : id); };
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsTimelineRow
          itemProps={itemProps(message)}
          context={{ sessions, onOpenMember: open, onOpenTask: (entry) => open(entry.item.targetParticipantId, entry.item.replyMessageId ?? entry.messageId) }}
        />
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

test("the main timeline holds the User and the main session and an open member card; tasks are inside their turn's reply; members' replies are in their sessions", () => {
  const sessions = sessionsOf(sessionsConversation());
  assert.ok(sessions);
  assert.deepEqual(sessions.mainMessages.map((message) => message.id), ["ask", "main-1", "taylor-choice"],
    "the intro system line stays hidden; the task message is not a card; drew's question, the main session's answer to it, gera's reply and the User's message to drew are not here");
  assert.deepEqual(sessions.workByReplyId.get("main-1")?.map((entry) => [entry.item.targetParticipantId, entry.status]), [[DREW.id, "running"], [GERA.id, "done"]]);
  assert.deepEqual(sessions.waitingOn.map((participant) => participant.handle), ["drew"]);
  assert.deepEqual(sessions.waitingRunIds, ["run-drew"]);
  assert.equal(sessions.runningMemberCount, 1);
  assert.deepEqual(sessions.memberRows.current.map((row) => row.participant.handle), ["drew", "taylor"]);
  assert.deepEqual(sessions.memberRows.previous.map((row) => row.participant.handle), ["gera"]);
});

test("rows of the main timeline: no avatar, author or thread controls; the User's message is a bubble; the turn's tasks are in its Worked fold", () => {
  const sessions = sessionsOf(sessionsConversation())!;
  const messages = sessionsMessages();
  const byId = new Map(messages.map((message) => [message.id, message]));

  const user = renderRow(byId.get("ask")!, sessions);
  const userArticle = user.find((node) => node.type === "article");
  assert.match(userArticle.props.className, /\bis-sessions\b/);
  assert.match(userArticle.props.className, /\buser\b/);
  assert.equal(userArticle.props["data-presentation"], "sessions");
  assert.equal(user.findAll(hasClass("message-avatar")).length, 0, "no avatar");

  const opened: string[] = [];
  const reply = renderRow(byId.get("main-1")!, sessions, opened);
  assert.equal(reply.findAll(hasClass("message-avatar")).length, 0);
  assert.equal(reply.findAll((node) => node.type === "strong").length, 0, "no author name");
  assert.equal(reply.findAll(hasClass("message-provider")).length, 0, "no provider label");
  assert.equal(reply.findAll((node) => node.props?.label === "Reply in thread").length, 0, "no thread controls");
  assert.match(textOf(reply), /On it, giving the parts to two members\./);
  const fold = reply.find((node) => node.props?.["data-testid"] === "chat-worked-fold");
  assert.equal(textOf(fold), "Worked for 54s", "folded: only how long it worked");
  act(() => fold.find((node) => node.type === "button").props.onClick());
  assert.match(textOf(reply.find(hasClass("chat-delegations-summary"))), /Delegated 2 tasks/);
  const rows = reply.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-delegation-row");
  assert.deepEqual(rows.map((row) => [row.props["data-participant-id"], row.props["data-task-status"]]), [[DREW.id, "running"], [GERA.id, "done"]]);
  assert.equal(textOf(rows[0]!.find(hasClass("chat-delegation-title"))), "Task for drew: fix the drew part", "the task is the member's title");
  assert.equal(textOf(rows[1]!.find(hasClass("chat-delegation-line"))), "Done: the token refresh is fixed");
  assert.equal(rows[0]!.findAll(hasClass("chat-delegation-elapsed")).length, 1, "a running task counts its time");
  assert.equal(rows[0]!.findAll((node) => node.props?.["data-provider-kind"] === DREW.kind).length, 1, "its provider's logo");
  assert.equal(rows[0]!.findAll(hasClass("chat-delegation-dot")).length, 1, "with a dot for its state");
  act(() => rows[1]!.props.onClick());
  act(() => rows[0]!.props.onClick());
  assert.deepEqual(opened, [`${GERA.id}@gera-reply`, `${DREW.id}@tasks`], "a row opens its member's session at its reply, else at the task");
  assert.equal(reply.findAll((node) => node.props?.["data-testid"] === "chat-task-card").length, 0, "no task card");

  const choice = renderRow(byId.get("taylor-choice")!, sessions, opened);
  assert.equal(choice.findAll((node) => node.props?.["data-testid"] === "chat-sessions-member-choice").length, 1);
  assert.match(textOf(choice), /taylor asks/);
  assert.doesNotMatch(textOf(choice), /@taylor/, "no handle in the sessions view");
  assert.match(textOf(choice), /Which database\?/);
});

test("while the main session's reply is being written, its turn's tasks show under it, open", () => {
  const messages = sessionsMessages().map((message) => message.id === "main-1" ? { ...message, status: "pending" as const, content: "" } : message);
  const sessions = sessionsOf(sessionsConversation({}, messages))!;
  const row = renderRow(messages.find((message) => message.id === "main-1")!, sessions);
  assert.equal(row.findAll((node) => node.props?.["data-testid"] === "chat-worked-fold").length, 0);
  assert.equal(row.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-delegation-row").length, 2);
});

test("a task whose reply is not loaded is one slim row of its own", () => {
  const messages = sessionsMessages().filter((message) => message.id !== "main-1");
  const sessions = sessionsOf(sessionsConversation({}, messages))!;
  assert.ok(sessions.mainMessages.some((message) => message.id === "tasks"));
  const row = renderRow(messages.find((message) => message.id === "tasks")!, sessions);
  assert.equal(row.findAll((node) => node.props?.["data-testid"] === "chat-sessions-task").length, 1);
  assert.equal(row.findAll(hasClass("chat-delegations-summary")).length, 0);
  assert.equal(row.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-delegation-row").length, 2);
});

test("a member's mention in a message is a chip with its logo and task that opens its session; other mentions are plain names; no @ anywhere", () => {
  const sessions = sessionsOf(sessionsConversation())!;
  const opened: string[] = [];
  const links: ChatSessionsLinks = {
    mainSessionId: MAIN.id,
    mainHandle: "main",
    byHandle: new Map([["gera", { id: GERA.id, title: "Fix the token refresh", kind: GERA.kind, focusMessageId: "gera-reply" }]]),
    openMember: (id, focus) => opened.push(`${id}@${focus}`)
  };
  const prose = chatMessage("main-2", "participant", 12, { participantId: MAIN.id, content: "Asked @gera (a copy) and @nobody; @main will report." });
  const bubble = chatMessage("ask-2", "user", 13, { content: "@main Reply to me", metadata: { askedParticipantIds: [MAIN.id] } });
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsLinksContext.Provider value={links}>
          <ChatSessionsTimelineRow itemProps={itemProps(prose)} context={{ sessions, onOpenMember: noop, onOpenTask: noop }} />
          <ChatSessionsTimelineRow itemProps={itemProps(bubble)} context={{ sessions, onOpenMember: noop, onOpenTask: noop }} />
        </ChatSessionsLinksContext.Provider>
      </TooltipProvider>
    );
  });
  const root = renderer!.root;
  const chip = root.find((node) => node.type === "button" && node.props["data-testid"] === "chat-member-chip");
  assert.equal(textOf(chip), "Fix the token refresh");
  assert.equal(chip.findAll((node) => node.props?.["data-provider-kind"] === GERA.kind).length, 1);
  act(() => chip.props.onClick({ preventDefault: noop }));
  assert.deepEqual(opened, [`${GERA.id}@gera-reply`]);
  const articles = root.findAll((node) => node.type === "article");
  assert.match(textOf(articles[0]!), /Asked Fix the token refresh \(a copy\) and nobody; main will report\./);
  assert.equal(textOf(articles[1]!.find(hasClass("message-content"))), "Reply to me", "the leading mention of the main session is left out");
  assert.doesNotMatch(textOf(root), /@/);
  assert.equal(root.findAll(hasClass("chat-mention")).length, 0, "no highlighted mention");
});

test("a member's open mention approval stays on the main timeline as its message, named, with the card", () => {
  const mention = chatMessage("gera-mention", "participant", 10, {
    participantId: GERA.id,
    participantLabel: "gera",
    content: "@taylor can you check the schema?",
    metadata: { pendingMentions: [{ targetParticipantId: TAYLOR.id, targetHandle: "taylor", status: "pending" }] }
  });
  const messages = [...sessionsMessages(), mention];
  const sessions = sessionsOf(sessionsConversation({}, messages))!;
  assert.deepEqual(sessions.mainMessages.map((message) => message.id), ["ask", "main-1", "taylor-choice", "gera-mention"]);
  const row = renderRow(mention, sessions);
  const article = row.find((node) => node.type === "article");
  assert.equal(article.props["data-presentation"], "sessions");
  assert.equal(textOf(row.findAll((node) => node.type === "strong")[0]!), "Task for gera: fix the gera part", "who asks is named by its task");
  assert.match(textOf(row), /Do you want to ask @taylor\?/);
});

test("the waiting line names the tasks the main session waits on, and Stop stops their runs", () => {
  const sessions = sessionsOf(sessionsConversation())!;
  assert.equal(sessions.waitingText, "Waiting on 1 member: Task for drew: fix the drew part");
  const stopped: Array<readonly string[]> = [];
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatSessionsWaitingLine members={[DREW, GERA]} text="Waiting on 2 members: Fix A, Fix B" runIds={["run-drew"]} onStop={(runIds) => stopped.push(runIds)} />);
  });
  assert.match(textOf(renderer!.root), /Waiting on 2 members: Fix A, Fix B/);
  act(() => renderer!.root.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-sessions-waiting-stop")[0]!.props.onClick());
  assert.deepEqual(stopped, [["run-drew"]]);
  act(() => renderer!.update(<ChatSessionsWaitingLine members={[DREW]} text="Waiting" runIds={[]} onStop={noop} />));
  assert.equal(renderer!.root.findAll((node) => node.props?.["data-testid"] === "chat-sessions-waiting-stop").length, 0, "nothing to stop without a run");
  act(() => renderer!.update(<ChatSessionsWaitingLine members={[]} text="" runIds={[]} onStop={noop} />));
  assert.equal(renderer!.toJSON(), null);
});

test("a task the main session titled is named by its short title in its row, the Waiting line and the member's title; an untitled one by its first sentence", () => {
  const messages = sessionsMessages().map((message) => {
    const batch = message.metadata?.participantRequest;
    if (message.id !== "tasks" || !batch) return message;
    const items = batch.items.map((item) => item.targetParticipantId === DREW.id
      ? { ...item, title: "Login button", prompt: "Restyle the login button with the new tokens. Keep the old colour." }
      : { ...item, prompt: "Назови столицу Италии. Ответь ровно одним словом, без пояснений и пунктуации." });
    return { ...message, metadata: { ...message.metadata, participantRequest: { ...batch, items } } };
  });
  const sessions = sessionsOf(sessionsConversation({}, messages))!;
  assert.equal(sessions.memberTitle(DREW.id), "Login button");
  assert.equal(sessions.memberTitle(GERA.id), "Назови столицу Италии", "not the whole task");
  assert.equal(sessions.waitingText, "Waiting on 1 member: Login button");
  assert.deepEqual(sessions.workByReplyId.get("main-1")?.map((entry) => entry.title), ["Login button", "Назови столицу Италии"]);
});

test("the classic view is untouched: an old chat and a chat shown classic get no sessions placement, and messages keep avatar, author and threads", () => {
  const old = sessionsConversation({ mainSessionParticipantId: undefined, chatView: "sessions" });
  assert.equal(sessionsOf(old), undefined, "a chat made before the main session is always classic");
  assert.equal(sessionsOf(sessionsConversation({ chatView: "classic" }), "classic"), undefined);

  const reply = chatMessage("main-1", "participant", 2, { participantId: MAIN.id, participantLabel: "main", content: "On it." });
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<TooltipProvider><ChatMessageItem {...itemProps(reply, { replyCount: 2, replyPreviewMessages: [] })} /></TooltipProvider>);
  });
  const root = renderer!.root;
  assert.equal(root.find((node) => node.type === "article").props["data-presentation"], undefined);
  assert.ok(root.findAll(hasClass("message-avatar")).length > 0, "the avatar is there");
  assert.equal(textOf(root.findAll((node) => node.type === "strong")[0]!), "main");
  assert.equal(root.findAll(hasClass("message-provider")).length, 1);
  assert.equal(root.findAll(hasClass("chat-rt-status")).length, 1, "the member's state, as before");
  assert.equal(root.findAll((node) => node.props?.["data-testid"] === "chat-message-hover-when").length, 0);
  assert.match(textOf(root.find(hasClass("chat-thread-pill"))), /2 replies/);
  assert.equal(root.findAll((node) => node.props?.label === "Reply in thread").length > 0, true);
  act(() => renderer!.unmount());
});

function renderSessionsRow(message: ChatMessage, sessions: ChatSessionsView, extra: Partial<Parameters<typeof ChatMessageItem>[0]> = {}): ReactTestInstance {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsPresentationContext.Provider value>
          <ChatSessionsTimelineRow itemProps={itemProps(message, extra)} context={{ sessions, onOpenMember: noop, onOpenTask: noop }} />
        </ChatSessionsPresentationContext.Provider>
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

const hoverWhen = (root: ReactTestInstance): ReactTestInstance[] =>
  root.findAll((node) => typeof node.type === "string" && node.props["data-testid"] === "chat-message-hover-when");

test("a finished message shows no member state, only its time among its hover controls; one still being written keeps its live line", () => {
  const sessions = sessionsOf(sessionsConversation())!;
  const reply = chatMessage("main-1", "participant", 2, { participantId: MAIN.id, participantLabel: "main", content: "On it." });
  // The main session works on a new turn now: its earlier reply must not say so.
  const busy = new Map<string, ChatParticipantRosterStatus>([...STATUSES, [MAIN.id, "running"]]);
  for (const statuses of [busy, STATUSES]) {
    const root = renderSessionsRow(reply, sessions, { participantStatusById: statuses });
    assert.equal(root.findAll(hasClass("chat-rt-status")).length, 0, "no Running or Idle above a finished reply");
    assert.equal(root.findAll(hasClass("message-meta")).length, 0, "no meta line at all");
    assert.equal(hoverWhen(root).length, 1, "its time is with the controls shown on hover");
    assert.ok(root.find(hasClass("message-actions")).findAll(hasClass("message-when")).length === 1);
  }

  const streaming = chatMessage("main-2", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-main" } });
  const live = renderSessionsRow(streaming, sessions);
  assert.equal(textOf(live.find(hasClass("chat-rt-status"))), "Running");
  assert.equal(live.findAll(hasClass("is-elapsed")).length, 1, "the time it has been running");
  assert.equal(hoverWhen(live).length, 0);

  const queued = chatMessage("main-3", "participant", 13, {
    participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-main-2", queuedBehind: { handle: "drew" } }
  } as Partial<ChatMessage>);
  assert.equal(textOf(renderSessionsRow(queued, sessions).find(hasClass("chat-rt-status"))), "Queued");

  // In a member's session the main session's answer keeps its name only.
  const named = renderSessionsRow(reply, sessions, { authorLabel: "Main session" } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  assert.equal(textOf(named.find(hasClass("message-meta"))), "Main session");
});

test("every finished reply of the sessions view says how long it worked the quiet way: muted text and a chevron, no pill; the classic view keeps its pill", () => {
  const sessions = sessionsOf(sessionsConversation())!;
  const plain = chatMessage("main-plain", "participant", 10, { participantId: MAIN.id, participantLabel: "main", content: "Rome.", metadata: { workedMs: 44_000 } });
  const quiet = renderSessionsRow(plain, sessions);
  assert.equal(quiet.findAll(hasClass("chat-worked")).length, 0, "no bordered pill");
  const fold = quiet.find((node) => node.props?.["data-testid"] === "chat-worked-fold");
  assert.equal(textOf(fold), "Worked for 44s");
  assert.equal(fold.findAll(hasClass("is-static")).length, 1, "nothing to unfold: the muted text alone");

  // A reply with a full stream unfolds it.
  const toggled: string[] = [];
  const streamed = { ...plain, id: "main-streamed", metadata: { workedMs: 44_000, processingTranscript: { content: "Let me check the atlas first.\n\nRome." } } } as ChatMessage;
  const withStream = renderSessionsRow(streamed, sessions, { activityDisclosure: { ...disclosure(), toggleProcessingTranscript: (id: string) => toggled.push(id) } });
  const button = withStream.find((node) => node.props?.["data-testid"] === "chat-worked-fold").find((node) => node.type === "button");
  assert.equal(button.props["aria-expanded"], false);
  act(() => button.props.onClick());
  assert.deepEqual(toggled, ["main-streamed"]);

  // A member's reply in its session reads the same.
  const memberReply = chatMessage("gera-done", "participant", 11, { participantId: GERA.id, participantLabel: "gera", content: "Fixed.", metadata: { workedMs: 3_000 } });
  const member = renderSessionsRow(memberReply, sessions);
  assert.equal(member.findAll(hasClass("chat-worked")).length, 0);
  assert.equal(textOf(member.find((node) => node.props?.["data-testid"] === "chat-worked-fold")), "Worked for 3s");

  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<TooltipProvider><ChatMessageItem {...itemProps(plain)} /></TooltipProvider>);
  });
  assert.equal(textOf(renderer!.root.find(hasClass("chat-worked"))), "Worked for 44s", "the classic view's pill");
  assert.equal(renderer!.root.findAll((node) => node.props?.["data-testid"] === "chat-worked-fold").length, 0);
  act(() => renderer!.unmount());
});

test("turn-finished notes: none on the main timeline of the sessions view, the main session's own included; the classic view keeps them", () => {
  const note = (id: string, participantId: string, handle: string, minute: number): ChatMessage => chatMessage(id, "system", minute, {
    content: "Done: the token refresh is fixed",
    metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "gera-reply", participantId, participantLabel: `@${handle}` } }
  } as Partial<ChatMessage>);
  const messages = [...sessionsMessages(), note("note-gera", GERA.id, "gera", 11), note("note-main", MAIN.id, "main", 12)];
  const sessions = sessionsOf(sessionsConversation({}, messages))!;
  assert.deepEqual(sessions.mainMessages.map((message) => message.id), ["ask", "main-1", "taylor-choice"],
    "a member's task row says it is done; the main session's reply is the newest thing there");
  assert.equal(sessionsOf(sessionsConversation({ chatView: "classic" }, messages), "classic"), undefined, "the classic view places nothing: its notes stay");
});
