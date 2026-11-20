import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { buildSessionsViewIndex, memberSessionMessages } from "../../../shared/mainSession";
import { latestTaskByMember, sessionsMemberRows } from "../../../shared/mainSessionView";
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
          messages={messages}
          runIdsByParticipantId={new Map([[DREW.id, ["run-drew"]]])}
          roleLabel={() => "Generic Member"}
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
  assert.match(textOf(drew), /@drew/);
  assert.match(textOf(drew), /Task for drew: fix the drew part/);
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
        <ChatMembersPanel rows={rows} messages={messages} runIdsByParticipantId={new Map()} roleLabel={() => ""} onOpenMember={noop} onClose={noop} />
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
          participant={DREW}
          mainSessionId={MAIN.id}
          status="running"
          runIds={["run-drew"]}
          messages={session}
          allMessages={messages}
          messageProps={messageProps}
          participants={PARTICIPANTS}
          settings={SETTINGS}
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
  assert.equal(composer.props.placeholder, "Message @drew...");
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
