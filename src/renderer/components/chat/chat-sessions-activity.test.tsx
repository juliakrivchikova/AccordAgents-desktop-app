// A running reply of the sessions view (the User, 2026-11-21), T3 Code's turn
// in progress: "Working for 4s" over a hairline, one quiet row per step by
// kind, the newest shimmering; its words and posts in order between the rows;
// once done, its Worked for opens to the same rows. The classic view keeps
// its own running reply.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { activeRunSummaryForConversation } from "../../../shared/chatActiveRuns";
import type { ChatAgentActivityEvent, ChatMessage, Conversation } from "../../../shared/types";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { ChatSessionsTimelineRow } from "./chat-sessions-timeline-row";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import { DREW, GERA, MAIN, PARTICIPANTS, TAYLOR, chatMessage, disclosure, sessionsConversation, sessionsMessages } from "./chat-sessions-fixtures.test";

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);

const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);

function sessionsOf(conversation: Conversation): ChatSessionsView {
  let result: ChatSessionsView | undefined;
  function Harness(): null {
    result = useChatSessionsView({
      conversation,
      view: "sessions",
      participants: conversation.metadata.participants as typeof PARTICIPANTS,
      participantStatusById: STATUSES,
      activeRunSummary: activeRunSummaryForConversation(conversation)
    });
    return null;
  }
  const renderer = create(<Harness />);
  renderer.unmount();
  return result!;
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

const activity = (id: string, kind: ChatAgentActivityEvent["kind"], label: string, afterContentLength: number, detail?: string): ChatAgentActivityEvent =>
  ({ id, sequence: Number(id.replace(/\D/g, "")) || 1, kind, label, createdAt: new Date().toISOString(), afterContentLength, ...(detail ? { detail } : {}) });

/** A turn as T3 Code's work log shows it: thinking, a search, a command, a read, an edit, another tool. */
function workEvents(): ChatAgentActivityEvent[] {
  return [
    activity("a1", "status", "Thinking", 0, "I need the current exchange rate, so I'll run a standard web search."),
    activity("a2", "web", "Using web search", 0, "EUR to USD exchange rate today"),
    activity("a3", "command", "Running command", 0, "npm test -- --grep login\nsecond line"),
    activity("a4", "tool", "Reading file", 0, "src/login.ts"),
    activity("a5", "file-edit", "Updating files", 0, "src/login.css"),
    activity("a6", "tool", "Using mcp__accord_agents__app_chat_get_context", 0)
  ];
}

const rowsOf = (root: ReactTestInstance): string[][] => root.findAll((node) => typeof node.type === "string" && node.props["data-testid"] === "chat-sessions-activity-row")
  .map((node) => [node.props["data-activity-kind"], textOf(node), node.props.className.includes("is-current") ? "current" : ""]);

const WORK_ROWS = [
  ["thinking", "I need the current exchange rate, so I'll run a standard web search."],
  ["web", "EUR to USD exchange rate today"],
  ["shell", "npm test -- --grep login"],
  ["read", "src/login.ts"],
  ["edit", "src/login.css"],
  ["tool", "Using mcp__accord_agents__app_chat_get_context"]
];

test("a running reply of the sessions view: Working for over a hairline, one quiet row per step by kind, the newest shimmering; no Running label, no Thinking word, no boxed groups, no controls of its own", () => {
  const sessions = sessionsOf(sessionsConversation());
  const running = chatMessage("main-run", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-main" } });
  const root = renderSessionsRow(running, sessions, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: workEvents() }, onStopRun: noop } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  assert.match(textOf(root.find((node) => node.props?.["data-testid"] === "chat-sessions-working")), /^Working for \d+(s|m \d+s|h \d+m)$/);
  assert.deepEqual(rowsOf(root), WORK_ROWS.map((row, index) => [...row, index === WORK_ROWS.length - 1 ? "current" : ""]));
  const text = textOf(root);
  assert.doesNotMatch(text, /Running|Thinking\b|commands?\b/, "no status label, no placeholder word, no group summary");
  assert.equal(root.findAll(hasClass("chat-inline-activity-group")).length, 0, "no boxed groups");
  assert.equal(root.findAll(hasClass("message-actions")).length, 0, "no stop or copy on the message: the composer's button is Stop");
  assert.equal(root.findAll((node) => node.props?.label === "Stop response" || node.props?.label === "Copy message").length, 0);

  // Before its first step it is the header alone: no "Thinking".
  const fresh = renderSessionsRow({ ...running, id: "main-fresh" }, sessions);
  assert.equal(rowsOf(fresh).length, 0);
  assert.doesNotMatch(textOf(fresh), /Thinking/);
});

test("a running reply keeps its words and its posts in order between the rows, and its turn's tasks after them", () => {
  const messages = sessionsMessages().map((message) => message.id === "main-1" ? { ...message, status: "pending" as const, content: "" } : message);
  const sessions = sessionsOf(sessionsConversation({}, messages));
  const reply = messages.find((message) => message.id === "main-1")!;
  const content = "Checking the login form.\n\nThe form is fine.";
  const events = [activity("a1", "tool", "Reading file", 0, "src/login.ts"), activity("a2", "command", "Running command", 26, "npm test")];
  const posted = { ...reply, metadata: { ...reply.metadata, interimPosts: [{ id: "post-1", content: "Tests started.", createdAt: new Date().toISOString(), afterContentLength: 24 }] } } as ChatMessage;
  const root = renderSessionsRow(posted, sessions, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: content, activityEvents: events } } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  const running = root.find((node) => node.props?.["data-testid"] === "chat-sessions-running");
  const order = running.findAll((node) => typeof node.type === "string" && (
    node.props["data-testid"] === "chat-sessions-activity-row" || hasClass("chat-sessions-activity-words")(node) || hasClass("chat-interim-post")(node) ||
    node.props["data-testid"] === "chat-delegation-row"))
    .map((node) => node.props["data-testid"] === "chat-sessions-activity-row" ? `row:${textOf(node)}`
      : node.props["data-testid"] === "chat-delegation-row" ? "task" : hasClass("chat-interim-post")(node) ? `post:${textOf(node)}` : `words:${textOf(node)}`);
  assert.deepEqual(order, ["row:src/login.ts", "words:Checking the login form.", "post:Tests started.", "row:npm test", "words:The form is fine.", "task", "task"]);
});

