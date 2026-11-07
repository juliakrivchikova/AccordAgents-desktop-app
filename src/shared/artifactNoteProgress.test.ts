import assert from "node:assert/strict";
import test from "node:test";
import { artifactNoteProgressById } from "./artifactNoteProgress";

const link = "[Accord: Applied Materials](#artifact:art-1)";
// The notes of one Accord, as ArtifactService writes them, in timeline order.
const accord = [
  { id: "n1", content: `@taylor created draft collection ${link} · Drafts 0/2` },
  { id: "n2", content: `@taylor submitted a draft to ${link} · Submitted` },
  { id: "n3", content: `@drew submitted a draft to ${link} · Submitted` },
  { id: "n4", content: `@taylor published ${link} · v1` },
  { id: "n5", content: `@taylor signed ${link} v1 (1/2 signed)` },
  { id: "n6", content: `@taylor revised ${link} · v2 — corrected the dates` },
  { id: "n7", content: `@taylor signed ${link} v2 (1/2 signed)` },
  { id: "n8", content: `@drew signed ${link} v2 (fully approved)` }
];

test("each note shows the drafts and signatures as they stood when it was written", () => {
  const progress = artifactNoteProgressById(accord);
  assert.deepEqual(progress.get("n1"), { kind: "drafts", done: [], total: 2, complete: false });
  assert.deepEqual(progress.get("n2"), { kind: "drafts", done: ["taylor"], total: 2, complete: false });
  assert.deepEqual(progress.get("n3"), { kind: "drafts", done: ["taylor", "drew"], total: 2, complete: false });
  // Publishing waits for every signer; how many, a later "k/N signed" note says.
  assert.deepEqual(progress.get("n4"), { kind: "signatures", done: [], total: 2, complete: false });
  assert.deepEqual(progress.get("n5"), { kind: "signatures", done: ["taylor"], total: 2, complete: false });
  // A new version: the signatures given to v1 no longer count.
  assert.deepEqual(progress.get("n6"), { kind: "signatures", done: [], total: 2, complete: false });
  assert.deepEqual(progress.get("n7"), { kind: "signatures", done: ["taylor"], total: 2, complete: false });
  assert.deepEqual(progress.get("n8"), { kind: "signatures", done: ["taylor", "drew"], total: 2, complete: true });
});

test("notes before the loaded part of the chat still count, unnamed", () => {
  // Only "fully approved" loaded: the desktop says how many signers there are.
  const progress = artifactNoteProgressById(accord.slice(7), () => 2);
  assert.deepEqual(progress.get("n8"), { kind: "signatures", done: ["drew", ""], total: 2, complete: true });
  const middle = artifactNoteProgressById(accord.slice(6, 7));
  assert.deepEqual(middle.get("n7"), { kind: "signatures", done: ["taylor"], total: 2, complete: false });
});

test("the desktop's signer count fills in when no note says it; other notes get no marks", () => {
  const notes = [
    { id: "p", content: `@taylor published ${link} · v1` },
    { id: "r", content: `@taylor renamed artifact ${link} (was "Old")` },
    { id: "x", content: "not a note" }
  ];
  assert.equal(artifactNoteProgressById(notes).size, 0, "no count known: no marks rather than a guess");
  const withSummary = artifactNoteProgressById(notes, () => 3);
  assert.deepEqual(withSummary.get("p"), { kind: "signatures", done: [], total: 3, complete: false });
  assert.equal(withSummary.get("r"), undefined);
  // A withdrawn draft is taken back.
  const withdrawn = artifactNoteProgressById([
    accord[0]!, accord[1]!, { id: "w", content: `@taylor withdrew a draft from ${link} · Withdrawn` }
  ]);
  assert.deepEqual(withdrawn.get("w"), { kind: "drafts", done: [], total: 2, complete: false });
});
