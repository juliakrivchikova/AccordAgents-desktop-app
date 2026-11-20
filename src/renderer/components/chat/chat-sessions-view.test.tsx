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
import { ChatTaskCard } from "./chat-task-card";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import {
  DREW,
  GERA,
  MAIN,
  PARTICIPANTS,
  TAYLOR,
  chatMessage,
  requestBatch,
  requestItem,
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

function renderRow(message: ChatMessage, sessions: ChatSessionsView, opened: string[] = [], messages = sessionsMessages()): ReactTestInstance {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsTimelineRow itemProps={itemProps(message)} context={{ sessions, messages, onOpenMember: (id) => opened.push(id) }} />
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

test("the main timeline holds the User and the main session, the task card and an open member card; members' replies are in their sessions", () => {
  const sessions = sessionsOf(sessionsConversation());
  assert.ok(sessions);
  assert.deepEqual(sessions.mainMessages.map((message) => message.id), ["ask", "main-1", "tasks", "taylor-choice"],
    "the intro system line stays hidden; drew's question, the main session's answer to it, gera's reply and the User's message to drew are not here");
  assert.deepEqual(sessions.waitingOn.map((participant) => participant.handle), ["drew"]);
  assert.deepEqual(sessions.waitingRunIds, ["run-drew"]);
  assert.equal(sessions.runningMemberCount, 1);
  assert.deepEqual(sessions.memberRows.current.map((row) => row.participant.handle), ["drew", "taylor"]);
  assert.deepEqual(sessions.memberRows.previous.map((row) => row.participant.handle), ["gera"]);
});

test("rows of the main timeline: no avatar, author or thread controls; the User's message is a bubble; the request is a task card", () => {
  const sessions = sessionsOf(sessionsConversation())!;
  const messages = sessionsMessages();
  const byId = new Map(messages.map((message) => [message.id, message]));

  const user = renderRow(byId.get("ask")!, sessions);
  const userArticle = user.find((node) => node.type === "article");
  assert.match(userArticle.props.className, /\bis-sessions\b/);
  assert.match(userArticle.props.className, /\buser\b/);
  assert.equal(userArticle.props["data-presentation"], "sessions");
  assert.equal(user.findAll(hasClass("message-avatar")).length, 0, "no avatar");

  const reply = renderRow(byId.get("main-1")!, sessions);
  assert.equal(reply.findAll(hasClass("message-avatar")).length, 0);
  assert.equal(reply.findAll((node) => node.type === "strong").length, 0, "no author name");
  assert.equal(reply.findAll(hasClass("message-provider")).length, 0, "no provider label");
  assert.equal(reply.findAll((node) => node.props?.label === "Reply in thread").length, 0, "no thread controls");
  assert.match(textOf(reply), /On it, giving the parts to two members\./);

  const opened: string[] = [];
  const card = renderRow(byId.get("tasks")!, sessions, opened);
  assert.equal(card.findAll((node) => node.props?.["data-testid"] === "chat-task-card").length, 1);
  assert.equal(card.findAll((node) => node.type === "article").length, 0, "the request is not drawn as a message");
  const rows = card.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-task-card-row");
  assert.deepEqual(rows.map((row) => [row.props["data-participant-id"], row.props["data-task-status"]]), [[DREW.id, "running"], [GERA.id, "done"]]);
  act(() => rows[1]!.props.onClick());
  assert.deepEqual(opened, [GERA.id], "a row opens its member's session");

  const choice = renderRow(byId.get("taylor-choice")!, sessions, opened);
  assert.equal(choice.findAll((node) => node.props?.["data-testid"] === "chat-sessions-member-choice").length, 1);
  assert.match(textOf(choice), /@taylor asks/);
  assert.match(textOf(choice), /Which database\?/);
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
  assert.deepEqual(sessions.mainMessages.map((message) => message.id), ["ask", "main-1", "tasks", "taylor-choice", "gera-mention"]);
  const row = renderRow(mention, sessions, [], messages);
  const article = row.find((node) => node.type === "article");
  assert.equal(article.props["data-presentation"], "sessions");
  assert.equal(textOf(row.findAll((node) => node.type === "strong")[0]!), "@gera", "who asks is named");
  assert.match(textOf(row), /Do you want to ask @taylor\?/);
});

test("a task card shows each task's state, the time while it runs and one line of the result", () => {
  const items = [
    requestItem(DREW, "running", 3),
    requestItem(GERA, "answered", 3, { replyMessageId: "gera-reply" }),
    requestItem(TAYLOR, "running", 3),
    requestItem({ ...GERA, id: "p-fail", handle: "fail" }, "failed", 3, { error: "The CLI exited with code 1." }),
    requestItem({ ...GERA, id: "p-stop", handle: "stop" }, "interrupted", 3)
  ];
  const message = chatMessage("tasks", "participant", 3, { participantId: MAIN.id, metadata: { participantRequest: requestBatch("b1", MAIN, items) } });
  const messages = sessionsMessages();
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <ChatTaskCard
        message={message}
        batch={message.metadata!.participantRequest!}
        participants={PARTICIPANTS}
        participantStatusById={STATUSES}
        messages={messages}
        messagesById={new Map(messages.map((entry) => [entry.id, entry]))}
        onOpenMember={noop}
      />
    );
  });
  const root = renderer!.root;
  assert.equal(textOf(root.find(hasClass("chat-task-card-head"))), "5 members · 1 running");
  const rows = root.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-task-card-row");
  const state = rows.map((row) => [textOf(row.find(hasClass("chat-task-card-handle"))), textOf(row.find(hasClass("chat-work-status")))]);
  assert.deepEqual(state, [["@drew", "Running"], ["@gera", "Done"], ["@taylor", "Waiting for you"], ["@fail", "Failed"], ["@stop", "Stopped"]]);
  assert.equal(rows[0]!.findAll(hasClass("chat-task-card-elapsed")).length, 1, "a running task counts its time");
  assert.equal(rows[1]!.findAll(hasClass("chat-task-card-elapsed")).length, 0);
  assert.equal(textOf(rows[0]!.find(hasClass("chat-task-card-title"))), "Task for drew: fix the drew part");
  assert.equal(textOf(rows[1]!.find(hasClass("chat-task-card-result"))), "Done: the token refresh is fixed");
  assert.equal(textOf(rows[3]!.find(hasClass("chat-task-card-result"))), "The CLI exited with code 1.");
  act(() => renderer!.unmount());
});

