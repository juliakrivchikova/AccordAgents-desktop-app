import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { buildSessionsViewIndex, memberSessionMessages } from "../../../shared/mainSession";
import { latestTaskByMember, sessionsMemberActivity, sessionsMemberRows, sessionsMemberTitle } from "../../../shared/mainSessionView";
import type { AppSettings, ChatMessage, Conversation } from "../../../shared/types";
import { FORK_TO_NEW_CHAT_DETAIL, FORK_TO_NEW_CHAT_LABEL } from "../../../shared/forkToNewChat";
import { ChatParticipantRosterRow } from "./chat-participant-roster-row";
import { forkToNewChatReasonFor, machineForkSupportFrom } from "./use-fork-to-new-chat";
import { ChatMembersPanel } from "./chat-members-panel";
import { ChatModelAccessPanel, type ChatModelAccessPatch } from "./chat-model-access-picker";
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

const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);
const SETTINGS = { chatRoleConfigs: [], chatSavedPrompts: [], chatParticipantConfigs: [], cliProviderHosts: [] } as unknown as AppSettings;

// jsdom gives the composer a document; the bridge answers nothing, and its
// subscriptions (onSomething) hand back a way to stop listening.
(globalThis as { window?: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { consensus: unknown }).consensus = new Proxy({}, {
  get: (_target, name) => (String(name).startsWith("on") ? () => noop : async () => undefined)
});

test("the members panel lists every member but the main session, ended ones under Previous, each with its state, task and Stop", () => {
  const messages = sessionsMessages();
  const rows = sessionsMemberRows(PARTICIPANTS, MAIN.id, STATUSES, latestTaskByMember(messages));
  const stopped: Array<readonly string[]> = [];
  const opened: string[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMembersPanel
          rows={rows}
          formerRows={[{ member: { id: "p-gone", handle: "gone", kind: "gemini-cli" }, title: "Old task", status: "done" }]}
          activity={sessionsMemberActivity(messages)}
          runIdsByParticipantId={new Map([[DREW.id, ["run-drew"]]])}
          memberTitle={(id) => sessionsMemberTitle(PARTICIPANTS.find((member) => member.id === id), latestTaskByMember(messages).get(id)?.item)}
          memberDetail={(member) => member.kind === "codex-cli" ? "Codex CLI · gpt-5" : "Claude Code"}
          onOpenMember={(id) => opened.push(id)}
          onStopRuns={(runIds) => stopped.push(runIds)}
          onClose={noop}
        />
      </TooltipProvider>
    );
  });
  const root = renderer!.root;
  const memberRows = () => root.findAll(byTestId("chat-members-row"));
  assert.deepEqual(memberRows().map((row) => [row.props["data-participant-id"], row.props["data-member-status"]]), [[DREW.id, "running"], [TAYLOR.id, "waiting"]],
    "the main session is not listed; gera's task is done, so it waits under Previous");
  const drew = memberRows()[0]!;
  assert.equal(textOf(drew.find((node) => node.type === "strong")), "Task for drew: fix the drew part", "named by its task");
  assert.match(textOf(drew), /Codex CLI · gpt-5/, "its provider and model under it");
  assert.doesNotMatch(textOf(root), /@/, "no handles");
  assert.equal(drew.findAll((node) => node.props?.["data-provider-kind"] === DREW.kind).length, 1, "its provider's logo");
  assert.match(textOf(drew), /Running/);
  assert.equal(drew.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.includes("chat-members-row-elapsed")).length, 1);
  assert.equal(memberRows()[1]!.findAll(byTestId("chat-members-row-stop")).length, 0, "nothing to stop for a member that runs nothing");

  act(() => drew.findAll(byTestId("chat-members-row-stop"))[0]!.props.onClick(click));
  act(() => root.findAll(byTestId("chat-members-stop-all"))[0]!.props.onClick(click));
  assert.deepEqual(stopped, [["run-drew"], ["run-drew"]]);

  act(() => drew.findAll((node) => node.type === "button" && node.props.className === "chat-members-row-main")[0]!.props.onClick());
  assert.deepEqual(opened, [DREW.id]);

  const previous = root.find(byTestId("chat-members-previous"));
  assert.match(textOf(previous), /Previous1/);
  act(() => previous.findAll((node) => node.type === "button")[0]!.props.onClick());
  assert.deepEqual(memberRows().map((row) => row.props["data-participant-id"]), [DREW.id, TAYLOR.id, GERA.id]);
  assert.match(textOf(memberRows()[2]!), /Done/);

  const removed = root.find(byTestId("chat-members-removed"));
  assert.match(textOf(removed), /Removed1/, "a member no longer in the chat, folded");
  act(() => removed.findAll((node) => node.type === "button")[0]!.props.onClick());
  const gone = memberRows().find((row) => row.props["data-participant-id"] === "p-gone")!;
  assert.match(textOf(gone), /Old task/);
  assert.match(textOf(gone), /Removed from the chat/, "the same words as the phone");
  assert.equal(gone.findAll((node) => node.props?.["data-provider-kind"] === "gemini-cli").length, 1, "it keeps the logo its task named");
  assert.equal(gone.findAll(byTestId("chat-members-row-stop")).length, 0, "read-only: no Stop");
  act(() => gone.findAll((node) => node.type === "button" && node.props.className === "chat-members-row-main")[0]!.props.onClick());
  assert.deepEqual(opened, [DREW.id, "p-gone"], "its session opens");
  act(() => renderer!.unmount());
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
        <ChatMembersPanel rows={rows} activity={sessionsMemberActivity(messages)} runIdsByParticipantId={new Map()} memberTitle={() => "A task"} memberDetail={() => ""} onOpenMember={noop} onClose={noop} />
      </TooltipProvider>
    );
  });
  const root = renderer!.root;
  assert.equal(root.findAll(byTestId("chat-members-previous")).length, 0);
  assert.deepEqual(root.findAll(byTestId("chat-members-row")).map((row) => [row.props["data-participant-id"], row.props["data-member-status"]]),
    [[DREW.id, "done"], [GERA.id, "done"], [TAYLOR.id, "idle"]],
    "the finished ones listed directly, in the chat's order, with the one that never had a task");
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
  assert.match(textOf(fold), /Task from the main session/);
  assert.match(textOf(fold), /Task for drew: fix the drew part/);
  assert.doesNotMatch(textOf(fold), /with every detail/, "folded to its first line");
  act(() => fold.findAll((node) => node.type === "button")[0]!.props.onClick());
  assert.match(textOf(root.find(byTestId("chat-member-task"))), /with every detail/, "opens to the whole task");

  const articles = root.findAll((node) => node.type === "article");
  assert.deepEqual(articles.map((article) => article.props["data-message-id"]), ["drew-question", "main-answer", "to-drew", "drew-running"]);
  assert.ok(articles.every((article) => article.props["data-presentation"] === "sessions"));
  assert.equal(root.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(" ").includes("message-avatar")).length, 0);
  assert.match(textOf(articles[1]!), /Main session/, "the main session's answer says who wrote it");

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
          activity={sessionsMemberActivity(messages)} runIdsByParticipantId={new Map()} memberTitle={() => "A task"} memberDetail={() => ""}
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
  assert.equal(renderer!.root.find(byTestId("chat-members-body")).findAll(byTestId("chat-members-row"))[0]?.props["data-participant-id"], DREW.id, "the delegated sessions first");
  act(() => renderer!.unmount());

  let empty: ReturnType<typeof create> | undefined;
  act(() => {
    empty = create(
      <TooltipProvider>
        <ChatMembersPanel rows={{ current: [], previous: [] }} activity={sessionsMemberActivity([])} runIdsByParticipantId={new Map()}
          memberTitle={() => ""} memberDetail={() => ""} onOpenMember={noop} onClose={noop} />
      </TooltipProvider>
    );
  });
  assert.equal(textOf(empty!.root.find(byTestId("chat-members-body"))), "", "nothing is said when nothing was delegated");
  act(() => empty!.unmount());

  const session = renderSession({ member: DREW, readOnly: false, settings: <span data-testid="drew-settings" />, chip: <span data-testid="drew-chip" /> });
  assert.equal(session.root.findAll(byTestId("drew-settings")).length, 1, "a gear in its session's header");
  const composer = session.root.find((node) => node.props?.testId === "chat-member-composer");
  assert.equal(composer.props.footerChip.props["data-testid"], "drew-chip", "its model chip in its composer");
  act(() => session.unmount());
});

