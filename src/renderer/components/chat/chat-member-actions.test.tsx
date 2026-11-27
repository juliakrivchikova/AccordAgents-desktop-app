// Settings → General → Show members’ actions (the User, 2026-11-27): off, a
// reply is drawn without its actions (the classic view's commands and full
// stream of steps, the line naming the step in progress, the sessions view's
// steps), and everything else stays: its words, its notices about the run,
// its running state, its cards and its errors. Checked by what the User reads
// (the steps' own labels), not by how it is styled.
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
import { chatTopLevelMessages } from "./chat-thread-data";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import { DREW, GERA, MAIN, PARTICIPANTS, TAYLOR, chatMessage, disclosure, sessionsConversation, sessionsMessages } from "./chat-sessions-fixtures.test";

type ItemProps = Parameters<typeof ChatMessageItem>[0];

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byTestId = (id: string) => (node: ReactTestInstance): boolean => typeof node.type === "string" && node.props["data-testid"] === id;
const CODEX_MAIN = PARTICIPANTS.map((item) => item.id === MAIN.id ? { ...item, kind: "codex-cli" as const } : item);
const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);

const step = (id: string, kind: ChatAgentActivityEvent["kind"], label: string, afterContentLength: number, extra: Partial<ChatAgentActivityEvent> = {}): ChatAgentActivityEvent =>
  ({ id, sequence: Number(id.replace(/\D/g, "")) || 1, kind, label, createdAt: new Date().toISOString(), afterContentLength, ...extra });
const STEPS = [step("a1", "command", "Running npm test", 0, { detail: "npm test" }), step("a2", "file-edit", "Updating src/login.ts", 0), step("a3", "tool", "Reading src/a.ts", 0)];
/** What the User must never lose: notices about the run itself. */
const STALLED = step("n1", "status", "@main has produced no provider output for 5 minutes.", 0);
const AUTH_FAILED = step("n2", "approval", "Codex needs you to sign in again", 0, { status: "failed" });
const STEP_LABELS = /npm test|Updating src\/login\.ts|Reading src\/a\.ts|Running lint|\d+ commands?/;

