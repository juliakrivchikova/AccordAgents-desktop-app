import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { ArtifactSummary, ChatMessage } from "../../../shared/types";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { ChatArtifactNoteCard, artifactNoteCardForMessage } from "./chat-artifact-note-card";
import { ChatMessageItem } from "./chat-message-item";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";

const NOW = "2026-11-04T16:32:00.000Z";

function noteMessage(content: string, metadata: ChatMessage["metadata"] = { appMessageSource: "app_artifact_note", artifactEventId: "e-1" }): ChatMessage {
  return { id: "note-1", role: "system", content, createdAt: NOW, status: "done", metadata } as ChatMessage;
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

test("an artifact note's message reads as a card; any other message keeps its row", () => {
  const revised = "@taylor revised [Plan v1](#artifact:art-1) · v4 — Choice rule";
  assert.deepEqual(artifactNoteCardForMessage(noteMessage(revised)), {
    actor: "taylor", action: "revised", artifactId: "art-1", label: "Plan v1", details: ["v4"], note: "Choice rule"
  });
  assert.equal(artifactNoteCardForMessage(noteMessage(revised, {})), undefined, "a system message that is not an artifact note");
  assert.equal(artifactNoteCardForMessage({ ...noteMessage(revised), role: "participant" }), undefined, "a member quoting a note");
  assert.equal(artifactNoteCardForMessage(noteMessage("@taylor did something new to [Plan](#artifact:art-1)")), undefined);
});

test("the card names the artifact as it is now, says who did what, and opens it", () => {
  const opened: string[] = [];
  const byId = new Map<string, ArtifactSummary>([["art-1", {
    id: "art-1", name: "Plan v2", lifecycle: "published", headVersion: 4,
    approval: { state: "approved", requiredSigners: ["user"], signedCurrent: ["user"] }
  } as ArtifactSummary]]);
  const card = artifactNoteCardForMessage(noteMessage("@taylor revised [Plan v1](#artifact:art-1) · v4 — Choice rule"))!;
  const signed = artifactNoteCardForMessage(noteMessage("User signed [Plan v1](#artifact:art-1) v4 (fully approved)"))!;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <ArtifactsContext.Provider value={{ byId, openArtifact: (id) => opened.push(id) }}>
        <ChatArtifactNoteCard message={{ id: "note-1", createdAt: NOW }} card={card} onToggleReaction={() => undefined} />
        <ChatArtifactNoteCard message={{ id: "note-2", createdAt: NOW }} card={signed} onToggleReaction={() => undefined} />
      </ArtifactsContext.Provider>
    );
  });
  const root = renderer!.root;
  const [first, second] = root.findAll((node) => node.props?.className === "chat-artifact-note");
  const part = (scope: ReactTestInstance, className: string) => scope.findAll((node) => node.type === "span" && node.props?.className === className);
  assert.equal(textOf(part(first!, "chat-artifact-note-title")[0]!), "Plan v2", "a rename shows on old notes too");
  assert.match(textOf(part(first!, "chat-artifact-note-meta")[0]!), /^@taylor revised · v4 · \d\d:\d\d$/);
  assert.equal(textOf(part(first!, "chat-artifact-note-body")[0]!), "Choice rule");
  assert.equal(part(first!, "chat-artifact-note-actor chat-mention").length, 1, "a member is shown as a mention");
  assert.match(textOf(part(second!, "chat-artifact-note-meta")[0]!), /^You signed · v4 · fully approved · \d\d:\d\d$/);
  assert.equal(part(second!, "chat-artifact-note-body").length, 0, "no note line without a note");
  assert.equal(part(second!, "chat-artifact-note-actor").length, 1, "the User is not shown as a mention");
  assert.equal(root.findAll((node) => typeof node.props?.className === "string" && node.props.className.includes("message-avatar")).length, 0);
  assert.equal(first!.findByType("button").props.title, 'Open artifact "Plan v2" · v4 · fully approved', "the hover says where it stands");
  act(() => { first!.findByType("button").props.onClick(); });
  assert.deepEqual(opened, ["art-1"]);
});

test("a card for an artifact the screen does not know names it as the note did", () => {
  const card = artifactNoteCardForMessage(noteMessage("@taylor created artifact [Plan v1](#artifact:gone) · v1"))!;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatArtifactNoteCard message={{ id: "note-1", createdAt: NOW }} card={card} onToggleReaction={() => undefined} />);
  });
  const title = renderer!.root.find((node) => node.type === "span" && node.props?.className === "chat-artifact-note-title");
  assert.equal(textOf(title), "Plan v1");
  assert.doesNotThrow(() => act(() => { renderer!.root.findByType("button").props.onClick(); }), "no artifacts list: a click does nothing");
});

test("the timeline row of an artifact note is the card, with the reactions left on it", () => {
  const toggled: Array<[string, string]> = [];
  const message = {
    ...noteMessage("@taylor revised [Plan v1](#artifact:art-1) · v4"),
    metadata: {
      appMessageSource: "app_artifact_note",
      artifactEventId: "e-1",
      reactions: { "👍": [{ actorKind: "participant", actorId: "p-drew", actorLabel: "@drew", at: NOW }] }
    }
  } as ChatMessage;
  const noop = () => undefined;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <ChatMessageItem
        activityDisclosure={{} as ChatActivityDisclosureState}
        message={message}
        conversationId="chat-1"
        participantStatusById={new Map()}
        busy={false}
        onApproveMentions={noop}
        onRejectMentions={noop}
        onRespondToChoice={noop}
        onToggleReaction={(id, emoji) => toggled.push([id, emoji])}
      />
    );
  });
  const root = renderer!.root;
  assert.equal(root.findAll((node) => node.props?.className === "chat-artifact-note").length, 1, "the row is the card");
  assert.equal(root.findAll((node) => typeof node.props?.className === "string" && node.props.className.includes("message-avatar")).length, 0);
  const reaction = root.find((node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("chat-reaction"));
  act(() => { reaction.props.onClick(); });
  assert.deepEqual(toggled, [["note-1", "👍"]]);
});