test("a member's settings in the sessions view: its model, effort, access in its CLI's terms and Remove from chat behind …; never member rights, auto-watch or a name", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  host.consensus = {
    listProviderModels: async () => ({ kind: "codex-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z",
      models: [{ id: "gpt-5.5", label: "GPT-5.5", recommended: true, source: "cli" }, { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli" }] }),
    listMachines: async () => ({ machines: [] })
  };
  const patches: ChatModelAccessPatch[] = [];
  let removed = 0;
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <ChatModelAccessPanel value={{ ...DREW, agentMode: "default", permissions: { ...defaultChatAgentPermissions(), workspaceWrite: false, cliApprovals: true } }}
            onChange={(patch) => patches.push(patch)} runsOn={{}} actions={[{ label: "Remove from chat", tone: "danger", onSelect: () => { removed += 1; } }]} />
        </TooltipProvider>
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const root = renderer!.root;
    const text = textOf(root);
    assert.doesNotMatch(text, /Request other members|Manage members|Auto-watch|Main session|Provider/, "no rights, no auto-watch, no name; its provider is fixed");
    assert.doesNotMatch(text, /Runs on/, "where it runs only once a machine exists");
    assert.deepEqual(root.findAll(byTestId("chat-model-access-model")).map(textOf), ["GPT-5.5Default", "GPT-5.5 mini"]);
    const modes = root.findAll(byTestId("chat-model-access-mode"));
    assert.deepEqual(modes.map((row) => textOf(row.findAll((node) => node.props.className === "chat-model-access-row-label")[0]!)),
      ["Read only", "Default", "Auto-review", "Plan mode"], "Codex's own presets (Read Only, Default) and its Auto-review and Plan mode");
    assert.match(textOf(modes[1]!), /asks to go outside it or online/, "each says what Codex does in it");
    assert.equal(modes[0]!.props["aria-checked"], true, "read-only now");
    assert.deepEqual(patches, [], "opening it saves nothing");
    await act(async () => { modes[1]!.props.onClick(); });
    assert.equal(patches.at(-1)?.agentMode, "default");
    assert.equal(patches.at(-1)?.permissions?.workspaceWrite, true);
    assert.equal(patches.at(-1)?.permissions?.cliApprovals, true, "the CLI runs in its own mode, asking for the rest");
    assert.deepEqual(Object.keys(patches.at(-1)!).sort(), ["agentMode", "permissions"], "only what the choice changes");
    assert.equal(root.findAll(byTestId("chat-model-access-action")).length, 0, "Remove from chat sits behind …");
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "More").props.onClick(); });
    const remove = root.find(byTestId("chat-model-access-action"));
    assert.equal(textOf(remove), "Remove from chat");
    await act(async () => { remove.props.onClick(); });
    assert.equal(removed, 1);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    host.consensus = previous;
  }
});

