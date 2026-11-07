import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { accordLaunchTitleAndBody, parseAccordLaunchCard } from "../../../shared/accordLaunchCard";
import { accordLaunchCardForMessage } from "./chat-accord-launch-card";
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

test("the timeline row of a launch is the card: no prompt text, no skills line, the thread and reactions kept", () => {
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
  const card = root.find((node) => node.type === "article" && typeof node.props?.className === "string" && node.props.className.startsWith("chat-accord-launch"));
  assert.equal(card.props["data-message-id"], "launch-1");
  const all = textOf(card);
  assert.doesNotMatch(all, /app_chat_request_participants|Selected accord|Skills:|\/accord/);
  const part = (className: string) => root.find((node) => node.type === "span" && node.props?.className === className);
  assert.equal(textOf(part("chat-accord-launch-title")), "Pick the launch shape.");
  assert.equal(textOf(part("chat-accord-launch-body")), "Keep it short.");
  assert.equal(textOf(part("chat-accord-launch-kind")), "Accord");
  const mentions = part("chat-accord-launch-meta").findAll((node) => node.type === "span" && node.props?.className === "chat-mention").map(textOf);
  assert.deepEqual(mentions, ["@taylor", "@drew", "@gera"], "who leads it, then who is in it");
  assert.match(textOf(part("chat-accord-launch-meta")), /led by .*@taylor.*with .*@drew, .*@gera.*\d\d:\d\d$/);
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
  const card = renderer!.root.find((node) => node.type === "article" && typeof node.props?.className === "string" && node.props.className.startsWith("chat-accord-launch"));
  assert.match(textOf(card), /Not taken by your server: This chat is archived\./);
});
