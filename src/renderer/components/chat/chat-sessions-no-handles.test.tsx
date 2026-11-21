// The sessions view names nobody by handle (the User, 2026-11-21: "and so
// that I never see this crap '@main' anywhere in the UI"). This walks what the
// app itself writes in such a chat — notices, failed replies, cards, the
// status line, Activity rows — and checks that no handle is left, while the
// classic view keeps every word exactly as before.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { buildChatActivityItems } from "../../../shared/chatActivity";
import { sessionsViewNamesOf, sessionsViewText } from "../../../shared/sessionsViewText";
import type { ChatAppToolApproval, ChatMessage, Conversation } from "../../../shared/types";
import { warningNoticeEntries } from "../../app/warnings";
import { RunStatusLine } from "../conversation/timeline-primitives";
import { ChatAccordLaunchCard } from "./chat-accord-launch-card";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";
import { ChatArtifactNoteCard } from "./chat-artifact-note-card";
import { ChatChoiceCard } from "./chat-choice-card";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import { ChatSessionsLinksContext, type ChatSessionsLinks } from "./chat-sessions-links";
import { DREW, MAIN, PARTICIPANTS, chatMessage, disclosure, sessionsConversation } from "./chat-sessions-fixtures.test";

const HANDLES = /(^|[^A-Za-z0-9_@./-])@(main|drew|gera|taylor)\b/i;
const AT = "2026-11-20T10:30:00.000Z";

// A member card asks the computer for its provider's models.
const host = window as unknown as { consensus?: unknown };
host.consensus = {
  listProviderModels: async (kind: string) => ({ kind, authoritative: true, fetchedAt: AT, models: [] }),
  listMachines: async () => ({ machines: [] })
};

const LINKS: ChatSessionsLinks = {
  mainSessionId: MAIN.id,
  mainHandle: "main",
  byHandle: new Map([
    ["drew", { id: DREW.id, title: "Fix the logout", kind: DREW.kind }],
    ["gera", { id: "p-gera", title: "Check the docs", kind: "claude-code" }],
    ["taylor", { id: "p-taylor", title: "Pick a color", kind: "gemini-cli" }]
  ]),
  openMember: () => undefined
};

/** Everything a node shows or says: its text and its tooltips, labels and
 *  placeholders. */
function shownText(root: ReactTestInstance): string {
  const labels: string[] = [];
  const textOf = (node: ReactTestInstance | string): string => {
    if (typeof node === "string") return node;
    for (const key of ["title", "aria-label", "placeholder"]) {
      if (typeof node.props[key] === "string") labels.push(node.props[key]);
    }
    return node.children.map(textOf).join("");
  };
  return [textOf(root), ...labels].join("\n");
}

function render(sessions: boolean, element: ReactElement): { text: string; unmount: () => void } {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsPresentationContext.Provider value={sessions}>
          <ChatSessionsLinksContext.Provider value={sessions ? LINKS : undefined}>{element}</ChatSessionsLinksContext.Provider>
        </ChatSessionsPresentationContext.Provider>
      </TooltipProvider>
    );
  });
  return { text: shownText(renderer!.root), unmount: () => act(() => renderer!.unmount()) };
}

function approval(requester: typeof MAIN, patch: Partial<ChatAppToolApproval>): ChatAppToolApproval {
  return {
    id: `a-${requester.handle}-${patch.toolName}-${patch.status ?? "pending"}`, conversationId: "chat-sessions", requesterParticipantId: requester.id,
    requesterHandle: requester.handle, requesterRoleConfigId: requester.roleConfigId, capability: "permissions.request", status: "pending",
    summary: "", request: {}, createdAt: AT, updatedAt: AT, ...patch
  } as ChatAppToolApproval;
}

