// A running reply of the sessions view (the User, 2026-11-21), T3 Code's turn
// in progress: "Working for 4s" over a hairline, one quiet row per step by
// kind, the newest shimmering; its words and posts in order between the rows;
// once done, its Worked for opens to the same rows. The classic view keeps
// its own running reply.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAgentActivityEvent, ChatMessage, Conversation } from "../../../shared/types";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { ChatSessionsTimelineRow } from "./chat-sessions-timeline-row";
import { newestActivityBlocks, sameActivityRow } from "./chat-sessions-activity";
import { ChatWaitingMessageActions } from "./chat-waiting-message";
import { chatInlineTranscriptParts } from "../../../shared/processingTranscript";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import { chatTopLevelMessages } from "./chat-thread-data";
import { DREW, GERA, MAIN, PARTICIPANTS, TAYLOR, chatMessage, disclosure, sessionsConversation, sessionsMessages } from "./chat-sessions-fixtures.test";

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);

/** The main session on Codex: its steps are a row each (a Claude Code
 *  member's are folded, below). */
const CODEX_MAIN = PARTICIPANTS.map((item) => item.id === MAIN.id ? { ...item, kind: "codex-cli" as const } : item);

const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);

function sessionsOf(conversation: Conversation): ChatSessionsView {
  let result: ChatSessionsView | undefined;
  function Harness(): null {
    result = useChatSessionsView({
      conversation,
      view: "sessions",
      participants: conversation.metadata.participants as typeof PARTICIPANTS,
      participantStatusById: STATUSES
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
  assert.equal(root.findAll(hasClass("message-actions")).length, 0, "no stop or copy on the running reply: the composer stops it (also with text typed, Stop beside Send)");
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

test("a part of a turn the User's next message joined keeps its steps open with no Worked for of its own; with nothing in it, it is not drawn", () => {
  const sessions = sessionsOf(sessionsConversation());
  const part = chatMessage("main-part", "participant", 14, {
    participantId: MAIN.id, content: "Checking the rate first.", metadata: { turnContinues: true, activityEvents: workEvents() }
  } as Partial<ChatMessage>);
  const root = renderSessionsRow(part, sessions);
  assert.equal(root.findAll((node) => node.props?.["data-testid"] === "chat-worked-fold").length, 0, "no Worked for: the turn's one is on its last part");
  assert.equal(root.findAll((node) => typeof node.type === "string" && node.props["data-testid"] === "chat-turn-continues").length, 1);
  assert.deepEqual(rowsOf(root), WORK_ROWS.map((row) => [...row, ""]), "its steps stay open, as in the CLI's transcript");
  assert.match(textOf(root), /Checking the rate first\./);
  const empty = chatMessage("main-empty", "participant", 15, { participantId: MAIN.id, content: "", metadata: { turnContinues: true } } as Partial<ChatMessage>);
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<TooltipProvider><ChatMessageItem {...itemProps(empty, { presentation: "sessions" })} /></TooltipProvider>);
  });
  assert.equal(renderer!.toJSON(), null, "a part with nothing in it is not drawn");
  act(() => renderer!.unmount());
  // Nor does it get a row of the timeline (a row around nothing left a gap).
  const conversation = sessionsConversation({}, [...sessionsMessages(), empty]);
  assert.equal(sessionsOf(conversation).mainMessages.some((message) => message.id === "main-empty"), false, "no row in the sessions view");
  assert.equal(chatTopLevelMessages(conversation).some((message) => message.id === "main-empty"), false, "no row in the classic view");
});

test("the classic view's part of a turn her next message joined shows its steps open, and Show full stream still opens and closes its full stream", () => {
  const part = chatMessage("main-part", "participant", 14, {
    participantId: MAIN.id, content: "Checking the rate first.",
    metadata: { turnContinues: true, activityEvents: workEvents(), processingTranscript: { content: "Let me look at the atlas.\n\nChecking the rate first." } }
  } as Partial<ChatMessage>);
  const opened = new Set<string>();
  const toggles = { ...disclosure(), expandedProcessingTranscriptMessageIds: opened, toggleProcessingTranscript: (id: string) => { opened.has(id) ? opened.delete(id) : opened.add(id); } };
  const render = (): { root: ReactTestInstance; unmount: () => void } => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(<TooltipProvider><ChatMessageItem {...itemProps(part, { activityDisclosure: toggles })} /></TooltipProvider>);
    });
    return { root: renderer!.root, unmount: () => act(() => renderer!.unmount()) };
  };
  const closed = render();
  assert.equal(closed.root.findAll(hasClass("chat-worked")).length, 0, "no Worked for of its own");
  assert.equal(closed.root.findAll(hasClass("chat-inline-transcript")).length > 0, true, "its steps and words, open");
  assert.doesNotMatch(textOf(closed.root), /Let me look at the atlas\./, "the full stream stays closed until asked");
  const show = closed.root.find((node) => node.props?.label === "Show full stream" && typeof node.props.onClick === "function");
  assert.equal(show.props.pressed, false);
  act(() => show.props.onClick());
  closed.unmount();
  const open = render();
  assert.match(textOf(open.root), /Let me look at the atlas\./, "Show full stream opens it");
  const hide = open.root.find((node) => node.props?.label === "Hide full stream" && typeof node.props.onClick === "function");
  act(() => hide.props.onClick());
  open.unmount();
  const closedAgain = render();
  assert.doesNotMatch(textOf(closedAgain.root), /Let me look at the atlas\./, "and Hide full stream closes it");
  closedAgain.unmount();
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

