import assert from "node:assert/strict";
import test from "node:test";
import { act as domAct, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { buildSessionsViewIndex, memberSessionMessages } from "../../../shared/mainSession";
import { latestTaskByMember, sessionsMemberActivity, sessionsMemberRows, sessionsMemberTitle } from "../../../shared/mainSessionView";
import type { AgentHealth, AppSettings, ChatMessage, Conversation } from "../../../shared/types";
import { SubagentProvidersContext } from "./subagent-providers-context";
import { FORK_TO_NEW_CHAT_DETAIL, FORK_TO_NEW_CHAT_LABEL } from "../../../shared/forkToNewChat";
import { ChatParticipantRosterRow } from "./chat-participant-roster-row";
import { forkToNewChatReasonFor, machineForkSupportFrom } from "./use-fork-to-new-chat";
import { ChatMembersPanel } from "./chat-members-panel";
import { ChatAgentCard, formatCompactDuration } from "./chat-agent-row";
import { memberEffortLabel, useMemberModelSummary } from "./use-member-model-summary";
import { ChatMemberComposerControls, ChatModelMenu, type ChatModelAccessPatch } from "./chat-model-access-picker";
import { latestAndOlderModels, modelFamily } from "./chat-model-groups";
import { resetMemberModelCatalogs } from "./chat-member-model-name";
import { memberSettingsActions } from "./chat-member-model-access";
import { runtimePatchFields } from "../../app/use-chat-actions";
import { defaultChatAgentPermissions } from "../../../shared/agentPermissions";
import { applyChatAccessOptionById } from "../../../shared/chatAccessModes";
import { ParticipantRuntimeControls } from "./chat-participant-runtime-controls";
import type { ChatParticipant } from "../../../shared/types";
import { ChatMemberSessionPanel, type ChatMemberSendRequest } from "./chat-member-session-panel";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { DREW, GERA, MAIN, PARTICIPANTS, TAYLOR, sessionsMessages, disclosure } from "./chat-sessions-fixtures.test";

const noop = (): void => undefined;
// A click as the DOM gives it; tooltip triggers read it.
const click = { defaultPrevented: false, preventDefault: noop, stopPropagation: noop };
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byTestId = (id: string) => (node: ReactTestInstance): boolean => typeof node.type === "string" && node.props["data-testid"] === id;
/** Opens every provider row of the side panel's Agents, as a click on each does. */
const openProviders = (root: ReactTestInstance): void => {
  for (const toggle of root.findAll(byTestId("chat-subagent-toggle"))) {
    if (!toggle.props["aria-expanded"]) act(() => toggle.props.onClick());
  }
};

const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);
const SETTINGS = { chatRoleConfigs: [], chatSavedPrompts: [], chatParticipantConfigs: [], cliProviderHosts: [] } as unknown as AppSettings;

// jsdom gives the composer a document; the bridge answers nothing, and its
// subscriptions (onSomething) hand back a way to stop listening.
(globalThis as { window?: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { consensus: unknown }).consensus = new Proxy({}, {
  get: (_target, name) => (String(name).startsWith("on") ? () => noop : async () => undefined)
});

test("provider rings follow the main session's machine and skip its inherited custom host", async () => {
  const host = window as unknown as { consensus: unknown };
  const bridge = host.consensus;
  const snapshot = { provider: "codex-cli", hasPlanLimits: true, observedAt: new Date().toISOString(), windows: [], facts: [] };
  host.consensus = {
    listMachines: async () => ({ machines: [{ id: "studio", name: "Studio", lastHello: {
      providers: [{ kind: "codex-cli", installed: true }, { kind: "claude-code", installed: true }]
    } }], status: [] }),
    getPlanUsage: async () => ({
      local: [{ ...snapshot, plan: "Laptop account" }],
      machines: { studio: { snapshots: [{ ...snapshot, plan: "Studio account" }] } }
    })
  };
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(<TooltipProvider><ChatMembersPanel rows={{ current: [], previous: [] }}
        subagents={{ main: { kind: "claude-code", hostId: "custom", homeMachineId: "studio" } }}
        activity={sessionsMemberActivity([])} runIdsByParticipantId={new Map()} memberTitle={() => ""} onOpenMember={noop} onClose={noop} /></TooltipProvider>);
    });
    const rows = renderer!.root.findAll(byTestId("chat-subagent"));
    const row = (kind: string) => rows.find((item) => item.props["data-provider-kind"] === kind)!;
    assert.equal(row("claude-code").findAll(byTestId("chat-plan-usage")).length, 0);
    act(() => row("codex-cli").find(byTestId("chat-plan-usage")).props.onClick());
    assert.match(textOf(row("codex-cli").find(byTestId("chat-plan-usage-detail"))), /Studio account/);
  } finally {
    act(() => renderer?.unmount());
    host.consensus = bridge;
  }
});