function sessionsOf(conversation: Conversation, actionsShown = true): ChatSessionsView {
  let result: ChatSessionsView | undefined;
  function Harness(): null {
    result = useChatSessionsView({ conversation, view: "sessions", participants: conversation.metadata.participants as typeof PARTICIPANTS, participantStatusById: STATUSES, actionsShown });
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

function draw(shown: boolean, element: ReactElement, sessions = false): { root: ReactTestInstance; empty: boolean } {
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
  return { root: renderer!.root, empty: renderer!.toJSON() === null };
}

const classic = (shown: boolean, message: ChatMessage, extra: Partial<ItemProps> = {}): ReactTestInstance =>
  draw(shown, <ChatMessageItem {...itemProps(message, extra)} />).root;
const sessionsRow = (shown: boolean, message: ChatMessage, extra: Partial<ItemProps> = {}): ReactTestInstance =>
  draw(shown, <ChatSessionsTimelineRow itemProps={itemProps(message, extra)} context={{ sessions: sessionsOf(sessionsConversation()), onOpenMember: noop, onOpenTask: noop }} />, true).root;
const fullStreamButtons = (root: ReactTestInstance) => root.findAll((node) => node.props?.label === "Show full stream" || node.props?.label === "Hide full stream");
const sessionsRows = (root: ReactTestInstance) => root.findAll(byTestId("chat-sessions-activity-row"));
const opened = (id: string) => ({ ...disclosure(), expandedProcessingTranscriptMessageIds: new Set([id]) });

test("a finished classic reply: hidden actions take its full stream of steps away and leave its words", () => {
  const done = chatMessage("done", "participant", 10, {
    participantId: MAIN.id, content: "The login works now.",
    metadata: { workedMs: 4_000, activityEvents: STEPS, processingTranscript: { content: "The login works now.", capturedAt: new Date().toISOString(), originalLength: 20 } }
  } as Partial<ChatMessage>);
  const shown = classic(true, done, { activityDisclosure: opened("done") });
  assert.equal(fullStreamButtons(shown).length, 1, "shown: its steps are behind its full stream");
  assert.match(textOf(shown), STEP_LABELS, "shown: its commands");

  const hidden = classic(false, done, { activityDisclosure: opened("done") });
  assert.equal(fullStreamButtons(hidden).length, 0, "nothing left behind its full stream");
  assert.doesNotMatch(textOf(hidden), STEP_LABELS);
  assert.match(textOf(hidden), /The login works now\./);
  assert.match(textOf(hidden), /Worked for 4s/, "how long it worked stays");
});

test("a finished classic reply with words between its steps still opens them, without the steps or the omitted-steps notice", () => {
  const done = chatMessage("done-words", "participant", 10, {
    participantId: MAIN.id, content: "Fixed.",
    metadata: { activityEvents: [step("a1", "command", "Running npm test", 22, { detail: "npm test" })],
      processingTranscript: { content: "Let me run the tests.\n\nFixed.", capturedAt: new Date().toISOString(), originalLength: 29, omittedActivityEventCount: 3 } }
  } as Partial<ChatMessage>);
  const hidden = classic(false, done, { activityDisclosure: opened("done-words") });
  assert.equal(fullStreamButtons(hidden).length, 1, "its earlier words are still behind its full stream");
  assert.match(textOf(hidden), /Let me run the tests\./);
  assert.doesNotMatch(textOf(hidden), /npm test|activities omitted/);
});

test("a running classic reply says Thinking, then its words, without the step in progress or its commands", () => {
  const running = chatMessage("run", "participant", 11, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-1" } });
  const progress = { participantLabel: "main", state: "running" as const, partialContent: "", activity: "Reading src/a.ts", activityEvents: STEPS };
  assert.match(textOf(classic(true, running, { liveProgress: progress, onStopRun: noop })), /Reading src\/a\.ts/, "shown: the step in progress");

  const hidden = classic(false, running, { liveProgress: progress, onStopRun: noop });
  assert.doesNotMatch(textOf(hidden), STEP_LABELS);
  assert.match(textOf(hidden), /Thinking/, "it still visibly works");
  assert.ok(hidden.findAll((node) => node.props?.label === "Stop response").length > 0, "and can be stopped");

  const writing = classic(false, running, { liveProgress: { ...progress, partialContent: "Checking the form.", activityEvents: [...STEPS, step("a4", "command", "Running lint", 18)] } });
  assert.match(textOf(writing), /Checking the form\./);
  assert.doesNotMatch(textOf(writing), STEP_LABELS);
});

test("notices about the run stay with actions hidden: finished, running, and in the sessions view", () => {
  const done = chatMessage("noticed", "participant", 12, {
    participantId: MAIN.id, content: "Stopped early.",
    metadata: { activityEvents: [...STEPS, STALLED, AUTH_FAILED], processingTranscript: { content: "Stopped early.", capturedAt: new Date().toISOString(), originalLength: 14 } }
  } as Partial<ChatMessage>);
  const hidden = classic(false, done, { activityDisclosure: opened("noticed") });
  assert.match(textOf(hidden), /no provider output for 5 minutes/);
  assert.match(textOf(hidden), /sign in again/);
  assert.doesNotMatch(textOf(hidden), STEP_LABELS);

  const running = chatMessage("run-noticed", "participant", 13, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-2" } });
  const stalled = classic(false, running, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activity: STALLED.label, activityEvents: [...STEPS, STALLED] } });
  assert.match(textOf(stalled), /no provider output for 5 minutes/, "a running reply's notice in progress");
  assert.doesNotMatch(textOf(stalled), STEP_LABELS);

  const sessionsRunning = { ...running, id: "main-run-noticed" };
  const rows = sessionsRows(sessionsRow(false, sessionsRunning, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: [...STEPS, STALLED] } }));
  assert.deepEqual(rows.map((row) => textOf(row)), [STALLED.label], "the sessions view keeps the notice as its one row");
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
  assert.equal(sessionsRows(sessionsRow(true, done, { activityDisclosure: opened("main-done") })).length, STEPS.length, "shown: its fold opens to its steps");
  const hidden = sessionsRow(false, done, { activityDisclosure: opened("main-done") });
  assert.equal(sessionsRows(hidden).length, 0);
  assert.equal(hidden.findAll(byTestId("chat-sessions-finished-activity")).length, 0);
  assert.match(textOf(hidden), /Worked for 4s/);
  assert.match(textOf(hidden), /Done\./);
});