/** The cards a member or the main session raises, pending and used. */
function cards(requester: typeof MAIN): ChatAppToolApproval[] {
  const removal = { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: "p-gera", handle: "gera" }] } as never;
  return [
    approval(requester, { toolName: "app_tool_permission", summary: "Use Bash", request: { kind: "toolPermission", agentMode: "default", toolName: "Bash", toolInput: { command: "ls" } } as never }),
    approval(requester, { toolName: "app_tool_permission", summary: "Use WebFetch", request: { kind: "toolPermission", agentMode: "default", toolName: "WebFetch", toolInput: { url: "https://a.example/" }, chatScope: { kind: "domain", domain: "a.example" } } as never }),
    approval(requester, { toolName: "codex_auto_review_approval", summary: "Run git push", request: {
      kind: "codexApproval", method: "item/commandExecution/requestApproval", requestId: "r1", threadId: "t", turnId: "u", itemId: "i", action: "command",
      options: [{ id: "accept", label: "Allow once", outcome: "approve" }, { id: "decline", label: "Deny", outcome: "deny" }]
    } as never }),
    approval(requester, { toolName: "app_connector_sign_in", summary: `@${requester.handle} needs you to sign in to claude.ai Gmail`, request: { kind: "connectorSignIn", connector: "claude.ai Gmail", action: "sign-in" } as never }),
    approval(requester, { toolName: "app_participants_request_change", summary: "Remove @gera from this chat", request: removal }),
    approval(requester, { toolName: "app_participants_request_change", status: "approved", summary: "Remove @gera from this chat", appliedParticipantIds: ["p-gera"], request: removal }),
    approval(requester, { toolName: "app_participants_request_change", summary: "Add @reviewer", request: { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "reviewer", roleConfigId: "generic-participant", kind: "claude-code" } }] } as never }),
    approval(requester, { toolName: "app_scripts_request_change", summary: "Add the scheduled task \"Digest\"", request: {
      kind: "script-change", op: "create", scriptId: "s1", name: "Digest", description: "", hostId: "local", hostLabel: "This Mac", hostPhrase: "this Mac",
      runtime: "node", entry: "main.mjs", schedule: { kind: "cron" }, scheduleText: "weekdays at 09:00", timeoutSeconds: 60, secretNames: [],
      permissions: { chatIds: ["chat-sessions"], participantIds: [MAIN.id, DREW.id], maxWakeupsPerHour: 2 }, chatLabels: { "chat-sessions": "Login bug" },
      participantLabels: { [MAIN.id]: "@main", [DREW.id]: "@drew" }, fileCount: 1, totalBytes: 10
    } as never }),
    approval(requester, { toolName: "app_tool_permission", status: "denied", summary: "Use Bash", error: `@${requester.handle} stopped before pending approval was resolved.`,
      request: { kind: "toolPermission", agentMode: "default", toolName: "Bash", toolInput: { command: "ls" } } as never })
  ];
}

function cardElement(item: ChatAppToolApproval): ReactElement {
  return <ChatAppToolApprovalCard approval={item} participants={PARTICIPANTS} savedParticipants={[]} roles={[]} submitting={false} onRespond={async () => undefined} />;
}

function itemProps(message: ChatMessage): Parameters<typeof ChatMessageItem>[0] {
  return {
    activityDisclosure: disclosure(), message, conversationId: "chat-sessions", participants: PARTICIPANTS, participantStatusById: new Map(),
    busy: false, onOpenThread: () => undefined, onApproveMentions: () => undefined, onRejectMentions: () => undefined,
    onRespondToChoice: () => undefined, onToggleReaction: () => undefined
  };
}

/** Replies the app wrote for the main session and a member: failures,
 *  stops, a queued turn, mentions waiting for the User, a reaction. */
