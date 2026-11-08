import assert from "node:assert/strict";
import test from "node:test";
import {
  accordFoldedMessageIds, accordFoldedNoteKeys, accordProgressFromNotes, accordProgressNoteHead, accordProgressStages, accordProgressStatus,
  dockedAccordFrom
} from "./accordProgress";
import { parseArtifactNoteCard } from "./artifactNoteCard";

const LAUNCH = "launch-1";
const card = { facilitator: "fable", members: ["argon"], subject: "Sell now or hold?" };
const ref = "[Applied Materials: sell or hold](#artifact:art-1)";
const filed = (content: string, launch = LAUNCH) => ({ content, accordLaunchMessageId: launch });

const created = filed(`@fable created draft collection ${ref} · Drafts 0/2`);
const fableDraft = filed(`@fable submitted a draft to ${ref} · Submitted`);
const argonDraft = filed(`@argon submitted a draft to ${ref} · Submitted`);
const v1 = filed(`@fable published ${ref} · v1 — Sell before the Nov 12 earnings, unless you are in it for years.`);
const fableSignsV1 = filed(`@fable signed ${ref} v1 (1/2 signed)`);
const v2 = filed(`@fable revised ${ref} · v2 — Hold only if all four are true; otherwise sell.`);
const fableSignsV2 = filed(`@fable signed ${ref} v2 (1/2 signed)`);
const argonSignsV2 = filed(`@argon signed ${ref} v2 (fully approved)`);

test("a publication carries its version's note, and a note without one still reads", () => {
  assert.equal(parseArtifactNoteCard(v1.content)?.note, "Sell before the Nov 12 earnings, unless you are in it for years.");
  assert.deepEqual(parseArtifactNoteCard(`@fable published ${ref} · v1`)?.details, ["v1"]);
});

test("the Accord's stages follow its notes: drafts, a version with its note, signatures, the outcome", () => {
  assert.equal(accordProgressFromNotes(LAUNCH, card, []), undefined, "nothing filed yet: the card stays as it was");

  const drafting = accordProgressFromNotes(LAUNCH, card, [created, fableDraft])!;
  assert.deepEqual(drafting.drafts, { authors: ["fable", "argon"], submitted: ["fable"], state: "active" });
  assert.equal(drafting.publishState, "todo");
  assert.equal(drafting.signatures.state, "todo");
  assert.equal(accordProgressStatus(drafting), "Drafts 1/2");

  const allIn = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, argonDraft])!;
  assert.equal(allIn.drafts.state, "done");
  assert.equal(allIn.publishState, "active", "every draft is in: the facilitator is writing v1");

  const signing = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, argonDraft, v1, fableSignsV1])!;
  assert.deepEqual(signing.version, { number: 1, author: "fable", note: "Sell before the Nov 12 earnings, unless you are in it for years." });
  assert.deepEqual(signing.signatures, { signers: ["fable", "argon"], signed: ["fable"], given: 1, total: 2, state: "active" });
  assert.equal(signing.reached, false);
  assert.equal(accordProgressStatus(signing), "v1 · 1/2 signed");

  // A revision waits for every signature again, with its own note.
  const revised = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, argonDraft, v1, fableSignsV1, v2])!;
  assert.equal(revised.version?.number, 2);
  assert.equal(revised.version?.note, "Hold only if all four are true; otherwise sell.");
  assert.deepEqual(revised.signatures.signed, []);

  const reached = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, argonDraft, v1, fableSignsV1, v2, fableSignsV2, argonSignsV2])!;
  assert.equal(reached.reached, true);
  assert.equal(reached.signatures.state, "done");
  assert.equal(accordProgressStatus(reached), "Signed 2/2");
});

test("a signature on an older version, a withdrawn draft and another Accord's notes change nothing", () => {
  const late = filed(`@argon signed ${ref} v1 (2/2 signed)`);
  const progress = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, argonDraft, v1, v2, late])!;
  assert.deepEqual(progress.signatures.signed, [], "a v1 signature does not count for v2");

  const withdrawn = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, filed(`@fable withdrew a draft from ${ref} · Withdrawn`)])!;
  assert.deepEqual(withdrawn.drafts.submitted, []);

  assert.equal(accordProgressFromNotes(LAUNCH, card, [filed(`@fable created draft collection ${ref} · Drafts 0/2`, "launch-2")]), undefined);
});

test("reached is only what the document says: a signer beyond the Accord's people keeps it open", () => {
  // The User approved a third signer: the card's two people signing is 2/3.
  const signing = accordProgressFromNotes(LAUNCH, card, [
    created, fableDraft, argonDraft, v1,
    filed(`@fable signed ${ref} v1 (1/3 signed)`),
    filed(`@argon signed ${ref} v1 (2/3 signed)`)
  ])!;
  assert.equal(signing.reached, false);
  assert.equal(accordProgressStatus(signing), "v1 · 2/3 signed");
  const done = accordProgressFromNotes(LAUNCH, card, [
    created, fableDraft, argonDraft, v1,
    filed(`@fable signed ${ref} v1 (1/3 signed)`),
    filed(`@argon signed ${ref} v1 (2/3 signed)`),
    filed(`@nova signed ${ref} v1 (fully approved)`)
  ])!;
  assert.equal(done.reached, true);
  assert.deepEqual(done.signatures.signers, ["fable", "argon", "nova"], "whoever signed shows");
  assert.equal(accordProgressStatus(done), "Signed 3/3");
  // A version created already published is a version too.
  assert.equal(accordProgressFromNotes(LAUNCH, card, [filed(`@fable created artifact ${ref} · v1`)])!.version?.number, 1);
  // Handles read as the chat writes them.
  const mixed = accordProgressFromNotes(LAUNCH, { ...card, facilitator: "@Fable", members: ["fable", "Argon"] }, [created])!;
  assert.deepEqual(mixed.drafts.authors, ["fable", "argon"]);
});