test("the side panel lists every session but the main session as T3 Code does: glyph and state dot, task title, model name and time, Stop per row only", async () => {
  const messages = sessionsMessages();
  // drew runs on Claude Code's "opus": the row names the model as the CLI's list does.
  const drew = { ...DREW, kind: "claude-code" as const, model: "opus" };
  const participants = PARTICIPANTS.map((member) => member.id === DREW.id ? drew : member);
  const rows = sessionsMemberRows(participants, MAIN.id, STATUSES, latestTaskByMember(messages));
  const stopped: Array<readonly string[]> = [];
  const opened: string[] = [];
  const bridge = (window as unknown as { consensus: unknown }).consensus;
  resetMemberModelCatalogs();
  (window as unknown as { consensus: unknown }).consensus = new Proxy({}, {
    get: (_target, name) => name === "listProviderModels"
      ? async (kind: string) => kind === "claude-code"
        ? { models: [{ id: "opus", label: "Opus 5.5", recommended: true, source: "cli" }, { id: "haiku", label: "Haiku 5.5", source: "cli" }] }
        : undefined
      : String(name).startsWith("on") ? () => noop : async () => undefined
  });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <ChatMembersPanel
            rows={rows}
            formerRows={[{ member: { id: "p-gone", handle: "gone", kind: "gemini-cli" }, title: "Old task", status: "done" }]}
            activity={sessionsMemberActivity(messages)}
            runIdsByParticipantId={new Map([[DREW.id, ["run-drew"]]])}
            memberTitle={(id) => sessionsMemberTitle(participants.find((member) => member.id === id), latestTaskByMember(messages).get(id)?.item)}
            onOpenMember={(id) => opened.push(id)}
            onStopRuns={(runIds) => stopped.push(runIds)}
            onClose={noop}
          />
        </TooltipProvider>
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const root = renderer!.root;
    const memberRows = () => root.findAll(byTestId("chat-members-row"));
    // Sessions are folded under their provider (variant B) until its row is opened.
    assert.equal(memberRows().length, 0, "folded under their providers");
    openProviders(root);
    assert.deepEqual(memberRows().map((row) => [row.props["data-participant-id"], row.props["data-member-status"]]), [[DREW.id, "running"], [TAYLOR.id, "waiting"]],
      "the main session is not listed; gera's task is done, so it waits under History");
    assert.equal(textOf(root.find(byTestId("chat-members-agents")).find((node) => node.type === "h3")), "Agents");
    assert.equal(textOf(root.find(byTestId("chat-subagents-running"))), "1 running");
    const drewRow = memberRows()[0]!;
    assert.equal(textOf(drewRow.find((node) => typeof node.props?.className === "string" && node.props.className === "chat-agent-title")), "Task for drew: fix the drew part", "named by its task");
    assert.doesNotMatch(textOf(drewRow), /Opus|opus|Claude Code/, "no model in a row (the User, 2026-11-22): its hover card names it");
    // The name its hover card gives the model: the CLI's list's, never the id.
    let probe: ReturnType<typeof create> | undefined;
    const ModelProbe = (): JSX.Element => <span>{useMemberModelSummary(drew, { machines: [], status: [] }).model}</span>;
    await act(async () => { probe = create(<ModelProbe />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(textOf(probe!.root.find((node) => node.type === "span")), "Opus 5.5");
    act(() => probe!.unmount());
    assert.doesNotMatch(textOf(root), /@/, "no handles");
    assert.equal(drewRow.findAll((node) => node.props?.["data-provider-kind"] === "claude-code").length, 1, "its provider's glyph");
    assert.equal(drewRow.findAll((node) => typeof node.props?.className === "string" && node.props.className === "chat-agent-dot is-running").length, 1, "a dot for its state");
    assert.equal(drewRow.findAll(byTestId("chat-agent-time")).length, 1, "how long it runs");
    // No state in words in a row (the User, 2026-11-22): the dot says it, the card and the accessible name in words.
    const taylorRow = memberRows()[1]!;
    assert.doesNotMatch(textOf(taylorRow), /Waiting for you|Running|Done|Failed|Stopped/, "no state words in a row");
    assert.equal(taylorRow.findAll((node) => typeof node.props?.className === "string" && node.props.className === "chat-agent-dot is-waiting").length, 1, "its dot says it waits");
    assert.match(String(taylorRow.find((node) => node.type === "button" && node.props.className === "chat-agent-row-main").props["aria-label"]), /Waiting for you/, "said to a screen reader");
    assert.doesNotMatch(textOf(drewRow), /Running/, "a running row says so only by its dot");
    assert.doesNotMatch(textOf(taylorRow), /Antigravity/, "no model or CLI name in a row");
    assert.equal(memberRows()[1]!.findAll(byTestId("chat-members-row-stop")).length, 0, "nothing to stop for a session that runs nothing");
    assert.equal(root.findAll(byTestId("chat-members-stop-all")).length, 0, "no Stop all");
    assert.doesNotMatch(textOf(root), /Stop all/);

    act(() => drewRow.findAll(byTestId("chat-members-row-stop"))[0]!.props.onClick(click));
    assert.deepEqual(stopped, [["run-drew"]], "Stop stops that session only");

    act(() => drewRow.findAll((node) => node.type === "button" && node.props.className === "chat-agent-row-main")[0]!.props.onClick());
    assert.deepEqual(opened, [DREW.id], "a click opens its session");

    const history = root.find(byTestId("chat-members-history"));
    assert.equal(textOf(history), "History2", "ended and removed sessions folded in one group, with its count");
    act(() => history.findAll((node) => node.type === "button")[0]!.props.onClick());
    assert.deepEqual(memberRows().map((row) => row.props["data-participant-id"]), [DREW.id, TAYLOR.id, GERA.id, "p-gone"]);
    const geraRow = memberRows()[2]!;
    assert.equal(geraRow.props["data-member-status"], "done");
    assert.equal(geraRow.findAll((node) => typeof node.props?.className === "string" && node.props.className.startsWith("chat-agent-dot")).length, 0,
      "an ended session has no dot: its state no longer matters (its card still says it)");
    assert.equal(textOf(root.find(byTestId("chat-members-history")).find((node) => node.type === "button" && node.props.className === "chat-agents-group-toggle")), "History", "the count goes once it is open");
    assert.match(textOf(root.find(byTestId("chat-members-removed"))), /^Removed from this thread/, "a session no longer in the chat, under its own label");
    const gone = memberRows().find((row) => row.props["data-participant-id"] === "p-gone")!;
    assert.match(textOf(gone), /Old task/);
    assert.equal(gone.findAll((node) => node.props?.["data-provider-kind"] === "gemini-cli").length, 1, "it keeps the glyph its task named");
    assert.equal(gone.findAll(byTestId("chat-members-row-stop")).length, 0, "read-only: no Stop");
    act(() => gone.findAll((node) => node.type === "button" && node.props.className === "chat-agent-row-main")[0]!.props.onClick());
    assert.deepEqual(opened, [DREW.id, "p-gone"], "its session opens");
    act(() => renderer!.unmount());
  } finally {
    (window as unknown as { consensus: unknown }).consensus = bridge;
    resetMemberModelCatalogs();
  }
});

test("every row has the same anatomy: a waiting one says how long it worked before it began to wait, an ended one its task's time", () => {
  const started = new Date(Date.now() - 5 * 60_000).toISOString();
  const waited = new Date(Date.now() - 3 * 60_000).toISOString();
  const rows = {
    current: [
      { participant: TAYLOR, status: "waiting" as const },
      { participant: DREW, status: "stopped" as const, task: { messageId: "m", batch: {} as never, item: {} as never } }
    ],
    previous: []
  };
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMembersPanel rows={rows} activity={{ runningSince: new Map([[TAYLOR.id, started]]), finishedAt: new Map() }} runIdsByParticipantId={new Map([[TAYLOR.id, ["run-taylor"]]])}
          onStopRuns={noop}
          memberTitle={(id) => id === TAYLOR.id ? "Ask about the DB" : "Restyle"} waitingSince={new Map([[TAYLOR.id, waited]])}
          taskDurationMs={() => 245_000} onOpenMember={noop} onClose={noop} />
      </TooltipProvider>
    );
  });
  openProviders(renderer!.root);
  const times = renderer!.root.findAll(byTestId("chat-agent-time")).map((node) => textOf(node));
  assert.deepEqual(times, ["2m", "4m"], "waiting: from its turn's start to when it began to wait; stopped: its task's time");
  assert.equal(renderer!.root.findAll(byTestId("chat-members-row-stop")).length, 0, "Stop only while it runs: not on one waiting for the User, though its run is live");
  act(() => renderer!.unmount());
});

test("an agent's hover card names its CLI, model and effort, its state and time, its background work and what it does now", () => {
  const card = (row: Parameters<typeof ChatAgentCard>[0]["row"], backgroundTasks = 0): string => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => { renderer = create(<ChatAgentCard row={row} detail="Claude Code · Opus 5.5 · High" backgroundTasks={backgroundTasks} />); });
    const text = renderer!.root.children.map((child) => textOf(child as ReactTestInstance)).join("|");
    act(() => renderer!.unmount());
    return text;
  };
  const base = { id: "p-drew", mark: null, title: "Ход как в Claude Code", onOpen: noop };
  const running = card({ ...base, status: "running", since: new Date(Date.now() - 516_000).toISOString(), step: "npm run build" }, 2);
  assert.match(running, /^Ход как в Claude Code\|Claude Code · Opus 5\.5 · High\|Running · 8m 3\ds · 2 background tasks\|npm run build$/);
  assert.equal(card({ ...base, status: "done", durationMs: 245_000, result: "Done: new chats open in General." }),
    "Ход как в Claude Code|Claude Code · Opus 5.5 · High|Done · 4m 5s|Done: new chats open in General.");
  assert.equal(card({ ...base, status: "waiting" }), "Ход как в Claude Code|Claude Code · Opus 5.5 · High|Waiting for you", "no time known: none");
  assert.equal(card({ ...base, status: "waiting", durationMs: 125_000 }), "Ход как в Claude Code|Claude Code · Opus 5.5 · High|Waiting for you · 2m 5s", "how long it worked before");
  assert.equal(card({ ...base, status: "idle" }), "Ход как в Claude Code|Claude Code · Opus 5.5 · High|", "nothing more for one that never had a task");
  assert.equal(formatCompactDuration(5_000), "5s");
  assert.equal(formatCompactDuration(516_000), "8m");
  assert.equal(formatCompactDuration(90 * 60_000), "1.5h");
  assert.equal(formatCompactDuration(12 * 3_600_000), "12h");
  // The edges between the units.
  assert.equal(formatCompactDuration(59_999), "59s");
  assert.equal(formatCompactDuration(60_000), "1m");
  assert.equal(formatCompactDuration(3_599_999), "59m");
  assert.equal(formatCompactDuration(3_600_000), "1h");
  assert.equal(formatCompactDuration(599 * 60_000), "9.9h");
  assert.equal(formatCompactDuration(600 * 60_000), "10h");
  assert.equal(formatCompactDuration(-1), "0s");
});