test("a finished reply of the sessions view folds the same rows into its Worked for; the classic view keeps its pill and its stream", () => {
  const sessions = sessionsOf(sessionsConversation());
  const done = chatMessage("main-done", "participant", 14, {
    participantId: MAIN.id, content: "The rate is 1.08.", metadata: { workedMs: 4_000, activityEvents: workEvents() }
  } as Partial<ChatMessage>);
  const opened = new Set<string>();
  const toggles = { ...disclosure(), expandedProcessingTranscriptMessageIds: opened, toggleProcessingTranscript: (id: string) => { opened.add(id); } };
  const closed = renderSessionsRow(done, sessions, { activityDisclosure: toggles });
  const fold = closed.find((node) => node.props?.["data-testid"] === "chat-worked-fold");
  const toggle = fold.find((node) => node.type === "button");
  assert.equal(textOf(toggle), "Worked for 4s");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(rowsOf(closed).length, 0, "folded once it is done");
  act(() => toggle.props.onClick());
  assert.deepEqual([...opened], ["main-done"]);
  const open = renderSessionsRow(done, sessions, { activityDisclosure: toggles });
  assert.deepEqual(rowsOf(open), WORK_ROWS.map((row) => [...row, ""]), "the same rows, none shimmering");
  assert.ok(open.find((node) => node.props?.["data-testid"] === "chat-worked-fold").findAll((node) => node.props?.["data-testid"] === "chat-sessions-finished-activity").length === 1);
  assert.match(textOf(open), /The rate is 1\.08\./, "its text stays under the fold");
  assert.equal(open.findAll((node) => node.props?.label === "Show full stream" || node.props?.label === "Hide full stream").length, 0, "the fold is the one control");

  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<TooltipProvider><ChatMessageItem {...itemProps(done)} /></TooltipProvider>);
  });
  assert.equal(textOf(renderer!.root.find(hasClass("chat-worked"))), "Worked for 4s", "the classic view's pill");
  assert.equal(rowsOf(renderer!.root).length, 0, "no sessions rows in the classic view");
  act(() => renderer!.unmount());
});

test("the classic view's running reply is as it was: its status line and its stop control", () => {
  const running = chatMessage("main-run", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-main" } });
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<TooltipProvider><ChatMessageItem {...itemProps(running, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: workEvents() }, onStopRun: noop } as Partial<Parameters<typeof ChatMessageItem>[0]>)} /></TooltipProvider>);
  });
  const root = renderer!.root;
  assert.equal(textOf(root.find(hasClass("chat-rt-status"))), "Running");
  assert.equal(root.findAll((node) => node.props?.label === "Stop response").length > 0, true);
  assert.equal(rowsOf(root).length, 0);
  assert.equal(root.findAll((node) => node.props?.["data-testid"] === "chat-sessions-working").length, 0);
  act(() => renderer!.unmount());
});