function appReplies(): ChatMessage[] {
  const reply = (id: string, who: typeof MAIN, extra: Partial<ChatMessage>): ChatMessage =>
    chatMessage(id, "participant", 20, { participantId: who.id, participantLabel: `@${who.handle}`, ...extra });
  return [
    reply("main-failed", MAIN, { status: "error", content: "@main stopped before it returned a response." }),
    reply("main-stopped", MAIN, { status: "error", content: "@main stopped by user." }),
    reply("drew-failed", DREW, { status: "error", content: "@drew run failed before a response was produced: @drew belongs to another machine; no local session was started." }),
    reply("main-queued", MAIN, { status: "pending", content: "", metadata: { queuedBehind: { handle: "drew" } } }),
    reply("main-mentions", MAIN, { content: "Let me ask.", metadata: {
      requesterContinuationRequested: true,
      pendingMentions: [{ targetParticipantId: DREW.id, targetHandle: "drew", status: "pending" }],
      reactions: { "👍": [{ actorKind: "participant", actorId: DREW.id, actorLabel: "@drew" }, { actorKind: "participant", actorId: MAIN.id, actorLabel: "@main" }] }
    } as never })
  ];
}

const WARNINGS = [
  "@main's copy of @main's session may include what @main did after you tapped Fork: its session file could not be read.",
  "@main stopped before it returned a response.",
  "@main could not start from a copy of @main's session in the chat \"Remember the word APPLE\", so its next turn starts a clean session.",
  "@drew: Claude failed after 2 denied actions at 10:20 (Bash).",
  "Could not compact @drew context: the machine ended the compaction without saying how it went."
];

function sessionsChat(view: "sessions" | "classic"): Conversation {
  const conversation = sessionsConversation();
  return { ...conversation, metadata: { ...conversation.metadata, chatView: view } };
}

test("a sessions-view chat's notices name no handle: the main session by nothing, a member by its task; a classic chat's stay as written", () => {
  const names = sessionsViewNamesOf(sessionsChat("sessions"));
  assert.ok(names, "the fixture chat has a main session");
  const shown = warningNoticeEntries(WARNINGS, new Set(), (text) => sessionsViewText(text, names));
  for (const entry of shown) {
    assert.doesNotMatch(entry.text, HANDLES, entry.text);
    assert.doesNotMatch(entry.text, /main session/i, entry.text);
  }
  assert.deepEqual(shown.slice(0, 3).map((entry) => entry.text), [
    "The copy may include what was done after you tapped Fork: its session file could not be read.",
    "Stopped before it returned a response.",
    "Could not start from a copy of the session in the chat \"Remember the word APPLE\", so the next turn starts a clean session."
  ]);
  assert.deepEqual(shown.map((entry) => entry.key), warningNoticeEntries(WARNINGS, new Set()).map((entry) => entry.key), "dismissed by the stored words");
  assert.equal(sessionsViewNamesOf(sessionsChat("classic")), undefined);
  assert.deepEqual(warningNoticeEntries(WARNINGS, new Set()).map((entry) => entry.text).slice(0, 2), WARNINGS.slice(0, 2), "classic: as written");
});