test("a row's effort is the composer chip's: its own when its model has it, else her config's for the model her config starts", () => {
  const efforts = [{ id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "max", label: "Max" }];
  const catalog = { models: [
    { id: "opus", label: "Opus 5.5", recommended: true, source: "cli", supportedReasoningEfforts: efforts },
    { id: "haiku", label: "Haiku 5.5", source: "cli", supportedReasoningEfforts: [{ id: "low", label: "Low" }] }
  ] } as unknown as Parameters<typeof memberEffortLabel>[1];
  const claude = { kind: "claude-code" as const };
  assert.equal(memberEffortLabel({ ...claude, reasoningEffort: "high" }, catalog, undefined), "High", "its own");
  assert.equal(memberEffortLabel({ ...claude, model: "haiku", reasoningEffort: "high" }, catalog, undefined), undefined, "its model has no High");
  assert.equal(memberEffortLabel(claude, catalog, { reasoningEffort: "max" } as never), "Max", "her config's, for the default model");
  assert.equal(memberEffortLabel(claude, catalog, { model: "haiku", reasoningEffort: "max" } as never), undefined, "her config starts Haiku, which has no Max");
  assert.equal(memberEffortLabel({ ...claude, model: "opus" }, catalog, { reasoningEffort: "max" } as never), undefined, "a model of its own: her config's effort is not its");
  assert.equal(memberEffortLabel({ ...claude, hostId: "host-1" }, catalog, { reasoningEffort: "max" } as never), undefined, "an added provider: not her CLI's config");
});

test("with nobody running or waiting, the members panel lists every member as it is, no folded Previous", () => {
  const messages = sessionsMessages();
  const idle = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "idle"], [GERA.id, "idle"], [TAYLOR.id, "idle"]]);
  // Every task answered: nobody works, nobody waits.
  const tasks = new Map([...latestTaskByMember(messages)].map(([id, task]) => [id, { ...task, item: { ...task.item, status: "answered" as const } }]));
  const rows = sessionsMemberRows(PARTICIPANTS, MAIN.id, idle, tasks);
  assert.deepEqual(rows.previous, []);
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMembersPanel rows={rows} activity={sessionsMemberActivity(messages)} runIdsByParticipantId={new Map()} memberTitle={() => "A task"} onOpenMember={noop} onClose={noop} />
      </TooltipProvider>
    );
  });
  const root = renderer!.root;
  assert.equal(root.findAll(byTestId("chat-members-previous")).length, 0);
  openProviders(root);
  assert.deepEqual(root.findAll(byTestId("chat-members-row")).map((row) => [row.props["data-participant-id"], row.props["data-member-status"]]),
    [[DREW.id, "done"], [GERA.id, "done"], [TAYLOR.id, "idle"]],
    "the finished ones listed under their providers, in the chat's order, with the one that never had a task");
  act(() => renderer!.unmount());
});

test("a member's session shows its task folded to one line, its messages without avatars, and its composer writes to that member only", async () => {
  const messages = sessionsMessages();
  const index = buildSessionsViewIndex(messages, MAIN.id);
  const session = memberSessionMessages(messages, DREW.id, index);
  const sent: ChatMemberSendRequest[] = [];
  const drafts: string[] = [];
  const messageProps = (message: ChatMessage) => ({
    activityDisclosure: disclosure(),
    message,
    conversationId: "chat-sessions",
    participants: PARTICIPANTS,
    participantStatusById: STATUSES,
    busy: false,
    onApproveMentions: noop,
    onRejectMentions: noop,
    onRespondToChoice: noop,
    onToggleReaction: noop
  });
  const sharedNode = document.createElement("textarea");
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMemberSessionPanel
          member={DREW}
          title="Task for drew: fix the drew part"
          detail="Codex CLI"
          readOnly={false}
          mainSessionId={MAIN.id}
          status="running"
          runIds={["run-drew"]}
          messages={session}
          messageProps={messageProps}
          appSettings={SETTINGS}
          conversationId="chat-sessions"
          draft="Also check the logout button"
          busy={false}
          hasOlderMessages={false}
          olderMessagesLoading={false}
          onLoadOlderMessages={noop}
          onDraftChange={(value) => drafts.push(value)}
          onSend={async (request) => { sent.push(request); return true; }}
          onStopRuns={noop}
          onBack={noop}
          onClose={noop}
        />
      </TooltipProvider>,
      // One DOM node for every ref: a new one per call makes Radix re-anchor forever.
      { createNodeMock: () => sharedNode }
    );
  });
  const root = renderer!.root;
  const fold = root.find(byTestId("chat-member-task"));
  assert.match(textOf(fold), /^Task/, "the main session's task is the task: no label for the main session");
  assert.doesNotMatch(textOf(fold), /main session/i);
  assert.match(textOf(fold), /Task for drew: fix the drew part/);
  assert.doesNotMatch(textOf(fold), /with every detail/, "folded to its first line");
  act(() => fold.findAll((node) => node.type === "button")[0]!.props.onClick());
  assert.match(textOf(root.find(byTestId("chat-member-task"))), /with every detail/, "opens to the whole task");

  const articles = root.findAll((node) => node.type === "article");
  assert.deepEqual(articles.map((article) => article.props["data-message-id"]), ["drew-question", "main-answer", "to-drew", "drew-running"]);
  assert.ok(articles.every((article) => article.props["data-presentation"] === "sessions"));
  assert.equal(root.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(" ").includes("message-avatar")).length, 0);
  const answerMeta = articles[1]!.find((node) => typeof node.props.className === "string" && node.props.className.split(" ").includes("message-meta"));
  assert.ok(answerMeta.findAll((node) => node.props?.["data-provider-kind"] === MAIN.kind).length > 0, "the main session's answer is told apart by its provider's logo");
  assert.doesNotMatch(textOf(articles[1]!), /main session/i, "named by nothing");

  const composer = root.find((node) => node.props?.testId === "chat-member-composer");
  assert.equal(composer.props.placeholder, "Message Task for drew: fix the drew part...");
  assert.deepEqual(composer.props.participants, [], "no members to mention: it writes to this one");
  let result: boolean | undefined;
  await act(async () => { result = await composer.props.onSend([{ path: "src/logout.ts" }], [], [], undefined); });
  assert.equal(result, true);
  assert.deepEqual(sent, [{
    content: "Also check the logout button",
    repoFileMentions: [{ path: "src/logout.ts" }],
    imageAttachments: [],
    skillMentions: [],
    targetParticipantIds: [DREW.id]
  }], "no @ needed: the message goes to this member only");
  assert.deepEqual(drafts, [""], "the panel's draft is cleared once sent");
  act(() => renderer!.unmount());
});

/** A live (not read-only) member's session, as the right panel gives it. */
function renderLiveSession(extra: Partial<Parameters<typeof ChatMemberSessionPanel>[0]>): ReturnType<typeof create> {
  const messages = sessionsMessages();
  const index = buildSessionsViewIndex(messages, MAIN.id);
  const messageProps = (message: ChatMessage) => ({
    activityDisclosure: disclosure(), message, conversationId: "chat-sessions", participants: PARTICIPANTS, participantStatusById: STATUSES, busy: false,
    onApproveMentions: noop, onRejectMentions: noop, onRespondToChoice: noop, onToggleReaction: noop
  });
  const sharedNode = document.createElement("textarea");
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMemberSessionPanel
          member={DREW} title="Task for drew" detail="Codex CLI" readOnly={false} mainSessionId={MAIN.id} status="running"
          runIds={["run-drew", "run-drew-queued"]} messages={memberSessionMessages(messages, DREW.id, index)} messageProps={messageProps} appSettings={SETTINGS}
          conversationId="chat-sessions" draft="" busy={false} hasOlderMessages={false} olderMessagesLoading={false} onLoadOlderMessages={noop}
          onDraftChange={noop} onSend={async () => true} onStopRuns={noop} onBack={noop} onClose={noop}
          {...extra}
        />
      </TooltipProvider>,
      { createNodeMock: () => sharedNode }
    );
  });
  return renderer!;
}

