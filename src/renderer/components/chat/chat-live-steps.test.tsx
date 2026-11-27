// A running reply's steps folded into one live line (the User, 2026-11-27):
// the step in progress, shimmering, the newest replacing it; pressed, every
// step so far, growing while open; pressed again, folded. The same in the
// sessions view and the classic view; notices about the run stay in the reply.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAgentActivityEvent } from "../../../shared/types";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import { ChatSessionsTimelineRow } from "./chat-sessions-timeline-row";
import { sameActivityRow } from "./chat-activity-rows";
import { chatInlineTranscriptParts } from "../../../shared/processingTranscript";
import { MAIN, chatMessage, sessionsConversation } from "./chat-sessions-fixtures.test";

import { WORK_ROWS, activity, hasClass, itemProps, liveLineOf, manySteps, noop, pressLiveLine, renderSessionsRow, rowsOf, sessionsOf, textOf, workEvents } from "./chat-sessions-activity-fixtures.test";

test("a running reply of the sessions view: Working for over a hairline, then one shimmering line naming the step in progress, which opens to every step so far and grows while open; no Running label, no Thinking word, no boxed groups, no controls of its own", () => {
  const sessions = sessionsOf(sessionsConversation());
  const running = chatMessage("main-run", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-main" } });
  const live = (events: ChatAgentActivityEvent[]) => ({ liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: events }, onStopRun: noop } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  const tree = (events: ChatAgentActivityEvent[]) => (
    <TooltipProvider>
      <ChatSessionsPresentationContext.Provider value>
        <ChatSessionsTimelineRow itemProps={itemProps(running, live(events))} context={{ sessions, onOpenMember: noop, onOpenTask: noop }} />
      </ChatSessionsPresentationContext.Provider>
    </TooltipProvider>
  );
  const events = workEvents();
  let renderer: ReactTestRenderer | undefined;
  act(() => { renderer = create(tree(events.slice(0, 2))); });
  const root = renderer!.root;
  assert.match(textOf(root.find((node) => node.props?.["data-testid"] === "chat-sessions-working")), /^Working for \d+(s|m \d+s|h \d+m)$/);
  assert.deepEqual(liveLineOf(root), ["web", "EUR to USD exchange rate today", "current", "folded"], "one line: the step in progress, shimmering");
  assert.equal(rowsOf(root).length, 0, "no row per step");
  act(() => renderer!.update(tree(events)));
  assert.deepEqual(liveLineOf(root), ["tool", "Using mcp__accord_agents__app_chat_get_context", "current", "folded"], "the newest step replaces it");
  assert.equal(rowsOf(root).length, 0);
  const text = textOf(root);
  assert.doesNotMatch(text, /Running|Thinking\b|commands?\b/, "no status label, no placeholder word, no group summary");
  assert.equal(root.findAll(hasClass("chat-inline-activity-group")).length, 0, "no boxed groups");
  assert.equal(root.findAll(hasClass("message-actions")).length, 0, "no stop or copy on the running reply: the composer stops it (also with text typed, Stop beside Send)");
  assert.equal(root.findAll((node) => node.props?.label === "Stop response" || node.props?.label === "Copy message").length, 0);

  pressLiveLine(root);
  assert.equal(liveLineOf(root)[3], "open");
  assert.deepEqual(rowsOf(root), WORK_ROWS.map((row) => [...row, ""]), "pressed: every step so far, one quiet row each");
  const more = activity("a7", "command", "Running command", 0, "npm run build");
  act(() => renderer!.update(tree([...events, more])));
  assert.deepEqual(rowsOf(root).at(-1), ["shell", "npm run build", ""], "open, it grows with each new step");
  assert.deepEqual(liveLineOf(root).slice(1, 2), ["npm run build"]);
  pressLiveLine(root);
  assert.equal(rowsOf(root).length, 0, "pressed again, it folds");
  act(() => renderer!.unmount());

  // Before its first step it is the header alone: no "Thinking".
  const fresh = renderSessionsRow({ ...running, id: "main-fresh" }, sessions);
  assert.deepEqual(liveLineOf(fresh), []);
  assert.equal(rowsOf(fresh).length, 0);
  assert.doesNotMatch(textOf(fresh), /Thinking/);
});

test("a running reply's notices about the run stay in it where they came, never folded into the live line", () => {
  const sessions = sessionsOf(sessionsConversation());
  const running = chatMessage("main-notice", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-notice" } });
  const stalled = activity("n2", "status", "@main has produced no provider output for 5 minutes.", 0);
  const signIn: ChatAgentActivityEvent = { ...activity("n3", "approval", "Codex needs you to sign in again", 0), status: "failed" };
  const root = renderSessionsRow(running, sessions, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "",
    activityEvents: [activity("c1", "command", "Running command", 0, "npm test"), stalled, signIn] } } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  assert.deepEqual(liveLineOf(root).slice(0, 2), ["shell", "npm test"], "the line names the step, not a notice");
  assert.deepEqual(rowsOf(root).map((row) => row[1]), [stalled.label, signIn.label], "the notices show as their rows, folded or not");
  assert.equal(rowsOf(root).some((row) => row[2] === "current"), false, "only the live line shimmers");
});

test("the classic view's running reply keeps its status line and its stop control, with its steps folded into the same live line", () => {
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
  assert.deepEqual(liveLineOf(root), ["tool", "Using mcp__accord_agents__app_chat_get_context", "current", "folded"], "one live line in place of Thinking");
  assert.doesNotMatch(textOf(root), /Thinking\b|commands?\b/, "no Thinking word and no N commands line");
  assert.equal(root.findAll(hasClass("chat-inline-activity-group")).length, 0);
  pressLiveLine(root);
  assert.deepEqual(rowsOf(root), WORK_ROWS.map((row) => [...row, ""]), "pressed: every step so far");
  act(() => renderer!.unmount());
});

test("a long running turn's opened live line draws its newest 50 steps under a muted 'N earlier steps', which opens the rest, and each step is drawn again only when it changed", () => {
  const sessions = sessionsOf(sessionsConversation());
  const running = chatMessage("main-long", "participant", 12, { participantId: MAIN.id, status: "pending", content: "", metadata: { runId: "run-long" } });
  const events = manySteps(180);
  const root = renderSessionsRow(running, sessions, { liveProgress: { participantLabel: "main", state: "running" as const, partialContent: "", activityEvents: events } } as Partial<Parameters<typeof ChatMessageItem>[0]>);
  assert.deepEqual(liveLineOf(root).slice(0, 2), ["shell", "step 180"]);
  pressLiveLine(root);
  const rows = rowsOf(root);
  assert.equal(rows.length, 50, "the newest 50");
  assert.equal(rows[0]![1], "step 131");
  assert.deepEqual(rows.at(-1), ["shell", "step 180", ""]);
  const earlier = root.find((node) => typeof node.type === "string" && node.props?.["data-testid"] === "chat-sessions-activity-earlier");
  assert.equal(textOf(earlier), "130 earlier steps");
  assert.equal(earlier.type, "button");
  act(() => earlier.props.onClick());
  assert.equal(rowsOf(root).length, 180, "all of them once opened");

  // The same step handed again as a new object (a streamed update) is not a change.
  assert.equal(sameActivityRow(events[3]!, { ...events[3]! }), true);
  assert.equal(sameActivityRow(events[3]!, { ...events[3]!, detail: "other" }), false);
  const parts = chatInlineTranscriptParts("", events);
  assert.equal(parts.filter((part) => part.kind === "activity").every((part, index) => part.kind === "activity" && part.event === events[index]), true,
    "an event whose place does not move keeps its own object, so its row is not drawn again");
});

