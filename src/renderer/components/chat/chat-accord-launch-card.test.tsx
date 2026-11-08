import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../shared/types";
import { accordLaunchTitleAndBody, parseAccordLaunchCard } from "../../../shared/accordLaunchCard";
import { accordProgressFromNotes } from "../../../shared/accordProgress";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { accordLaunchCardForMessage } from "./chat-accord-launch-card";
import { ChatAccordDockSlot } from "./chat-accord-dock";
import { resetAccordDockStoreForTests } from "./accord-dock-store";
import { chatTopLevelMessages } from "./chat-thread-data";
import { ChatMessageItem } from "./chat-message-item";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";

const NOW = "2026-11-07T16:46:00.000Z";
const MEMBERS_INSTRUCTION = "Run the accord skill for exactly those selected members and this subject. Use app_chat_request_participants for those members only. The app has enabled request-members permission for you in this chat; the user can revoke it from your member controls.";
const PARTICIPANTS_INSTRUCTION = "Run the accord skill for exactly those selected participants and this subject. Use app_chat_request_participants for those participants only. The app has enabled request-participants permission for you in this chat; the user can revoke it from your participant controls.";

function launch(subject: string, members = "drew, gera", wording: "members" | "participants" = "members"): string {
  return [
    "@taylor /accord",
    "",
    "Subject:",
    subject,
    "",
    `Selected accord ${wording}: ${members}.`,
    wording === "members" ? MEMBERS_INSTRUCTION : PARTICIPANTS_INSTRUCTION
  ].join("\n");
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

test("the launch prompt reads as an Accord card, in both wordings it has had", () => {
  assert.deepEqual(parseAccordLaunchCard(launch("Pick the launch shape.")), {
    facilitator: "taylor", members: ["drew", "gera"], subject: "Pick the launch shape."
  });
  // Until 2026-07-22 the prompt said "participants".
  assert.deepEqual(parseAccordLaunchCard(launch("Old one", "drew", "participants")), {
    facilitator: "taylor", members: ["drew"], subject: "Old one"
  });
  // The oldest launches said what the app granted in other words.
  const granted = launch("Oldest", "taylor-claude-engineer", "participants").replace(
    /The app has .*$/,
    "The app has granted participant-request access for this accord until a canonical resolution is approved or the grant expires."
  );
  assert.deepEqual(parseAccordLaunchCard(granted)?.members, ["taylor-claude-engineer"]);
  // A subject of several lines, blank lines included, stays whole.
  assert.equal(parseAccordLaunchCard(launch("Line one\n\nLine three"))?.subject, "Line one\n\nLine three");
  assert.equal(parseAccordLaunchCard(launch("Windows line ends").replace(/\n/g, "\r\n"))?.subject, "Windows line ends");
});

test("anything that is not exactly a launch prompt keeps its row", () => {
  assert.equal(parseAccordLaunchCard(undefined), undefined);
  assert.equal(parseAccordLaunchCard("@taylor /accord please look at this"), undefined);
  assert.equal(parseAccordLaunchCard(launch("Subject") + "\nAnd one more thing."), undefined, "text after the instruction");
  assert.equal(parseAccordLaunchCard(launch("Subject").replace("Run the accord skill", "Run the skill")), undefined, "a changed instruction");
  assert.equal(parseAccordLaunchCard(launch("   ")), undefined, "no subject");
  assert.equal(parseAccordLaunchCard(launch("Subject", "")), undefined, "no members");
  assert.equal(parseAccordLaunchCard("Quoted:\n" + launch("Subject")), undefined, "quoted inside another message");
  const userMessage = { role: "user", content: launch("Subject") } as ChatMessage;
  assert.ok(accordLaunchCardForMessage(userMessage));
  assert.equal(accordLaunchCardForMessage({ ...userMessage, role: "participant" }), undefined, "a member quoting the prompt");
  // The card would hide what the message carries; a launch never carries any.
  assert.equal(accordLaunchCardForMessage({ ...userMessage, metadata: { imageAttachments: [{ id: "img-1" }] } } as unknown as ChatMessage), undefined, "a lookalike with a picture");
  assert.equal(accordLaunchCardForMessage({ ...userMessage, metadata: { repoFileMentions: [{ path: "a.ts" }] } } as unknown as ChatMessage), undefined, "a lookalike with a file reference");
  // A long text that does not open like a launch is turned away at once.
  assert.equal(parseAccordLaunchCard("x".repeat(500_000)), undefined);
});

test("the subject's first line is the title, the rest is the body", () => {
  assert.deepEqual(accordLaunchTitleAndBody("One line"), { title: "One line" });
  assert.deepEqual(accordLaunchTitleAndBody("Title\n\nMore\nlines"), { title: "Title", body: "More\nlines" });
});

test("a launch is her message with the card as its content: no prompt text, no skills line, no Copy; thread and reactions kept", () => {
  const opened: string[] = [];
  const toggled: Array<[string, string]> = [];
  const participants = [
    { id: "p-taylor", handle: "taylor", kind: "claude-code" },
    { id: "p-drew", handle: "drew", kind: "codex-cli" }
  ] as ChatParticipant[];
  const message = {
    id: "launch-1",
    role: "user",
    content: launch("Pick the launch shape.\nKeep it short."),
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "launch-1",
      serverSeq: 12,
      skillMentions: [{ displayName: "/accord", frontmatterName: "accord", variants: [{ providerKind: "claude-code" }] }],
      reactions: { "👍": [{ actorKind: "participant", actorId: "p-drew", actorLabel: "@drew", at: NOW }] }
    }
  } as unknown as ChatMessage;
  const noop = () => undefined;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
      <ChatMessageItem
        activityDisclosure={{ expandedProcessingTranscriptMessageIds: new Set<string>() } as unknown as ChatActivityDisclosureState}
        message={message}
        conversationId="chat-1"
        participants={participants}
        participantStatusById={new Map()}
        busy={false}
        replyCount={3}
        onOpenThread={(id) => opened.push(id)}
        onApproveMentions={noop}
        onRejectMentions={noop}
        onRespondToChoice={noop}
        onToggleReaction={(id, emoji) => toggled.push([id, emoji])}
      />
      </TooltipProvider>
    );
  });
  const root = renderer!.root;
  const card = root.find((node) => node.type === "article" && typeof node.props?.className === "string" && node.props.className.includes("chat-message"));
  assert.equal(card.props["data-message-id"], "launch-1");
  assert.equal(root.findAll((node) => node.props?.className === "chat-accord-launch-card").length, 1, "the card is the message's content");
  assert.match(textOf(root.find((node) => node.props?.className === "message-meta")), /^You/, "her name and time head it, as on any message of hers");
  assert.equal(root.findAll((node) => node.props?.label === "Copy message").length, 0, "nothing to copy: the text is the lead's prompt");
  const all = textOf(card);
  assert.doesNotMatch(all, /app_chat_request_participants|Selected accord|Skills:|\/accord/);
  const part = (className: string) => root.find((node) => node.type === "span" && node.props?.className === className);
  assert.equal(textOf(part("chat-accord-launch-title")), "Pick the launch shape.");
  assert.equal(textOf(part("chat-accord-launch-body")), "Keep it short.");
  assert.equal(textOf(part("chat-accord-launch-kind")), "Accord");
  const mentions = part("chat-accord-launch-meta").findAll((node) => node.type === "span" && node.props?.className === "chat-mention").map(textOf);
  assert.deepEqual(mentions, ["@taylor", "@drew", "@gera"], "who leads it, then who is in it");
  assert.match(textOf(part("chat-accord-launch-meta")), /led by .*@taylor.*with .*@drew, .*@gera$/);
  // A removed member still shows by handle.
  assert.equal(root.findAll((node) => node.props?.className === "chat-accord-launch-member").length, 3);
  const pill = root.find((node) => node.type === "button" && node.props?.className === "chat-thread-pill");
  assert.match(textOf(pill), /3 replies/);
  act(() => { pill.props.onClick(); });
  assert.deepEqual(opened, ["launch-1"]);
  const reaction = root.find((node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("chat-reaction"));
  act(() => { reaction.props.onClick(); });
  assert.deepEqual(toggled, [["launch-1", "👍"]]);
  assert.ok(root.findAll((node) => node.props?.label === "Reply in thread").length > 0, "reply in thread stays on hover");
  assert.ok(!String(card.props.className).includes("is-unsent"), "a launch the server holds is not faded");
});