const sessionHead = (root: ReactTestInstance): ReactTestInstance =>
  root.find((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.includes("chat-member-session-head"));

test("a running member's session has no Running label, no time and no Stop in its header: Stop is the composer's button and stops the runs the header's did", () => {
  const stopped: Array<readonly string[]> = [];
  const renderer = renderLiveSession({ onStopRuns: (runIds) => stopped.push(runIds) });
  const root = renderer.root;
  const head = sessionHead(renderer.root);
  assert.equal(head.findAll((node) => node.props?.["data-work-status"] !== undefined).length, 0, "no status label while it runs");
  assert.doesNotMatch(textOf(head), /Running/, "nor the word");
  assert.equal(head.findAll((node) => typeof node.props?.className === "string" && node.props.className.includes("elapsed")).length, 0, "nor its time");
  assert.equal(root.findAll(byTestId("chat-member-session-stop")).length, 0, "no square Stop in the header");
  assert.ok(head.findAll(byTestId("chat-member-session-back")).length > 0 && head.findAll((node) => node.props?.label === "Close").length > 0, "Back and Close stay");
  const composer = root.find((node) => node.props?.testId === "chat-member-composer");
  assert.equal(composer.props.stop?.label, "Stop Task for drew", "the composer stops what the header stopped, under the header button's name");
  composer.props.stop.onStop();
  assert.deepEqual(stopped, [["run-drew", "run-drew-queued"]], "every live run of this member, through the one stop handler");
  // Stop takes the send button's place, as the main session's.
  assert.equal(root.findAll(byTestId("chat-composer-stop")).length, 1);
  act(() => renderer.unmount());
});

test("a member's composer shows Stop only where the header's button did: with a run live and a stop handler, never without", () => {
  const idle = renderLiveSession({ status: "done", runIds: [] });
  assert.equal(idle.root.find((node) => node.props?.testId === "chat-member-composer").props.stop, undefined, "no live run: back to Send");
  assert.equal(idle.root.findAll(byTestId("chat-composer-stop")).length, 0);
  act(() => idle.unmount());
  const noHandler = renderLiveSession({ onStopRuns: undefined });
  assert.equal(noHandler.root.find((node) => node.props?.testId === "chat-member-composer").props.stop, undefined, "no way to stop: no button");
  act(() => noHandler.unmount());
  // It waits for the User with its run still live: Stop stays, and its state is still named.
  const waiting = renderLiveSession({ status: "waiting" });
  assert.equal(waiting.root.find((node) => node.props?.testId === "chat-member-composer").props.stop?.label, "Stop Task for drew");
  assert.equal(sessionHead(waiting.root).findAll((node) => node.props?.["data-work-status"] === "waiting").length, 1, "only Running is gone from the header");
  act(() => waiting.unmount());
});

function renderSession(extra: Partial<Parameters<typeof ChatMemberSessionPanel>[0]>): ReturnType<typeof create> {
  const messages = sessionsMessages();
  const index = buildSessionsViewIndex(messages, MAIN.id);
  const messageProps = (message: ChatMessage) => ({
    activityDisclosure: disclosure(), message, conversationId: "chat-sessions", participants: PARTICIPANTS, participantStatusById: STATUSES, busy: false,
    onApproveMentions: noop, onRejectMentions: noop, onRespondToChoice: noop, onToggleReaction: noop
  });
  const sharedNode = document.createElement("textarea");
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMemberSessionPanel
          member={{ id: GERA.id }} title="Task for gera" detail="No longer in this chat" readOnly mainSessionId={MAIN.id} status="done"
          runIds={["run-gera"]} messages={memberSessionMessages(messages, GERA.id, index)} messageProps={messageProps} appSettings={SETTINGS}
          conversationId="chat-sessions" draft="" busy={false} hasOlderMessages={false} olderMessagesLoading={false} onLoadOlderMessages={noop}
          onDraftChange={noop} onSend={async () => true} onStopRuns={noop} onBack={noop} onClose={noop}
          {...extra}
        />
      </TooltipProvider>,
      { createNodeMock: () => sharedNode }
    );
  });
  return renderer!;
}

test("a former member's session is read-only: no composer, no Stop, a line saying it left", () => {
  const renderer = renderSession({});
  const root = renderer.root;
  assert.equal(root.findAll((node) => node.props?.testId === "chat-member-composer").length, 0);
  assert.equal(root.findAll(byTestId("chat-member-session-stop")).length, 0);
  assert.match(textOf(root.find(byTestId("chat-member-session-gone"))), /Removed from the chat/);
  assert.deepEqual(root.findAll((node) => node.type === "article").map((article) => article.props["data-message-id"]), ["gera-reply"], "its session stays readable");
  act(() => renderer.unmount());
});

test("a former member's session head keeps the provider logo its task named", () => {
  const renderer = renderSession({ member: { id: GERA.id, kind: "gemini-cli" } });
  const head = renderer.root.find((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.includes("chat-member-session-head"));
  assert.equal(head.findAll((node) => node.props?.["data-provider-kind"] === "gemini-cli").length, 1);
  act(() => renderer.unmount());
});

test("opened at a message, a member's session scrolls to it and marks it for a moment", () => {
  const host = document.createElement("div");
  const target = document.createElement("article");
  target.dataset.messageId = "gera-reply";
  host.append(target);
  let scrolled = false;
  target.scrollIntoView = () => { scrolled = true; };
  const body = { querySelector: (selector: string) => (selector.includes("gera-reply") ? target : null), scrollTop: 0, scrollHeight: 10 };
  const shared = document.createElement("div");
  const messages = sessionsMessages();
  const index = buildSessionsViewIndex(messages, MAIN.id);
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMemberSessionPanel
          member={{ id: GERA.id }} title="Task for gera" detail="" readOnly focus={{ messageId: "gera-reply", nonce: 1 }} mainSessionId={MAIN.id} status="done"
          runIds={[]} messages={memberSessionMessages(messages, GERA.id, index)} messageProps={(message) => ({
            activityDisclosure: disclosure(), message, conversationId: "chat-sessions", participants: PARTICIPANTS, participantStatusById: STATUSES, busy: false,
            onApproveMentions: noop, onRejectMentions: noop, onRespondToChoice: noop, onToggleReaction: noop
          })} appSettings={SETTINGS} conversationId="chat-sessions" draft="" busy={false} hasOlderMessages={false} olderMessagesLoading={false}
          onLoadOlderMessages={noop} onDraftChange={noop} onSend={async () => true} onBack={noop} onClose={noop}
        />
      </TooltipProvider>,
      { createNodeMock: (element) => (typeof element.props?.className === "string" && element.props.className.includes("chat-member-session-body") ? body : shared) }
    );
  });
  assert.equal(scrolled, true, "scrolled to the task's reply");
  assert.ok(target.classList.contains("message-focused"), "marked for a moment");
  act(() => renderer!.unmount());
});