test("the waiting line names the members the main session waits on, and Stop stops their runs", () => {
  const stopped: Array<readonly string[]> = [];
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatSessionsWaitingLine members={[DREW, GERA]} runIds={["run-drew"]} onStop={(runIds) => stopped.push(runIds)} />);
  });
  assert.match(textOf(renderer!.root), /Waiting on 2 members: @drew, @gera/);
  act(() => renderer!.root.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-sessions-waiting-stop")[0]!.props.onClick());
  assert.deepEqual(stopped, [["run-drew"]]);
  act(() => renderer!.update(<ChatSessionsWaitingLine members={[DREW]} runIds={[]} onStop={noop} />));
  assert.equal(renderer!.root.findAll((node) => node.props?.["data-testid"] === "chat-sessions-waiting-stop").length, 0, "nothing to stop without a run");
  act(() => renderer!.update(<ChatSessionsWaitingLine members={[]} runIds={[]} onStop={noop} />));
  assert.equal(renderer!.toJSON(), null);
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
          <ChatSessionsTimelineRow itemProps={itemProps(message, extra)} context={{ sessions, messages: sessionsMessages(), onOpenMember: noop }} />
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

test("turn-finished notes: another member's is not on the main timeline; the main session's is, with its provider logo, no avatar", () => {
  const note = (id: string, participantId: string, handle: string, minute: number): ChatMessage => chatMessage(id, "system", minute, {
    content: "Done: the token refresh is fixed",
    metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "gera-reply", participantId, participantLabel: `@${handle}` } }
  } as Partial<ChatMessage>);
  const messages = [...sessionsMessages(), note("note-gera", GERA.id, "gera", 11), note("note-main", MAIN.id, "main", 12)];
  const sessions = sessionsOf(sessionsConversation({}, messages))!;
  assert.deepEqual(sessions.mainMessages.map((message) => message.id), ["ask", "main-1", "tasks", "taylor-choice", "note-main"],
    "gera's note belongs to gera's session, whose task card already says it is done");
  const row = renderSessionsRow(messages.at(-1)!, sessions);
  assert.equal(row.findAll(hasClass("chat-turn-finished-note")).length, 1);
  assert.equal(row.findAll(hasClass("chat-turn-finished-note-avatar")).length, 0, "no avatar picture");
  assert.deepEqual(row.findAll((node) => typeof node.type === "string" && node.props["data-provider-kind"] !== undefined)
    .map((node) => node.props["data-provider-kind"]), ["claude-code"], "the main session's provider logo instead");
});
