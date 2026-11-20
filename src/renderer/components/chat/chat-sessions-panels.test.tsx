import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { buildSessionsViewIndex, memberSessionMessages } from "../../../shared/mainSession";
import { latestTaskByMember, sessionsMemberActivity, sessionsMemberRows, sessionsMemberTitle } from "../../../shared/mainSessionView";
import type { AppSettings, ChatMessage } from "../../../shared/types";
import { ChatMembersPanel } from "./chat-members-panel";
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
          formerRows={[{ member: { id: "p-gone", handle: "gone" }, title: "Old task", status: "done" }]}
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
  assert.match(textOf(root.find(byTestId("chat-member-session-gone"))), /no longer in the chat/);
  assert.deepEqual(root.findAll((node) => node.type === "article").map((article) => article.props["data-message-id"]), ["gera-reply"], "its session stays readable");
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

test("the side panel lists the main session first with its settings; a member's session has its settings and its model chip in its composer", () => {
  const messages = sessionsMessages();
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatMembersPanel
          main={{ participant: MAIN, detail: "Claude Code · opus", settings: <span data-testid="main-settings" /> }}
          rows={sessionsMemberRows(PARTICIPANTS, MAIN.id, STATUSES, latestTaskByMember(messages))}
          activity={sessionsMemberActivity(messages)} runIdsByParticipantId={new Map()} memberTitle={() => "A task"} memberDetail={() => ""}
          onOpenMember={noop} onClose={noop}
        />
      </TooltipProvider>
    );
  });
  const main = renderer!.root.find(byTestId("chat-members-main"));
  assert.match(textOf(main), /Main session/);
  assert.match(textOf(main), /Claude Code · opus/);
  assert.equal(main.findAll(byTestId("main-settings")).length, 1, "its settings are reachable from the side panel");
  assert.equal(renderer!.root.find(byTestId("chat-members-body")).findAll(byTestId("chat-members-row"))[0]?.props["data-participant-id"], DREW.id, "then the members");
  act(() => renderer!.unmount());

  const session = renderSession({ member: DREW, readOnly: false, settings: <span data-testid="drew-settings" />, chip: <span data-testid="drew-chip" /> });
  assert.equal(session.root.findAll(byTestId("drew-settings")).length, 1, "a gear in its session's header");
  const composer = session.root.find((node) => node.props?.testId === "chat-member-composer");
  assert.equal(composer.props.footerChip.props["data-testid"], "drew-chip", "its model chip in its composer");
  act(() => session.unmount());
});
