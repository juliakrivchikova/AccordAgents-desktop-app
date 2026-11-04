import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { ArtifactSummary, ChatMessage } from "../../../shared/types";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { ChatArtifactNoteCard, artifactNoteCardForMessage } from "./chat-artifact-note-card";

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
  const byId = new Map<string, ArtifactSummary>([["art-1", { id: "art-1", name: "Plan v2" } as ArtifactSummary]]);
  const card = artifactNoteCardForMessage(noteMessage("@taylor revised [Plan v1](#artifact:art-1) · v4 — Choice rule"))!;
  const signed = artifactNoteCardForMessage(noteMessage("User signed [Plan v1](#artifact:art-1) v4 (fully approved)"))!;
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <ArtifactsContext.Provider value={{ byId, openArtifact: (id) => opened.push(id) }}>
        <ChatArtifactNoteCard messageId="note-1" createdAt={NOW} card={card} />
        <ChatArtifactNoteCard messageId="note-2" createdAt={NOW} card={signed} />
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
  act(() => { first!.findByType("button").props.onClick(); });
  assert.deepEqual(opened, ["art-1"]);
});
