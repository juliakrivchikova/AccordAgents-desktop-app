// Settings → General → Show members’ actions (the User, 2026-11-27): off, a
// reply is drawn without its actions (the classic view's commands line and
// full stream of steps, the line naming the step in progress, the sessions
// view's steps), and everything else stays: its words, its running state,
// its cards and its errors.
import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAgentActivityEvent, ChatMessage, Conversation } from "../../../shared/types";
import { ChatMemberActionsContext } from "./chat-member-actions";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { ChatSessionsTimelineRow } from "./chat-sessions-timeline-row";
import { ChatThinkingRowItem } from "./chat-streaming";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import { DREW, GERA, MAIN, PARTICIPANTS, TAYLOR, chatMessage, disclosure, sessionsConversation } from "./chat-sessions-fixtures.test";

type ItemProps = Parameters<typeof ChatMessageItem>[0];

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);
const byTestId = (id: string) => (node: ReactTestInstance): boolean => typeof node.type === "string" && node.props["data-testid"] === id;
const CODEX_MAIN = PARTICIPANTS.map((item) => item.id === MAIN.id ? { ...item, kind: "codex-cli" as const } : item);
const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);

const step = (id: string, kind: ChatAgentActivityEvent["kind"], label: string, afterContentLength: number, detail?: string): ChatAgentActivityEvent =>
  ({ id, sequence: Number(id.replace(/\D/g, "")) || 1, kind, label, createdAt: new Date().toISOString(), afterContentLength, ...(detail ? { detail } : {}) });
const STEPS = [step("a1", "command", "Running npm test", 0, "npm test"), step("a2", "file-edit", "Updating src/login.ts", 0), step("a3", "tool", "Reading src/a.ts", 0)];

function sessionsOf(conversation: Conversation): ChatSessionsView {
  let result: ChatSessionsView | undefined;
  function Harness(): null {
    result = useChatSessionsView({ conversation, view: "sessions", participants: conversation.metadata.participants as typeof PARTICIPANTS, participantStatusById: STATUSES });
    return null;
  }
  const renderer = create(<Harness />);
  renderer.unmount();
  return result!;
}