test("the side panel has no title and no main session row, says nothing when empty; a member's session has its settings and its model chip in its composer", () => {
  const messages = sessionsMessages();
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMembersPanel
          rows={sessionsMemberRows(PARTICIPANTS, MAIN.id, STATUSES, latestTaskByMember(messages))}
          activity={sessionsMemberActivity(messages)} runIdsByParticipantId={new Map()} memberTitle={() => "A task"}
          onOpenMember={noop} onClose={noop}
        />
      </TooltipProvider>
    );
  });
  const panel = renderer!.root.find(byTestId("chat-members-panel"));
  assert.equal(panel.findAll((node) => node.type === "h2").length, 0, "no title, only the close button");
  assert.doesNotMatch(textOf(panel), /members?/i, "the sessions view never says members");
  assert.doesNotMatch(textOf(panel), /Main session/, "the main session is not listed: its settings are its composer chip");
  assert.equal(renderer!.root.findAll(byTestId("chat-members-main")).length, 0);
  openProviders(renderer!.root);
  assert.equal(renderer!.root.find(byTestId("chat-members-body")).findAll(byTestId("chat-members-row"))[0]?.props["data-participant-id"], DREW.id, "the delegated sessions first");
  act(() => renderer!.unmount());

  // A new chat's Agents are every ready CLI, with no Add step and no scope
  // switch (the User, 2026-11-26); none ready says so and offers Set up.
  const agentsPanel = (ready: string[]): ReturnType<typeof create> => {
    const agents = ["codex-cli", "claude-code", "gemini-cli"].map((kind) => (ready.includes(kind)
      ? { kind, label: kind, installed: true, detection: "detected", runnable: "ready", authentication: "ready" }
      : { kind, label: kind, installed: false, detection: "not-detected" })) as unknown as AgentHealth[];
    let created: ReturnType<typeof create> | undefined;
    act(() => {
      created = create(
        <TooltipProvider>
          <SubagentProvidersContext.Provider value={{ agents, providers: [], hosts: [], update: async () => true, openSetup: noop }}>
            <ChatMembersPanel rows={{ current: [], previous: [] }} activity={sessionsMemberActivity([])} runIdsByParticipantId={new Map()}
              subagents={{ thread: { entries: [] } }} memberTitle={() => ""} onOpenMember={noop} onClose={noop} />
          </SubagentProvidersContext.Provider>
        </TooltipProvider>
      );
    });
    return created!;
  };
  const listed = agentsPanel(["claude-code", "codex-cli"]);
  assert.deepEqual(listed.root.findAll(byTestId("chat-subagent")).map((row) => row.props["data-provider-kind"]), ["claude-code", "codex-cli"]);
  for (const row of listed.root.findAll(byTestId("chat-subagent"))) {
    const ring = row.find(byTestId("chat-plan-usage"));
    act(() => ring.props.onClick());
    const detail = row.find(byTestId("chat-plan-usage-detail"));
    assert.match(textOf(detail), row.props["data-provider-kind"] === "claude-code" ? /Claude Code usage/ : /Codex usage/);
    assert.equal(row.find(byTestId("chat-subagent-toggle")).props["aria-expanded"], false);
    act(() => ring.props.onClick());
  }
  assert.equal(listed.root.findAll(byTestId("chat-subagent-add")).length, 0, "nothing to add");
  assert.equal(listed.root.findAll(byTestId("chat-subagents-empty")).length, 0);
  act(() => listed.unmount());
  const empty = agentsPanel([]);
  assert.match(textOf(empty.root.find(byTestId("chat-subagents-empty"))), /^No CLI is ready\./);
  act(() => empty.unmount());

  const session = renderSession({ member: DREW, readOnly: false, settings: <span data-testid="drew-settings" />, chip: <span data-testid="drew-chip" /> });
  assert.equal(session.root.findAll(byTestId("drew-settings")).length, 1, "its … menu in its session's header");
  const composer = session.root.find((node) => node.props?.testId === "chat-member-composer");
  assert.equal(composer.props.footerChip.props["data-testid"], "drew-chip", "its controls under its composer");
  act(() => session.unmount());
});