test("a Claude Code member's steps are one line as its CLI folds them: the step it is at, then how many of each; pressed, their rows", () => {
  const sessions = sessionsOf(sessionsConversation());
  const steps = [
    activity("a1", "tool", "accord_agents - app_artifact_read (MCP)", 0),
    activity("a2", "command", "Listing the old chat's artifacts", 0, "sqlite3 -readonly app.db '.tables'"),
    activity("a3", "tool", "Reading /tmp/known-issues.md", 0),
    activity("a4", "file-edit", "Update(/tmp/known-issues.md)", 0),
    activity("a5", "command", "Running the affected tests", 0, "npm test")
  ];
  const lines = (root: ReactTestInstance): string[] => root.findAll((node) => typeof node.type === "string" &&
    (node.props["data-testid"] === "chat-sessions-step-fold" || node.props["data-testid"] === "chat-sessions-activity-row"))
    .map((node) => `${node.props["data-testid"] === "chat-sessions-step-fold" ? "fold" : "row"}${node.props.className.includes("is-current") ? " current" : ""}: ${textOf(node)}`);
  const running = chatMessage("main-claude", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-claude" } });
  const live = (count: number) => renderSessionsRow(running, sessions, { participants: PARTICIPANTS,
    liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: steps.slice(0, count) } } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  assert.deepEqual(lines(live(2)), ["fold current: Listing the old chat's artifacts"]);
  assert.deepEqual(lines(live(5)), ["fold: Read 1 file, called accord_agents, ran 1 shell command", "row: Update(/tmp/known-issues.md)", "fold current: Running the affected tests"]);

  const done = chatMessage("main-claude-done", "participant", 14, { participantId: MAIN.id, content: "Done.", metadata: { workedMs: 4_000, activityEvents: steps } } as Partial<ChatMessage>);
  const root = renderSessionsRow(done, sessions, { participants: PARTICIPANTS, activityDisclosure: { ...disclosure(), expandedProcessingTranscriptMessageIds: new Set(["main-claude-done"]) } });
  assert.deepEqual(lines(root), ["fold: Read 1 file, called accord_agents, ran 1 shell command", "row: Update(/tmp/known-issues.md)", "fold: Ran 1 shell command"]);
  const fold = root.findAll((node) => node.type === "button" && node.props["data-testid"] === "chat-sessions-step-fold")[0]!;
  act(() => fold.props.onClick());
  assert.deepEqual(lines(root).slice(0, 4), [
    "fold: Read 1 file, called accord_agents, ran 1 shell command", "row: accord_agents - app_artifact_read (MCP)", "row: Listing the old chat's artifacts", "row: Reading /tmp/known-issues.md"
  ]);
});

test("a message its member has not taken yet is sent now or taken back from the message itself; its reply has no row", () => {
  const base = sessionsConversation();
  const running = chatMessage("main-running", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-running", sourceMessageId: "u-first" } } as Partial<ChatMessage>);
  const waiting = chatMessage("u-waiting", "user", 13, { content: "And the docs?" });
  const queued = chatMessage("main-queued", "participant", 13, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-queued", sourceMessageId: "u-waiting", queuedBehind: { handle: "main" } } } as Partial<ChatMessage>);
  const sessions = sessionsOf({ ...base, messages: [...base.messages, running, waiting, queued] });
  const shown = sessions.mainMessages.map((message) => message.id);
  assert.ok(shown.includes("main-running") && shown.includes("u-waiting"));
  assert.ok(!shown.includes("main-queued"), "no Queued row");
  const stopped: string[] = [];
  const sentNow: string[] = [];
  const row = (message: ChatMessage) => renderSessionsRow(message, sessions, {
    onStopRun: (runId: string) => { stopped.push(runId); },
    onSendNow: (runId: string, waitingRunId?: string) => { sentNow.push(`${runId} for ${waitingRunId}`); }
  } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  const press = (root: ReactTestInstance, testId: string): void => {
    const button = root.find((node) => node.type === "button" && node.props?.["data-testid"] === testId);
    act(() => button.props.onClick({ defaultPrevented: false, preventDefault: noop, stopPropagation: noop }));
  };
  const root = row(waiting);
  assert.doesNotMatch(textOf(root), /Queued/);
  press(root, "chat-waiting-send-now");
  assert.deepEqual(sentNow, ["run-running for run-queued"], "Send now names the running reply and the message that waits");
  assert.deepEqual(stopped, [], "Send now stops nothing");
  press(row(waiting), "chat-waiting-take-back");
  assert.deepEqual(stopped, ["run-queued"]);
  assert.equal(row(running).findAll((node) => node.props?.["data-testid"] === "chat-waiting-message").length, 0);
});

/** A long turn: `count` steps, each a command. */
function manySteps(count: number): ChatAgentActivityEvent[] {
  return Array.from({ length: count }, (_, index) => activity(`s${index + 1}`, "command", "Running command", 0, `step ${index + 1}`));
}

test("a long running turn draws only its newest 50 steps under a muted 'N earlier steps', and each step is drawn again only when it changed", () => {
  const sessions = sessionsOf(sessionsConversation());
  const running = chatMessage("main-long", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-long" } });
  const events = manySteps(180);
  const root = renderSessionsRow(running, sessions, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: events } } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  const rows = rowsOf(root);
  assert.equal(rows.length, 50, "the newest 50");
  assert.equal(rows[0]![1], "step 131");
  assert.deepEqual(rows.at(-1), ["shell", "step 180", "current"]);
  const earlier = root.find((node) => typeof node.type === "string" && node.props?.["data-testid"] === "chat-sessions-activity-earlier");
  assert.equal(textOf(earlier), "130 earlier steps");
  assert.notEqual(earlier.type, "button", "not opened while it runs");

  // The same step handed again as a new object (a streamed update) is not a change.
  assert.equal(sameActivityRow(events[3]!, { ...events[3]! }), true);
  assert.equal(sameActivityRow(events[3]!, { ...events[3]!, detail: "other" }), false);
  const parts = chatInlineTranscriptParts("", events);
  assert.equal(parts.filter((part) => part.kind === "activity").every((part, index) => part.kind === "activity" && part.event === events[index]), true,
    "an event whose place does not move keeps its own object, so its row is not drawn again");
});

test("a finished long turn's fold opens to its newest 50 steps, and 'N earlier steps' opens the rest", () => {
  const sessions = sessionsOf(sessionsConversation());
  const done = chatMessage("main-long-done", "participant", 14, { participantId: MAIN.id, content: "Done.", metadata: { workedMs: 60_000, activityEvents: manySteps(70) } } as Partial<ChatMessage>);
  const toggles = { ...disclosure(), expandedProcessingTranscriptMessageIds: new Set(["main-long-done"]), toggleProcessingTranscript: noop };
  const root = renderSessionsRow(done, sessions, { activityDisclosure: toggles });
  assert.equal(rowsOf(root).length, 50);
  const earlier = root.find((node) => typeof node.type === "string" && node.props?.["data-testid"] === "chat-sessions-activity-earlier");
  assert.equal(earlier.type, "button");
  assert.equal(textOf(earlier), "20 earlier steps");
  act(() => earlier.props.onClick());
  assert.equal(rowsOf(root).length, 70, "all of them once opened");
  assert.equal(root.findAll((node) => typeof node.type === "string" && node.props?.["data-testid"] === "chat-sessions-activity-earlier").length, 0);
});

test("the newest-steps cut keeps a group's newest steps and drops the words before them", () => {
  const events = manySteps(5);
  const blocks = [
    { kind: "activity-group", events: events.slice(0, 3) },
    { kind: "text", text: "between" },
    { kind: "activity-group", events: events.slice(3) }
  ];
  const cut = newestActivityBlocks(blocks, 3);
  assert.equal(cut.hidden, 2);
  assert.deepEqual(cut.blocks.map((block) => block.kind === "text" ? "text" : block.events!.map((event) => event.id).join(",")), ["s3", "text", "s4,s5"]);
});

test("folded steps are cut by the lines they are drawn as: a fold is one, and what it counts stays whole", () => {
  const [a, b, c, d, e] = manySteps(5) as [ChatAgentActivityEvent, ChatAgentActivityEvent, ChatAgentActivityEvent, ChatAgentActivityEvent, ChatAgentActivityEvent];
  const edit = activity("edit", "tool", "Update(/tmp/a.md)", 0);
  const blocks = [
    { kind: "activity-group", events: [a, b, edit, c] },
    { kind: "text", text: "between" },
    { kind: "activity-group", events: [d, e] }
  ];
  const shown = (max: number) => {
    const cut = newestActivityBlocks(blocks, max, true);
    return [cut.hidden, ...cut.blocks.map((block) => block.kind === "text" ? "text" : block.events!.map((event) => event.id).join(","))];
  };
  assert.deepEqual(shown(4), [0, "s1,s2,edit,s3", "text", "s4,s5"], "four lines");
  assert.deepEqual(shown(3), [2, "edit,s3", "text", "s4,s5"]);
  assert.deepEqual(shown(1), [4, "text", "s4,s5"], "the words after the last step left out stay");

  const sessions = sessionsOf(sessionsConversation());
  const long = Array.from({ length: 120 }, (_, index) => index % 2 ? activity(`c${index}`, "command", "Running command", 0, `step ${index}`) : activity(`e${index}`, "tool", `Update(/tmp/${index}.md)`, 0));
  const running = chatMessage("main-claude-long", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-claude-long" } });
  const root = renderSessionsRow(running, sessions, { participants: [{ ...MAIN, kind: "claude-code" }],
    liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: long } } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  const earlier = root.find((node) => typeof node.type === "string" && node.props?.["data-testid"] === "chat-sessions-activity-earlier");
  assert.equal(textOf(earlier), "70 earlier steps", "a long turn still draws its newest 50 lines");
});

test("a message sent now that still waits, behind the next reply, can be sent now again", () => {
  const sent: string[] = [];
  const actions = (behindRunId: string) => <ChatWaitingMessageActions runId="run-queued" behindRunId={behindRunId} onTakeBack={noop} onSendNow={(runId) => { sent.push(runId); }} />;
  let renderer: ReactTestRenderer | undefined;
  act(() => { renderer = create(actions("run-1")); });
  const button = (testId: string) => renderer!.root.find((node) => node.type === "button" && node.props["data-testid"] === testId);
  const press = (testId: string) => act(() => button(testId).props.onClick({ defaultPrevented: false, preventDefault: noop, stopPropagation: noop }));
  press("chat-waiting-send-now");
  assert.equal(button("chat-waiting-send-now").props.disabled, true);
  assert.equal(button("chat-waiting-take-back").props.disabled, true);
  act(() => renderer!.update(actions("run-2")));
  assert.equal(button("chat-waiting-send-now").props.disabled, false);
  press("chat-waiting-send-now");
  assert.deepEqual(sent, ["run-1", "run-2"]);
});