test("a sessions-view chat's cards, failed replies, status line and notes name no handle; the classic view keeps them", () => {
  const elements: Array<[string, ReactElement]> = [
    ...cards(MAIN).map((item) => [`main ${item.toolName} ${item.status}`, cardElement(item)] as [string, ReactElement]),
    ...cards(DREW).map((item) => [`drew ${item.toolName} ${item.status}`, cardElement(item)] as [string, ReactElement]),
    ...appReplies().map((message) => [message.id, <ChatMessageItem key={message.id} {...itemProps(message)} presentation="sessions" />] as [string, ReactElement]),
    ["choice", <ChatChoiceCard key="choice" requesterLabel="@main" submitting={false} onConfirm={() => undefined}
      choice={{ id: "c", title: "Which color?", status: "pending", recommendedOptionId: "a", options: [{ id: "a", title: "Blue" }], createdAt: AT } as never} />],
    ["status", <RunStatusLine key="status" progress={{ runId: "r", phase: "debate", message: "@drew is responding.", createdAt: AT } as never} />],
    ["main status", <RunStatusLine key="status-main" progress={{ runId: "r", phase: "debate", message: "Compacting @main.", createdAt: AT } as never} />],
    ["accord launch", <ChatAccordLaunchCard key="accord" card={{ facilitator: "main", members: ["drew", "gera"], subject: "Ship on Monday?" }} participants={PARTICIPANTS} />],
    ["artifact note", <ChatArtifactNoteCard key="note" onToggleReaction={() => undefined}
      message={{ id: "n", createdAt: AT, metadata: {} }} card={{ actor: "main", action: "revised", artifactId: "x", label: "Plan", details: ["v3"] } as never} />]
  ];
  for (const [name, element] of elements) {
    const sessions = render(true, element);
    if (process.env.PRINT_SESSIONS_TEXT) console.log(`=== ${name}\n${sessions.text}`);
    assert.doesNotMatch(sessions.text, HANDLES, `${name} (sessions):\n${sessions.text}`);
    assert.doesNotMatch(sessions.text, /main session/i, `${name} (sessions): no label for the main session`);
    sessions.unmount();
  }
  const sessionsCard = render(true, cardElement(cards(DREW)[0]!));
  assert.match(sessionsCard.text, /Do you want to allow “Fix the logout” to use Bash\?/, "a member by its task");
  sessionsCard.unmount();
  const mainCard = render(true, cardElement(cards(MAIN)[0]!));
  assert.match(mainCard.text, /Do you want to allow it to use Bash\?/, "the main session by no name");
  mainCard.unmount();
  const failed = render(true, <ChatMessageItem {...itemProps(appReplies()[0]!)} presentation="sessions" />);
  assert.match(failed.text, /Stopped before it returned a response\./);
  failed.unmount();

  // The classic view: every word as before.
  const classicCard = render(false, cardElement(cards(MAIN)[0]!));
  assert.match(classicCard.text, /Do you want to allow @main to use Bash\?/);
  classicCard.unmount();
  const classicReply = render(false, <ChatMessageItem {...itemProps(appReplies()[0]!)} />);
  assert.match(classicReply.text, /@main stopped before it returned a response\./);
  classicReply.unmount();
  const classicQueued = render(false, <ChatMessageItem {...itemProps(appReplies()[3]!)} />);
  assert.match(classicQueued.text, /Queued — waiting for @drew to finish/);
  classicQueued.unmount();
  const classicLaunch = render(false, <ChatAccordLaunchCard card={{ facilitator: "main", members: ["drew"], subject: "Ship?" }} participants={PARTICIPANTS} />);
  assert.match(classicLaunch.text, /@main[\s\S]*@drew/);
  classicLaunch.unmount();
});

test("Activity rows of a sessions-view chat name the main session by nothing and a member by its task; a classic chat's keep the handle", () => {
  const conversation = sessionsChat("sessions");
  const pending: ChatAppToolApproval = approval(DREW, { toolName: "app_tool_permission", summary: "Grant @drew file edits", request: { kind: "toolPermission", agentMode: "default", toolName: "Edit" } as never });
  const withApproval = { ...conversation, metadata: { ...conversation.metadata, pendingAppToolApprovals: [pending] } } as Conversation;
  const items = buildChatActivityItems(withApproval, { now: "2026-11-20T11:00:00.000Z" });
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.doesNotMatch(item.title, HANDLES, item.title);
    if (item.participant) assert.notEqual(item.participant.displayName, undefined, `${item.id}: named by the view`);
    if (item.participant?.id === MAIN.id) assert.equal(item.participant.displayName, "");
  }
  const classic = buildChatActivityItems({ ...withApproval, metadata: { ...withApproval.metadata, chatView: "classic" } } as Conversation, { now: "2026-11-20T11:00:00.000Z" });
  assert.ok(classic.some((item) => /@drew/.test(item.title)), "classic: by handle");
  assert.ok(classic.every((item) => item.participant?.displayName === undefined));
});