const CODEX_CATALOG = {
  kind: "codex-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z",
  models: [
    { id: "gpt-5.5", label: "GPT-5.5", recommended: true, source: "cli", supportedReasoningEfforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "xhigh", label: "Extra high" }] },
    { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli", supportedReasoningEfforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }] }
  ]
};

async function renderPicker(value: Parameters<typeof ChatModelAccessPanel>[0]["value"], onChange: (patch: ChatModelAccessPatch) => unknown, extra: Record<string, unknown> = {}, bridge: Record<string, unknown> = {}) {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  host.consensus = { listProviderModels: async () => CODEX_CATALOG, listMachines: async () => ({ machines: [] }), ...bridge };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<TooltipProvider><ChatModelAccessPanel value={value} onChange={onChange} runsOn={{}} {...extra} /></TooltipProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root: renderer!.root, done: () => { act(() => renderer!.unmount()); host.consensus = previous; } };
}

test("the picker saves only an explicit choice: an effort the model lacks reads as Default without a save, and Default really resets", async () => {
  const patches: ChatModelAccessPatch[] = [];
  const view = await renderPicker({ ...DREW, model: "gpt-5.5-mini", reasoningEffort: "xhigh", agentMode: "default", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } },
    (patch) => { patches.push(patch); });
  try {
    const efforts = view.root.findAll(byTestId("chat-model-access-effort"));
    assert.deepEqual(efforts.map(textOf), ["Default", "Low", "Medium"], "the chosen model's efforts");
    assert.equal(efforts[0]!.props["aria-checked"], true, "xhigh, which mini lacks, reads as the CLI's own");
    assert.deepEqual(patches, [], "nothing is saved by opening the picker (it used to save in a loop)");
    await act(async () => { efforts[0]!.props.onClick(); });
    assert.deepEqual(patches.at(-1), { reasoningEffort: "" }, "Default sends the explicit reset, not undefined (which kept the old effort)");
    const models = view.root.findAll(byTestId("chat-model-access-model"));
    await act(async () => { models[0]!.props.onClick(); });
    assert.deepEqual(patches.at(-1), { model: "" }, "the default model: the explicit reset; its own efforts have xhigh, so the effort stays");
    await act(async () => { models[1]!.props.onClick(); });
    assert.equal(patches.length, 2, "choosing the model it already has saves nothing");
  } finally {
    view.done();
  }
  const fromDefault: ChatModelAccessPatch[] = [];
  const second = await renderPicker({ ...DREW, reasoningEffort: "xhigh", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } }, (patch) => { fromDefault.push(patch); });
  try {
    await act(async () => { second.root.findAll(byTestId("chat-model-access-model"))[1]!.props.onClick(); });
    assert.deepEqual(fromDefault, [{ model: "gpt-5.5-mini", reasoningEffort: "" }], "a model without the saved effort clears it in the same save");
  } finally {
    second.done();
  }
});