function itemProps(message: ChatMessage, extra: Partial<ItemProps> = {}): ItemProps {
  return {
    activityDisclosure: disclosure(),
    message,
    conversationId: "chat-actions",
    participants: CODEX_MAIN,
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

function draw(shown: boolean, element: ReactElement, sessions = false): ReactTestInstance {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMemberActionsContext.Provider value={shown}>
          <ChatSessionsPresentationContext.Provider value={sessions}>{element}</ChatSessionsPresentationContext.Provider>
        </ChatMemberActionsContext.Provider>
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

const classic = (shown: boolean, message: ChatMessage, extra: Partial<ItemProps> = {}): ReactTestInstance =>
  draw(shown, <ChatMessageItem {...itemProps(message, extra)} />);
const sessionsRow = (shown: boolean, message: ChatMessage, extra: Partial<ItemProps> = {}): ReactTestInstance =>
  draw(shown, <ChatSessionsTimelineRow itemProps={itemProps(message, extra)} context={{ sessions: sessionsOf(sessionsConversation()), onOpenMember: noop, onOpenTask: noop }} />, true);
const fullStreamButtons = (root: ReactTestInstance) => root.findAll((node) => node.props?.label === "Show full stream" || node.props?.label === "Hide full stream");
const sessionsRows = (root: ReactTestInstance) => root.findAll(byTestId("chat-sessions-activity-row"));

test("a finished classic reply: hidden actions take its full stream of steps away and leave its words", () => {
  const done = chatMessage("done", "participant", 10, {
    participantId: MAIN.id, content: "The login works now.",
    metadata: { workedMs: 4_000, activityEvents: STEPS, processingTranscript: { content: "The login works now.", capturedAt: new Date().toISOString(), originalLength: 20 } }
  } as Partial<ChatMessage>);
  const opened = new Set(["done"]);
  const open = { ...disclosure(), expandedProcessingTranscriptMessageIds: opened };
  const shown = classic(true, done, { activityDisclosure: open });
  assert.equal(fullStreamButtons(shown).length, 1, "shown: its steps are behind Show full stream");
  assert.ok(shown.findAll(hasClass("chat-inline-activity-group")).length > 0, "shown: the commands line");

  const hidden = classic(false, done, { activityDisclosure: open });
  assert.equal(fullStreamButtons(hidden).length, 0, "nothing left behind Show full stream");
  assert.equal(hidden.findAll(hasClass("chat-inline-activity-group")).length, 0);
  assert.equal(hidden.findAll(hasClass("chat-inline-activity-event")).length, 0);
  assert.match(textOf(hidden), /The login works now\./);
  assert.match(textOf(hidden), /Worked for 4s/, "how long it worked stays");
});

test("a finished classic reply with words between its steps still opens them, without the steps or the omitted-steps notice", () => {
  const done = chatMessage("done-words", "participant", 10, {
    participantId: MAIN.id, content: "Fixed.",
    metadata: { activityEvents: [step("a1", "command", "Running npm test", 22, "npm test")],
      processingTranscript: { content: "Let me run the tests.\n\nFixed.", capturedAt: new Date().toISOString(), originalLength: 29, omittedActivityEventCount: 3 } }
  } as Partial<ChatMessage>);
  const open = { ...disclosure(), expandedProcessingTranscriptMessageIds: new Set(["done-words"]) };
  const hidden = classic(false, done, { activityDisclosure: open });
  assert.equal(fullStreamButtons(hidden).length, 1, "its earlier words are still behind Show full stream");
  assert.match(textOf(hidden), /Let me run the tests\./);
  assert.doesNotMatch(textOf(hidden), /npm test|activities omitted|commands?\b/);
});

test("a running classic reply says Thinking, then its words, without the step in progress or its commands line", () => {
  const running = chatMessage("run", "participant", 11, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-1" } });
  const progress = { participantLabel: "main", state: "running" as const, partialContent: "", activity: "Running npm test", activityEvents: STEPS };
  const shown = classic(true, running, { liveProgress: progress, onStopRun: noop });
  assert.match(textOf(shown), /Reading src\/a\.ts/, "shown: the step in progress");

  const hidden = classic(false, running, { liveProgress: progress, onStopRun: noop });
  assert.doesNotMatch(textOf(hidden), /npm test|Updating|Reading|commands?\b/);
  assert.equal(hidden.findAll(hasClass("streaming-message-activity")).length, 0);
  assert.match(textOf(hidden.find(hasClass("streaming-status-label"))), /Thinking/, "it still visibly works");
  assert.ok(hidden.findAll((node) => node.props?.label === "Stop response").length > 0, "and can be stopped");

  const writing = classic(false, running, { liveProgress: { ...progress, partialContent: "Checking the form.", activityEvents: [...STEPS, step("a4", "command", "Running lint", 18)] } });
  assert.match(textOf(writing), /Checking the form\./);
  assert.equal(writing.findAll(hasClass("chat-inline-activity-group")).length + writing.findAll(hasClass("chat-inline-activity-event")).length, 0);
});

test("a running reply of the sessions view keeps Working for and its words, without its steps", () => {
  const running = chatMessage("main-run", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-main" } });
  const progress = { participantLabel: "main", state: "running" as const, partialContent: "Looking at the form.", activityEvents: STEPS };
  assert.equal(sessionsRows(sessionsRow(true, running, { liveProgress: progress })).length, STEPS.length, "shown: a row per step");
  const hidden = sessionsRow(false, running, { liveProgress: progress });
  assert.equal(sessionsRows(hidden).length, 0);
  assert.match(textOf(hidden.find(byTestId("chat-sessions-working"))), /^Working for /);
  assert.match(textOf(hidden), /Looking at the form\./);
});

test("a finished reply of the sessions view says how long it worked, with no steps to open", () => {
  const done = chatMessage("main-done", "participant", 14, { participantId: MAIN.id, content: "Done.", metadata: { workedMs: 4_000, activityEvents: STEPS } } as Partial<ChatMessage>);
  const open = { ...disclosure(), expandedProcessingTranscriptMessageIds: new Set(["main-done"]) };
  assert.equal(sessionsRows(sessionsRow(true, done, { activityDisclosure: open })).length, STEPS.length, "shown: its fold opens to its steps");
  const hidden = sessionsRow(false, done, { activityDisclosure: open });
  assert.equal(sessionsRows(hidden).length, 0);
  assert.equal(hidden.findAll(byTestId("chat-sessions-finished-activity")).length, 0);
  assert.match(textOf(hidden), /Worked for 4s/);
  assert.match(textOf(hidden), /Done\./);
});

test("a part of a turn her next message joined shows its words only", () => {
  const part = chatMessage("part", "participant", 14, { participantId: MAIN.id, content: "Checking first.", metadata: { turnContinues: true, activityEvents: STEPS } } as Partial<ChatMessage>);
  const classicPart = classic(false, part);
  assert.equal(classicPart.findAll(hasClass("chat-inline-activity-group")).length + classicPart.findAll(hasClass("chat-inline-activity-event")).length, 0);
  assert.match(textOf(classicPart), /Checking first\./);
  const sessionsPart = sessionsRow(false, part);
  assert.equal(sessionsRows(sessionsPart).length, 0);
  assert.match(textOf(sessionsPart), /Checking first\./);
});

test("cards and errors stay with actions hidden", () => {
  const asking = chatMessage("ask", "participant", 15, {
    participantId: MAIN.id, content: "I need @drew.",
    metadata: { activityEvents: STEPS, pendingMentions: [{ targetParticipantId: DREW.id, targetHandle: "drew", status: "pending" }] }
  } as Partial<ChatMessage>);
  const card = classic(false, asking);
  assert.equal(card.findAll(hasClass("chat-approval-box")).length, 1, "the approval card");
  const failed = chatMessage("fail", "participant", 16, { participantId: MAIN.id, status: "error", content: "The run failed: the CLI exited.", metadata: { activityEvents: STEPS } } as Partial<ChatMessage>);
  assert.match(textOf(classic(false, failed)), /The run failed: the CLI exited\./);
});

test("the timeline's thinking row keeps who is thinking and drops the step in progress", () => {
  const row = { key: "k", runId: "r", participantLabel: "@drew", activity: "Running npm test", startedAt: "", updatedAt: "" };
  assert.match(textOf(draw(true, <ChatThinkingRowItem row={row} />)), /Running npm test/);
  const hidden = draw(false, <ChatThinkingRowItem row={row} />);
  assert.doesNotMatch(textOf(hidden), /npm test/);
  assert.match(textOf(hidden), /@drewThinking/);
});