test("a part of a turn her next message joined shows its words only, and one of steps alone has no row", () => {
  const part = chatMessage("part", "participant", 14, { participantId: MAIN.id, content: "Checking first.", metadata: { turnContinues: true, activityEvents: STEPS } } as Partial<ChatMessage>);
  for (const root of [classic(false, part), sessionsRow(false, part)]) {
    assert.doesNotMatch(textOf(root), STEP_LABELS);
    assert.match(textOf(root), /Checking first\./);
  }
  // Steps alone: drawn while shown, nothing at all while hidden, in the
  // timeline's rows as in the row itself.
  const stepsOnly = chatMessage("steps-only", "participant", 15, { participantId: MAIN.id, content: "", metadata: { turnContinues: true, activityEvents: STEPS } } as Partial<ChatMessage>);
  assert.equal(draw(true, <ChatMessageItem {...itemProps(stepsOnly)} />).empty, false);
  assert.equal(draw(false, <ChatMessageItem {...itemProps(stepsOnly)} />).empty, true);
  const conversation = sessionsConversation({}, [...sessionsMessages(), stepsOnly]);
  assert.equal(chatTopLevelMessages(conversation, true).some((message) => message.id === "steps-only"), true);
  assert.equal(chatTopLevelMessages(conversation, false).some((message) => message.id === "steps-only"), false, "no classic row");
  assert.equal(sessionsOf(conversation, false).mainMessages.some((message) => message.id === "steps-only"), false, "no sessions row");
  // One with a notice keeps its row.
  const noticeOnly = { ...stepsOnly, id: "notice-only", metadata: { ...stepsOnly.metadata, activityEvents: [...STEPS, STALLED] } } as ChatMessage;
  assert.equal(draw(false, <ChatMessageItem {...itemProps(noticeOnly)} />).empty, false);
});

test("cards and errors stay with actions hidden", () => {
  const asking = chatMessage("ask", "participant", 15, {
    participantId: MAIN.id, content: "I need @drew.",
    metadata: { activityEvents: STEPS, pendingMentions: [{ targetParticipantId: DREW.id, targetHandle: "drew", status: "pending" }] }
  } as Partial<ChatMessage>);
  assert.match(textOf(classic(false, asking)), /Do you want to ask @drew\?/, "the approval card");
  const failed = chatMessage("fail", "participant", 16, { participantId: MAIN.id, status: "error", content: "The run failed: the CLI exited.", metadata: { activityEvents: STEPS } } as Partial<ChatMessage>);
  assert.match(textOf(classic(false, failed)), /The run failed: the CLI exited\./);
});

test("the timeline's thinking row keeps who is thinking and drops the step in progress", () => {
  const row = { key: "k", runId: "r", participantLabel: "@drew", activity: "Running npm test", startedAt: "", updatedAt: "" };
  assert.match(textOf(draw(true, <ChatThinkingRowItem row={row} />).root), /Running npm test/);
  const hidden = textOf(draw(false, <ChatThinkingRowItem row={row} />).root);
  assert.doesNotMatch(hidden, /npm test/);
  assert.match(hidden, /@drew/);
  assert.match(hidden, /Thinking/);
});