test("a note written without the link still counts for its document, and every Accord document's notes leave the chat", () => {
  // @argon's device was on an older version: its note carries no link.
  const unlinked = { content: `@argon submitted a draft to ${ref} · Submitted` };
  const progress = accordProgressFromNotes(LAUNCH, card, [created, fableDraft, unlinked])!;
  assert.deepEqual(progress.drafts.submitted, ["fable", "argon"]);
  const other = { content: "@fable created artifact [Notes](#artifact:art-9) · v1" };
  const notes = [created, fableDraft, unlinked, other].map((note, index) => ({ key: `k${index}`, ...note }));
  assert.deepEqual([...accordFoldedNoteKeys(notes)], ["k0", "k1", "k2"], "a document filed under no Accord keeps its card");

  // The facilitator made the document again: the card follows the newest;
  // both documents' notes stay out of the chat (they are in the documents).
  const again = "[Applied Materials v2](#artifact:art-2)";
  const second = [created, fableDraft, filed(`@fable created draft collection ${again} · Drafts 0/2`), filed(`@fable submitted a draft to ${again} · Submitted`)];
  assert.equal(accordProgressFromNotes(LAUNCH, card, second)!.artifactId, "art-2");
  assert.deepEqual([...accordFoldedNoteKeys(second.map((note, index) => ({ key: `k${index}`, ...note })))], ["k0", "k1", "k2", "k3"]);
});

test("the chat's folded notes: worked out from the loaded messages once per list", () => {
  const at = "2026-11-08T10:00:00Z";
  const launch = {
    id: LAUNCH, role: "user", createdAt: at,
    content: [
      "@fable /accord", "", "Subject:", "Sell now or hold?", "", "Selected accord members: argon.",
      "Run the accord skill for exactly those selected members and this subject. Use app_chat_request_participants for those members only. The app has enabled request-members permission for you in this chat; the user can revoke it from your member controls."
    ].join("\n")
  };
  const note = (id: string, input: { content: string; accordLaunchMessageId?: string }) => ({
    id, role: "system", createdAt: at, content: input.content,
    metadata: { appMessageSource: "app_artifact_note", ...(input.accordLaunchMessageId ? { accordLaunchMessageId: input.accordLaunchMessageId } : {}) }
  });
  const messages = [launch, note("n1", created), note("n2", fableDraft), note("n3", { content: "@fable created artifact [Notes](#artifact:art-9) · v1" })];
  assert.deepEqual([...accordFoldedMessageIds(messages)], ["n1", "n2"]);
  assert.equal(accordFoldedMessageIds(messages), accordFoldedMessageIds(messages), "the same list is not read twice");
  assert.deepEqual([...accordFoldedMessageIds(messages.slice(1))], ["n1", "n2"], "also without the launch loaded");
});

test("the stages carry the same words on both screens", () => {
  const stages = accordProgressStages(accordProgressFromNotes(LAUNCH, card, [created, fableDraft, argonDraft, v1, fableSignsV1])!);
  assert.deepEqual(stages.map((stage) => [stage.label, stage.state, stage.detail ?? ""]), [
    ["Drafts", "done", "Each member answered without seeing the others"],
    ["v1 published", "done", "by @fable"],
    ["Signatures", "active", ""],
    ["Accord reached", "todo", ""]
  ]);
  assert.deepEqual(stages[2]!.members, [{ handle: "fable", given: true, waiting: true }, { handle: "argon", given: false, waiting: true }]);
});

test("a version published without a note names itself, not an empty note", () => {
  assert.equal(accordProgressNoteHead({ number: 1, author: "fable", note: "Sell." }), "v1 · note by @fable");
  assert.equal(accordProgressNoteHead({ number: 1, author: "fable" }), "v1 by @fable");
});

test("the pinned Accord is the chat's newest, also when only its notes are loaded", () => {
  const launchCard = { facilitator: "fable", members: ["argon"] };
  const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00Z`;
  const notes = [
    { ...created, createdAt: at(1), accordLaunch: launchCard },
    { ...fableDraft, createdAt: at(2), accordLaunch: launchCard }
  ];
  // A long chat: the launch is not among the loaded messages; its notes say who is in it.
  const docked = dockedAccordFrom([], notes)!;
  assert.equal(docked.launchId, LAUNCH);
  assert.deepEqual(docked.progress.drafts.authors, ["fable", "argon"]);
  // A newer Accord has started and has no document yet: the older one is not pinned in its place.
  assert.equal(dockedAccordFrom([{ id: "launch-new", card, createdAt: at(5) }], notes), undefined);
  // Notes from before the link name no launch: nothing is pinned.
  assert.equal(dockedAccordFrom([], [{ content: created.content, createdAt: at(1) }]), undefined);
});

test("an Accord's notes stay out of the chat, also without its launch loaded", () => {
  const at = "2026-11-08T10:00:00Z";
  const note = (id: string, input: { content: string; accordLaunchMessageId?: string }) => ({
    id, role: "system", createdAt: at, content: input.content,
    metadata: { appMessageSource: "app_artifact_note", accordLaunchMessageId: input.accordLaunchMessageId, accordLaunch: { facilitator: "fable", members: ["argon"] } }
  });
  const messages = [note("n1", created), note("n2", fableDraft)];
  assert.deepEqual([...accordFoldedMessageIds(messages)], ["n1", "n2"]);
});