test("a member's settings in the sessions view: separate quiet controls (model, effort, its CLI's permission modes, Codex's Plan mode), each with its own menu; never member rights, auto-watch or a name", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = {
    listProviderModels: async () => ({ kind: "codex-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z",
      models: [{ id: "gpt-5.5", label: "GPT-5.5", recommended: true, source: "cli", description: "Fast and affordable." }, { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli" }] }),
    listMachines: async () => ({ machines: [] })
  };
  const patches: ChatModelAccessPatch[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <ChatMemberComposerControls value={{ ...DREW, agentMode: "default", permissions: { ...defaultChatAgentPermissions(), workspaceWrite: false, cliApprovals: true } }}
            onChange={(patch) => patches.push(patch)} runsOn={{}} />
        </TooltipProvider>
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const root = renderer!.root;
    assert.deepEqual(root.findAll((node) => node.type === "button" && node.props["aria-haspopup"] === "menu").map((node) => node.props["data-testid"]),
      ["chat-plan-usage", "chat-model-model", "chat-model-effort", "chat-model-mode"], "usage and settings each open their own menu");
    assert.equal(root.findAll(byTestId("chat-model-runs-on")).length, 0, "where it runs only once a machine exists");
    assert.equal(textOf(root.find(byTestId("chat-model-mode"))), "Read Only", "the preset it is in, by Codex's name");
    assert.equal(root.findAll(byTestId("chat-model-model-menu")).length, 0, "menus are closed");
    await openMenu(root, "chat-model-model");
    const text = textOf(root);
    assert.doesNotMatch(text, /Request other members|Manage members|Auto-watch|Main session|Provider/, "no rights, no auto-watch, no name; its provider is fixed");
    assert.deepEqual(root.findAll(byTestId("chat-model-option")).map(textOf), ["GPT-5.5Default · Fast and affordable.", "GPT-5.5 mini"], "the CLI's default first, with the vendor's words");
    await act(async () => { root.find(byTestId("chat-model-model")).props.onClick(); });
    await openMenu(root, "chat-model-mode");
    assert.equal(textOf(root.find(byTestId("chat-access-menu")).find((node) => node.props.className === "composer-menu-label")), "Permissions", "Codex's own title");
    const modes = root.findAll(byTestId("chat-access-option"));
    assert.deepEqual(modes.map((row) => textOf(row.find((node) => node.props.className === "composer-menu-item-label"))),
      ["Ask for approval", "Approve for me", "Full Access", "Read Only"], "Codex's /permissions picker, and Read Only while it is its preset");
    assert.match(textOf(modes[2]!), /Exercise caution when using\./, "each with Codex's own description");
    assert.doesNotMatch(textOf(root.find(byTestId("chat-access-menu"))), /Plan/, "Plan mode is not a permission");
    assert.equal(modes[3]!.props["aria-checked"], true, "Read Only now");
    assert.deepEqual(patches, [], "opening a menu saves nothing");
    await act(async () => { modes[0]!.props.onClick(); });
    assert.equal(patches.at(-1)?.agentMode, "default");
    assert.equal(patches.at(-1)?.permissions?.workspaceWrite, true);
    assert.equal(patches.at(-1)?.permissions?.cliApprovals, true, "the CLI runs in its own mode, asking for the rest");
    assert.deepEqual(Object.keys(patches.at(-1)!).sort(), ["agentMode", "permissions"], "only what the choice changes");
    assert.equal(root.findAll(byTestId("chat-model-mode-menu")).length, 0, "a choice closes its menu");
    const plan = root.find(byTestId("chat-model-plan"));
    assert.equal(textOf(plan), "Plan mode");
    assert.equal(plan.props["aria-pressed"], false);
    await act(async () => { plan.props.onClick(); });
    assert.equal(patches.at(-1)?.permissions?.codexPlanMode, true, "Plan mode on top of its preset");
    assert.equal(patches.at(-1)?.permissions?.workspaceWrite, false, "the preset stays (Read Only)");
  } finally {
    if (renderer) act(() => renderer!.unmount());
    host.consensus = previous;
  }
});

test("Claude Code's permission modes by their names, Antigravity's with what it cannot do here; a member the main session made is held to its mode, the higher ones disabled with the reason", async () => {
  const claude = { ...GERA, kind: "claude-code" as const, agentMode: "default" as const, permissions: { ...defaultChatAgentPermissions(), cliApprovals: true as const } };
  const view = await renderPicker(claude, () => undefined);
  try {
    assert.equal(textOf(view.root.find(byTestId("chat-model-mode"))), "Manual", "Claude Code 2.1.330 calls its Default Manual");
    await openMenu(view.root, "chat-model-mode");
    const menu = view.root.find(byTestId("chat-access-menu"));
    assert.equal(textOf(menu.find((node) => node.props.className === "composer-menu-label")), "Permission mode");
    assert.deepEqual(menu.findAll(byTestId("chat-access-option")).map((row) => textOf(row.find((node) => node.props.className === "composer-menu-item-label"))),
      ["Manual", "Accept edits", "Plan", "Auto"]);
    assert.match(textOf(menu), /Always ask before making changes/);
    assert.equal(view.root.findAll(byTestId("chat-model-plan")).length, 0, "Claude Code's Plan is one of its modes");
  } finally {
    view.done();
  }
  const main = { ...MAIN, kind: "claude-code" as const, ...applyChatAccessOptionById("claude-code", "manual", defaultChatAgentPermissions()) } as ChatParticipant;
  const delegated = { ...claude, id: "p-made", delegatedByParticipantId: MAIN.id };
  const held = await renderPicker(delegated, () => undefined, { mainSession: main });
  try {
    await openMenu(held.root, "chat-model-mode");
    const rows = held.root.findAll(byTestId("chat-access-option"));
    const state = rows.map((row) => [row.props["data-value"], row.props.disabled]);
    assert.deepEqual(state, [["manual", false], ["acceptEdits", true], ["plan", false], ["auto", true]], "never above the main session's Manual");
    assert.match(textOf(rows[3]!), /Not above the chat's mode \(Manual\)/, "the reason in its place, naming no main session");
  } finally {
    held.done();
  }
  const agy = await renderPicker({ ...TAYLOR, kind: "gemini-cli" as const, agentMode: "default" as const, permissions: { ...defaultChatAgentPermissions(), cliApprovals: true as const } }, () => undefined, {},
    { listProviderModels: async () => ({ kind: "gemini-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z", models: [{ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", recommended: true, source: "cli" }] }) });
  try {
    await openMenu(agy.root, "chat-model-mode");
    assert.equal(textOf(agy.root.find(byTestId("chat-access-menu")).find((node) => node.props.className === "composer-menu-label")), "Agent Mode");
    assert.match(textOf(agy.root.find(byTestId("chat-access-note"))), /Antigravity cannot ask for approval here/);
    assert.equal(agy.root.findAll(byTestId("chat-model-effort")).length, 0, "agy folds effort into its models");
  } finally {
    agy.done();
  }
});

test("a long model list: the newest of each family first, the rest under More models (open when the chosen one is there)", () => {
  // Claude Code 2.1.330's initialize answer, in its order.
  const claude = ["Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5", "Fable 5.1", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]
    .map((label) => ({ id: label.toLowerCase().replace(/ /g, "-"), label, source: "cli" as const }));
  const [recommended, ...rest] = claude;
  const groups = latestAndOlderModels(rest, [recommended!]);
  assert.deepEqual(groups.latest.map((model) => model.label), ["Fable 5.2", "Sonnet 5.5", "Haiku 5.5"], "Opus is the default row");
  assert.deepEqual(groups.older.map((model) => model.label), ["Fable 5.1", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]);
  assert.equal(modelFamily({ id: "gpt-5.6-luna", label: "GPT-5.6-Luna (gpt-5.6-luna)" }), modelFamily({ id: "gpt-6-luna", label: "GPT-6-Luna" }));
  const codex = [{ id: "a", label: "GPT-5.6-Terra" }, { id: "b", label: "GPT-5.6-Luna" }];
  assert.deepEqual(latestAndOlderModels(codex, [{ id: "c", label: "GPT-6-Luna" }]).older, [], "a short list is not split");
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatModelMenu value={{ ...DREW, kind: "claude-code" }} model="opus-4.8" defaultModel={recommended} defaultLabel="Opus 5.5" models={rest} onSelect={noop} />);
  });
  const rows = renderer!.root.findAll(byTestId("chat-model-option"));
  assert.equal(rows.length, 1 + 3 + 9, "the chosen model is under More models, so it is open");
  assert.equal(rows.find((row) => row.props["data-value"] === "opus-4.8")?.props["aria-checked"], true);
  act(() => renderer!.update(<ChatModelMenu value={{ ...DREW, kind: "claude-code" }} model={undefined} defaultModel={recommended} defaultLabel="Opus 5.5" models={rest} onSelect={noop} />));
  act(() => renderer!.unmount());
  act(() => {
    renderer = create(<ChatModelMenu value={{ ...DREW, kind: "claude-code" }} model={undefined} defaultModel={recommended} defaultLabel="Opus 5.5" models={rest} onSelect={noop} />);
  });
  assert.equal(renderer!.root.findAll(byTestId("chat-model-option")).length, 4, "closed: the default and the newest of each family");
  act(() => renderer!.root.find(byTestId("chat-model-more")).props.onClick());
  assert.equal(renderer!.root.findAll(byTestId("chat-model-option")).length, 13, "More models opens in place");
  act(() => renderer!.unmount());
});

const CODEX_CATALOG = {
  kind: "codex-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z",
  models: [
    { id: "gpt-5.5", label: "GPT-5.5", recommended: true, source: "cli", supportedReasoningEfforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "xhigh", label: "Extra high" }] },
    { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli", supportedReasoningEfforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }] }
  ]
};

async function openMenu(root: ReactTestInstance, testId: string): Promise<void> {
  await act(async () => { root.find(byTestId(testId)).props.onClick(); });
}

async function renderPicker(value: Parameters<typeof ChatMemberComposerControls>[0]["value"], onChange: (patch: ChatModelAccessPatch) => unknown, extra: Record<string, unknown> = {}, bridge: Record<string, unknown> = {}) {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = { listProviderModels: async () => CODEX_CATALOG, listMachines: async () => ({ machines: [] }), ...bridge };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<TooltipProvider><ChatMemberComposerControls value={value} onChange={onChange} runsOn={{}} {...extra} /></TooltipProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root: renderer!.root, done: () => { act(() => renderer!.unmount()); host.consensus = previous; } };
}

/** Mounts into the jsdom document with react-dom: the kit select (Radix)
 *  renders its list in a portal, which react-test-renderer cannot hold. */
async function mountDom(element: ReactElement): Promise<{ host: HTMLElement; done: () => Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await domAct(async () => { root.render(element); await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, done: async () => { await domAct(async () => { root.unmount(); }); host.remove(); } };
}

const byTestIdInDom = <T extends HTMLElement>(id: string): T | null => document.querySelector<T>(`[data-testid="${id}"]`);

/** Opens a kit select and picks the option with this text, as the keyboard
 *  does (Radix opens and selects on Enter). */
async function chooseInDom(trigger: HTMLElement, label: string): Promise<void> {
  await domAct(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await domAct(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) => item.textContent?.trim() === label);
  assert.ok(option, `"${label}" is offered`);
  await domAct(async () => { option.focus(); option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await domAct(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

test("the controls save only an explicit choice: an effort the model lacks reads as Default without a save, and Default really resets", async () => {
  const patches: ChatModelAccessPatch[] = [];
  const view = await renderPicker({ ...DREW, model: "gpt-5.5-mini", reasoningEffort: "xhigh", agentMode: "default", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } },
    (patch) => { patches.push(patch); });
  try {
    assert.equal(textOf(view.root.find(byTestId("chat-model-effort"))), "Default", "xhigh, which mini lacks, reads as the CLI's own");
    await openMenu(view.root, "chat-model-effort");
    const efforts = view.root.findAll(byTestId("chat-effort-option"));
    assert.deepEqual(efforts.map(textOf), ["Default", "Low", "Medium"], "the chosen model's efforts");
    assert.equal(efforts[0]!.props["aria-checked"], true);
    assert.deepEqual(patches, [], "nothing is saved by opening a menu");
    await act(async () => { efforts[0]!.props.onClick(); });
    assert.deepEqual(patches.at(-1), { reasoningEffort: "" }, "Default sends the explicit reset, not undefined (which kept the old effort)");
    await openMenu(view.root, "chat-model-model");
    await act(async () => { view.root.findAll(byTestId("chat-model-option"))[0]!.props.onClick(); });
    assert.deepEqual(patches.at(-1), { model: "" }, "the default model: the explicit reset; its own efforts have xhigh, so the effort stays");
    await openMenu(view.root, "chat-model-model");
    await act(async () => { view.root.findAll(byTestId("chat-model-option"))[1]!.props.onClick(); });
    assert.equal(patches.length, 2, "choosing the model it already has saves nothing");
  } finally {
    view.done();
  }
  const fromDefault: ChatModelAccessPatch[] = [];
  const second = await renderPicker({ ...DREW, reasoningEffort: "xhigh", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } }, (patch) => { fromDefault.push(patch); });
  try {
    await openMenu(second.root, "chat-model-model");
    await act(async () => { second.root.findAll(byTestId("chat-model-option"))[1]!.props.onClick(); });
    assert.deepEqual(fromDefault, [{ model: "gpt-5.5-mini", reasoningEffort: "" }], "a model without the saved effort clears it in the same save");
  } finally {
    second.done();
  }
});

test("access set in the classic controls is not passed off as one of the CLI's modes", async () => {
  const view = await renderPicker({ ...DREW, agentMode: "default", permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true } }, () => undefined);
  try {
    assert.equal(textOf(view.root.find(byTestId("chat-model-mode"))), "Custom");
    assert.equal(view.root.findAll(byTestId("chat-model-plan")).length, 0, "no Plan mode outside the CLI's own mode");
    await openMenu(view.root, "chat-model-mode");
    assert.equal(view.root.findAll(byTestId("chat-access-option")).filter((row) => row.props["aria-checked"]).length, 0, "no mode marked");
    assert.match(textOf(view.root.find(byTestId("chat-access-custom"))), /Custom access/);
  } finally {
    view.done();
  }
});

test("after a CLI mode was chosen in the picker, a classic toggle ends it: what is off is refused again, and the picker says Custom access", async () => {
  const accept = applyChatAccessOptionById("claude-code", "acceptEdits", { ...defaultChatAgentPermissions(), shell: { enabled: true, rules: [] }, webAccess: true });
  const member = { ...TAYLOR, kind: "claude-code", agentMode: accept.agentMode, permissions: accept.permissions } as ChatParticipant;
  const patches: Array<Partial<ChatParticipant>> = [];
  const controls = await mountDom(<TooltipProvider><ParticipantRuntimeControls participant={member} disabled={false} runLocationLocked={false}
    onUpdate={(_id, patch) => { patches.push(patch); }} /></TooltipProvider>);
  try {
    for (const label of ["Run Shell", "Edit Files", "Access Web"]) {
      const chip = [...controls.host.querySelectorAll<HTMLButtonElement>("button.chat-rt-perm-chip")].find((button) => button.textContent?.trim() === label)!;
      assert.ok(chip, `the ${label} chip`);
      await domAct(async () => { chip.click(); });
      const saved = patches.at(-1)!.permissions!;
      assert.equal(saved.cliApprovals, undefined, `${label} off: Claude Code no longer asks and gets approved`);
    }
    assert.equal(patches.at(-1)!.permissions!.webAccess, false);
  } finally {
    await controls.done();
  }
  const view = await renderPicker({ ...member, permissions: patches.at(-1)!.permissions! }, () => undefined);
  try {
    await openMenu(view.root, "chat-model-mode");
    assert.equal(view.root.findAll(byTestId("chat-access-option")).filter((row) => row.props["aria-checked"]).length, 0, "no mode marked");
    assert.match(textOf(view.root.find(byTestId("chat-access-custom"))), /Custom access/);
  } finally {
    view.done();
  }
});

test("Runs on waits for the save: Cloud run prepares its machine only after the save worked, and a move shows its progress until it ends", async () => {
  const prepared: unknown[] = [];
  const bridge = {
    listMachines: async () => ({ machines: [{ id: "m-cloud", name: "Cloud box", awsInstanceId: "i-1" }, { id: "m-mac", name: "Studio" }] }),
    onMachinesUpdated: () => noop,
    onCloudRunPreparationProgress: () => noop,
    getCloudRunPreparation: async () => undefined,
    prepareCloudRun: async (request: unknown) => { prepared.push(request); }
  };
  const answers: Array<(saved: boolean) => void> = [];
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = { listProviderModels: async () => CODEX_CATALOG, ...bridge };
  const view = await mountDom(<TooltipProvider><ChatMemberComposerControls value={{ ...DREW, kind: "claude-code", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } }}
    onChange={() => new Promise<boolean>((resolve) => { answers.push(resolve); })} runsOn={{ moves: true }} /></TooltipProvider>);
  try {
    await domAct(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(byTestIdInDom("chat-model-runs-on")?.textContent, "Local", "once a machine exists, where it runs is a control of its own");
    await domAct(async () => { byTestIdInDom("chat-model-runs-on")!.click(); });
    const select = () => byTestIdInDom<HTMLButtonElement>("participant-run-on")!;
    await chooseInDom(select(), "Cloud box · i-1");
    assert.match(document.body.textContent ?? "", /Moving to Cloud box with its session/, "the move is shown while it is saved, naming nobody");
    assert.equal(select().disabled, true, "no second move meanwhile");
    await domAct(async () => { answers[0]!(false); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(prepared, [], "a failed save prepares nothing");
    assert.doesNotMatch(document.body.textContent ?? "", /Moving/);
    await chooseInDom(select(), "Cloud box · i-1");
    await domAct(async () => { answers[1]!(true); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(prepared.length, 1, "prepared once the save worked");
  } finally {
    await view.done();
    host.consensus = previous;
  }
});

test("a member's … menu restarts it as the classic roster does: idle only, never Antigravity, naming the background work it stops", () => {
  const restarts: Array<[string, boolean]> = [];
  const stops: string[] = [];
  let closed = 0;
  const base = { participant: { id: "p-1", kind: "claude-code" as const }, backgroundTaskCount: 0, onRestart: (id: string, stop: boolean) => { restarts.push([id, stop]); },
    onStopRestart: (runId: string) => { stops.push(runId); }, close: () => { closed += 1; } };
  const idle = memberSettingsActions({ ...base, status: "idle", onRemove: noop });
  assert.deepEqual(idle.map((action) => action.label), ["Restart", "Remove from chat"], "Restart next to Remove from chat");
  assert.match(idle[0]!.detail ?? "", /connectors/);
  idle[0]!.onSelect();
  assert.deepEqual(restarts, [["p-1", false]]);
  assert.equal(closed, 1);
  const busy = memberSettingsActions({ ...base, status: "running" });
  assert.equal(busy[0]!.disabled, true, "not while it works");
  const tasks = memberSettingsActions({ ...base, status: "background", backgroundTaskCount: 2 });
  assert.equal(tasks[0]!.label, "Restart (stops 2 background tasks)", "said before it is chosen");
  tasks[0]!.onSelect();
  assert.deepEqual(restarts.at(-1), ["p-1", true]);
  assert.deepEqual(memberSettingsActions({ ...base, participant: { id: "p-2", kind: "gemini-cli" }, status: "idle" }), [], "Antigravity starts a process per message: nothing to restart");
  const waiting = memberSettingsActions({ ...base, status: "idle", restartStatus: { runId: "r-9", message: "Waiting for machine Box", waiting: true } });
  assert.equal(waiting[0]!.label, "Stop restarting");
  waiting[0]!.onSelect();
  assert.deepEqual(stops, ["r-9"]);
  assert.equal(memberSettingsActions({ ...base, status: "idle", restartStatus: { runId: "r-9", message: "Restarting", waiting: false } })[0]!.disabled, true);
});

test("a member's settings send only what was chosen, so a second quick choice never sends the first one back as it was", () => {
  assert.deepEqual(runtimePatchFields({ reasoningEffort: "low" }), { reasoningEffort: "low" });
  assert.deepEqual(runtimePatchFields({ model: "" }), { model: "" }, "the reset goes as it is");
  const reset = runtimePatchFields({ reasoningEffort: undefined, homeMachineId: undefined });
  assert.deepEqual(Object.keys(reset).sort(), ["homeMachineId", "reasoningEffort"], "a key given without a value is a reset, and is sent");
  assert.equal(Object.prototype.hasOwnProperty.call(runtimePatchFields({ model: "x" }), "permissions"), false);
});

// --- Fork to new chat (src/shared/forkToNewChat.ts) ------------------------------

test("Fork to new chat sits in a member's … menu (the main session's in the chat title's menu), disabled with its reason when it cannot be made", () => {
  const forked: string[] = [];
  let closed = 0;
  const base = { participant: { id: DREW.id, kind: DREW.kind }, backgroundTaskCount: 0, status: "idle" as const, onRestart: noop,
    onForkToNewChat: () => { forked.push(DREW.id); }, close: () => { closed += 1; } };
  const offered = memberSettingsActions({ ...base, onRemove: noop });
  assert.deepEqual(offered.map((action) => action.label), ["Restart", FORK_TO_NEW_CHAT_LABEL, "Remove from chat"]);
  const fork = offered[1]!;
  assert.equal(fork.disabled, false);
  assert.equal(fork.detail, "A new chat that starts from a copy of this session", "what it makes, under it, naming no main session");
  fork.onSelect();
  assert.deepEqual(forked, [DREW.id]);
  assert.equal(closed, 1, "the settings close: the new chat opens");
  // The main session's actions (the chat title's menu): no Remove, still Fork.
  assert.deepEqual(memberSettingsActions({ ...base, participant: { id: MAIN.id, kind: MAIN.kind } }).map((action) => action.label), ["Restart", FORK_TO_NEW_CHAT_LABEL]);
  // Antigravity: nothing to restart, and the fork disabled with why.
  const agy = memberSettingsActions({ ...base, participant: { id: TAYLOR.id, kind: TAYLOR.kind }, forkToNewChatDisabledReason: "Antigravity has no session fork." });
  assert.equal(agy.length, 1);
  assert.equal(agy[0]!.label, FORK_TO_NEW_CHAT_LABEL);
  assert.equal(agy[0]!.disabled, true);
  assert.equal(agy[0]!.detail, "Antigravity has no session fork.", "the reason in its place");
  assert.deepEqual(memberSettingsActions({ ...base, onForkToNewChat: undefined }).map((action) => action.label), ["Restart"], "only where it is wired");
});

test("the classic roster card has Fork to new chat next to Restart, disabled with its reason", () => {
  const forked: string[] = [];
  const card = (reason: string | undefined) => (
    <TooltipProvider>
      <ChatParticipantRosterRow
        participant={DREW} removeDisabledReason={undefined} busy={false} status="idle" runLocationLocked={false}
        renderParticipantAvatar={() => null} participantRoleLabel={() => "Member"} participantRoleArchived={() => false}
        onInsertMention={noop} onJumpToLastMessage={noop} onUpdateParticipantRuntime={noop}
        onCompactParticipant={noop} onRestartParticipant={async () => true} onStopRestart={noop} onRemoveParticipant={noop}
        onForkToNewChat={(id) => forked.push(id)} forkToNewChatDisabledReason={reason}
      />
    </TooltipProvider>
  );
  let renderer: ReturnType<typeof create> | undefined;
  act(() => { renderer = create(card(undefined)); });
  const button = () => renderer!.root.find((node) => node.type === "button" && node.props["data-testid"] === "chat-participant-fork");
  assert.match(String(button().props["aria-label"]), /^Fork to new chat: /);
  assert.equal(button().props.disabled, false);
  assert.equal(FORK_TO_NEW_CHAT_DETAIL, "A new chat that starts from a copy of this session");
  assert.ok(renderer!.root.findAll((node) => typeof node.props?.children === "string" && node.props.children === `Fork to new chat. ${FORK_TO_NEW_CHAT_DETAIL}.`).length > 0,
    "the classic view says what it makes in the same words, naming no main session");
  act(() => button().props.onClick(click));
  assert.deepEqual(forked, [DREW.id]);
  act(() => renderer!.update(card("It has not run yet, so it has no session to copy.")));
  assert.equal(button().props.disabled, true);
  assert.ok(renderer!.root.findAll((node) => typeof node.props?.children === "string" && node.props.children === "Fork to new chat. It has not run yet, so it has no session to copy.").length > 0,
    "its tooltip says why");
  act(() => renderer!.unmount());
});

test("the menus' reasons come from the chat as the desktop has it: its session, its machine's program, its CLI here", () => {
  const conversation = (metadata: Record<string, unknown>) => ({ metadata, messages: [] }) as unknown as Conversation;
  const ran = conversation({ participantSessions: [{ participantId: DREW.id, sessionId: "s-1" }] });
  const settings = { providers: [], cliProviderHosts: [] };
  assert.equal(forkToNewChatReasonFor(DREW, ran, [], settings, new Map()), undefined);
  assert.match(String(forkToNewChatReasonFor(DREW, conversation({ participantSessions: [] }), [], settings, new Map())), /has not run yet/);
  assert.match(String(forkToNewChatReasonFor(TAYLOR, ran, [], settings, new Map())), /Antigravity/);
  assert.match(String(forkToNewChatReasonFor(DREW, ran, [{ kind: "codex-cli", label: "Codex CLI", installed: false }], settings, new Map())), /Codex/,
    "its CLI not ready here");
  const boxed = { ...DREW, homeMachineId: "m-1" };
  const answered = conversation({ lastMessageByParticipant: { [DREW.id]: { messageId: "r", sequence: 1 } } });
  const support = machineForkSupportFrom({
    machines: [{ id: "m-1", name: "Box", deviceId: "d", pairingKey: "k", createdAt: "t" }, { id: "m-2", name: "Old", deviceId: "d2", pairingKey: "k2", createdAt: "t" }],
    status: [
      { machineId: "m-1", name: "Box", connected: true, lastHello: { forkToNewChatSupported: true } as never },
      { machineId: "m-2", name: "Old", connected: false, lastHello: { sessionMoveSupported: true } as never }
    ]
  });
  assert.equal(forkToNewChatReasonFor(boxed, answered, [{ kind: "codex-cli", label: "Codex CLI", installed: false }], settings, support), undefined,
    "a machine's member runs on that machine's CLI");
  assert.match(String(forkToNewChatReasonFor({ ...boxed, homeMachineId: "m-2" }, answered, [], settings, support)), /older program/);
  assert.match(String(forkToNewChatReasonFor({ ...boxed, homeMachineId: "m-3" }, answered, [], settings, support)), /has not connected/);
});