test("access set in the classic controls is not passed off as one of the CLI's modes", async () => {
  const view = await renderPicker({ ...DREW, agentMode: "default", permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true } }, () => undefined);
  try {
    assert.equal(view.root.findAll(byTestId("chat-model-access-mode")).filter((row) => row.props["aria-checked"]).length, 0, "no mode marked");
    assert.match(textOf(view.root.find(byTestId("chat-model-access-custom"))), /Custom access/);
  } finally {
    view.done();
  }
});

test("after a CLI mode was chosen in the picker, a classic toggle ends it: what is off is refused again, and the picker says Custom access", async () => {
  const accept = applyChatAccessOptionById("claude-code", "acceptEdits", { ...defaultChatAgentPermissions(), shell: { enabled: true, rules: [] }, webAccess: true });
  const member = { ...TAYLOR, kind: "claude-code", agentMode: accept.agentMode, permissions: accept.permissions } as ChatParticipant;
  const patches: Array<Partial<ChatParticipant>> = [];
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<TooltipProvider><ParticipantRuntimeControls participant={member} disabled={false} runLocationLocked={false}
      onUpdate={(_id, patch) => { patches.push(patch); }} /></TooltipProvider>);
  });
  try {
    for (const label of ["Run Shell", "Edit Files", "Access Web"]) {
      const chip = renderer!.root.findAll((node) => node.type === "button" && typeof node.props.className === "string" &&
        node.props.className.includes("chat-rt-perm-chip") && textOf(node) === label)[0]!;
      act(() => chip.props.onClick());
      const saved = patches.at(-1)!.permissions!;
      assert.equal(saved.cliApprovals, undefined, `${label} off: Claude Code no longer asks and gets approved`);
    }
    assert.equal(patches.at(-1)!.permissions!.webAccess, false);
  } finally {
    act(() => renderer!.unmount());
  }
  const view = await renderPicker({ ...member, permissions: patches.at(-1)!.permissions! }, () => undefined);
  try {
    assert.equal(view.root.findAll(byTestId("chat-model-access-mode")).filter((row) => row.props["aria-checked"]).length, 0, "no mode marked");
    assert.match(textOf(view.root.find(byTestId("chat-model-access-custom"))), /Custom access/);
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
  const view = await renderPicker({ ...DREW, kind: "claude-code", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } },
    () => new Promise<boolean>((resolve) => { answers.push(resolve); }), { runsOn: { moves: true } }, bridge);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const select = () => view.root.find((node) => node.type === "select" && node.props["aria-label"] === "Run on");
    await act(async () => { select().props.onChange({ currentTarget: { value: "machine:m-cloud" } }); });
    assert.match(textOf(view.root), /Moving to Cloud box with its session/, "the move is shown while it is saved, naming nobody");
    assert.equal(select().props.disabled, true, "no second move meanwhile");
    await act(async () => { answers[0]!(false); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(prepared, [], "a failed save prepares nothing");
    assert.doesNotMatch(textOf(view.root), /Moving/);
    await act(async () => { select().props.onChange({ currentTarget: { value: "machine:m-cloud" } }); });
    await act(async () => { answers[1]!(true); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(prepared.length, 1, "prepared once the save worked");
  } finally {
    view.done();
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

test("Fork to new chat sits in a member's … menu (the main session's chip too), disabled with its reason when it cannot be made", () => {
  const forked: string[] = [];
  let closed = 0;
  const base = { participant: { id: DREW.id, kind: DREW.kind }, backgroundTaskCount: 0, status: "idle" as const, onRestart: noop,
    onForkToNewChat: () => { forked.push(DREW.id); }, close: () => { closed += 1; } };
  const offered = memberSettingsActions({ ...base, onRemove: noop });
  assert.deepEqual(offered.map((action) => action.label), ["Restart", FORK_TO_NEW_CHAT_LABEL, "Remove from chat"]);
  const fork = offered[1]!;
  assert.equal(fork.disabled, false);
  assert.equal(fork.detail, FORK_TO_NEW_CHAT_DETAIL, "what it makes, under it");
  fork.onSelect();
  assert.deepEqual(forked, [DREW.id]);
  assert.equal(closed, 1, "the settings close: the new chat opens");
  // The main session's chip: no Remove, still Fork.
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