test("a launch the server refused says why under the card, as her other messages do", () => {
  const noop = () => undefined;
  const message = {
    id: "launch-2", role: "user", content: launch("Refused one"), createdAt: NOW, status: "done",
    metadata: { threadId: "launch-2", serverRejected: "This chat is archived." }
  } as unknown as ChatMessage;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
      <ChatMessageItem
        activityDisclosure={{ expandedProcessingTranscriptMessageIds: new Set<string>() } as unknown as ChatActivityDisclosureState}
        message={message}
        conversationId="chat-1"
        participantStatusById={new Map()}
        busy={false}
        onApproveMentions={noop}
        onRejectMentions={noop}
        onRespondToChoice={noop}
        onToggleReaction={noop}
      />
      </TooltipProvider>
    );
  });
  const row = renderer!.root.find((node) => node.type === "article" && typeof node.props?.className === "string" && node.props.className.includes("chat-message"));
  assert.equal(row.findAll((node) => node.props?.className === "chat-accord-launch-card").length, 1);
  assert.match(textOf(row), /Not taken by your server: This chat is archived\./);
});

test("the newest Accord with a document is pinned above the composer: stages, note and Open; its notes leave the timeline", () => {
  const participants = [
    { id: "p-taylor", handle: "taylor", kind: "claude-code" },
    { id: "p-drew", handle: "drew", kind: "codex-cli" }
  ] as ChatParticipant[];
  const ref = "[Ship or wait](#artifact:art-1)";
  const note = (id: string, content: string, accordLaunchMessageId?: string) => ({
    id, role: "system", content, createdAt: NOW, status: "done",
    metadata: { appMessageSource: "app_artifact_note", artifactEventId: `e-${id}`, ...(accordLaunchMessageId ? { accordLaunchMessageId } : {}) }
  }) as unknown as ChatMessage;
  const launchMessage = { id: "launch-1", role: "user", content: launch("Ship or wait?", "drew"), createdAt: NOW, status: "done", metadata: { threadId: "launch-1" } } as unknown as ChatMessage;
  const conversation = {
    id: "chat-1", kind: "chat", title: "Chat", createdAt: NOW, updatedAt: NOW, findings: [], metadata: {},
    messages: [
      launchMessage,
      note("n1", `@taylor created draft collection ${ref} · Drafts 0/2`, "launch-1"),
      note("n2", `@taylor submitted a draft to ${ref} · Submitted`, "launch-1"),
      note("n3", `@drew submitted a draft to ${ref} · Submitted`, "launch-1"),
      note("n4", `@taylor published ${ref} · v1 — Wait for the fix, then ship on Monday.`, "launch-1"),
      note("n5", `@taylor signed ${ref} v1 (1/2 signed)`, "launch-1"),
      note("old", "@taylor created artifact [Other](#artifact:art-2) · v1")
    ]
  } as unknown as Conversation;

  // Folded: every note of an Accord's document; one filed under no Accord stays a card.
  assert.deepEqual(chatTopLevelMessages(conversation).map((message) => message.id), ["launch-1", "old"]);
  assert.deepEqual(chatTopLevelMessages({ ...conversation, messages: conversation.messages.slice(1) }).map((message) => message.id),
    ["old"], "also when its launch is not loaded");

  const card = parseAccordLaunchCard(launchMessage.content)!;
  const progress = accordProgressFromNotes("launch-1", card, conversation.messages.map((message) => ({
    content: message.content, accordLaunchMessageId: message.metadata?.accordLaunchMessageId
  })))!;
  // The test runs without a page: a storage of its own for the dock's choices.
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } }
  });
  resetAccordDockStoreForTests();
  const opened: string[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  const render = () => create(
    <TooltipProvider>
      <ArtifactsContext.Provider value={{ byId: new Map(), openArtifact: (id) => opened.push(id) }}>
        <ChatAccordDockSlot docked={{ launchId: "launch-1", card, progress }} conversationId="chat-1" participants={participants} />
      </ArtifactsContext.Provider>
    </TooltipProvider>
  );
  act(() => { renderer = render(); });
  const root = () => renderer!.root;
  const byClass = (className: string) => root().findAll((node) => typeof node.props?.className === "string" && node.props.className.split(" ").includes(className));
  assert.equal(textOf(byClass("chat-accord-dock-title")[0]!), "Ship or wait");
  assert.match(textOf(byClass("chat-accord-dock-meta")[0]!), /^Accord · led by @taylor · with @drew$/);
  assert.equal(textOf(byClass("chat-accord-progress-status")[0]!), "v1 · 1/2 signed");
  assert.deepEqual(byClass("chat-accord-progress-label").map(textOf), ["Drafts", "v1 published", "Signatures", "Accord reached"]);
  assert.deepEqual(byClass("chat-accord-progress-stage").map((node) => node.props.className.split(" ")[1]), ["is-done", "is-done", "is-active", "is-todo"]);
  assert.equal(textOf(byClass("chat-accord-progress-note-head")[0]!), "v1 · note by @taylor");
  assert.equal(textOf(byClass("chat-accord-progress-note-body")[0]!), "Wait for the fix, then ship on Monday.");
  const open = root().find((node) => node.type === "button" && node.props?.className === "chat-accord-progress-open");
  act(() => { open.props.onClick(); });
  assert.deepEqual(opened, ["art-1"]);

  // The head folds it into one line, and the choice is kept.
  const toggle = root().find((node) => node.type === "button" && node.props?.className === "chat-accord-dock-toggle");
  act(() => { toggle.props.onClick(); });
  assert.equal(byClass("chat-accord-progress-stage").length, 0);
  assert.equal(textOf(byClass("chat-accord-progress-status")[0]!), "v1 · 1/2 signed", "the folded line keeps the state");
  act(() => { renderer!.unmount(); renderer = render(); });
  assert.equal(byClass("chat-accord-progress-stage").length, 0, "still folded when shown again");

  // Closed, it stays closed for this Accord; a newer one in the chat shows.
  const close = root().find((node) => node.props?.label === "Close" && typeof node.props?.onClick === "function");
  act(() => { close.props.onClick(); });
  assert.equal(byClass("chat-accord-dock").length, 0);
  assert.deepEqual(chatTopLevelMessages({ ...conversation, messages: [...conversation.messages] }).map((message) => message.id),
    ["launch-1", "old"], "closed: the notes stay out of the chat, in the document (the User, 2026-11-08)");
  act(() => {
    renderer!.unmount();
    renderer = create(
      <TooltipProvider>
        <ChatAccordDockSlot docked={{ launchId: "launch-2", card, progress }} conversationId="chat-1" participants={participants} />
      </TooltipProvider>
    );
  });
  assert.equal(byClass("chat-accord-dock").length, 1, "a new Accord opens again");
  assert.equal(byClass("chat-accord-progress-stage").length, 4, "unfolded");
});
