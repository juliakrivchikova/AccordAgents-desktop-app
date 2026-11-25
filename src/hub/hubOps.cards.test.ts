import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "../main/services/storage";
import type { HubChatPage, HubFeedResponse, HubOp, HubOpsResponse } from "../shared/hubOps";
import type { ChatMessage } from "../shared/types";
import { answerOf, artifactOp, createChat, hub, id } from "./hubOps/test/hubOpsFixtures";

test("a card is raised by the member's device, answered once from any device, and settled by the device that raised it", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-1", tool: "app_chat_request_participants" } };
  const byPhone = await h.write(h.phone, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-1", cardKind: "permission", participantId: "p-box", card });
  assert.equal(byPhone.body.results[0].status, "rejected", "only the member's device raises it");
  const raised = await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-1", cardKind: "permission", participantId: "p-box", card });
  assert.equal(raised.body.results[0].status, "accepted");
  const open = await h.call<{ cards: Array<{ cardId: string; state: string }> }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`);
  assert.deepEqual(open.body.cards.map((item) => [item.cardId, item.state]), [["card-1", "pending"]]);
  const answered = await h.write(h.phone, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-1", answer: { approve: true } });
  assert.equal(answered.body.results[0].status, "accepted");
  const second = await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-1", answer: { approve: false } });
  assert.equal(second.body.results[0].status, "rejected", "the first answer is the one");
  const notRaiser = await h.write(h.owner, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-1", outcome: { applied: true } });
  assert.equal(notRaiser.body.results[0].status, "rejected");
  // Raised again while answered: the answer stands, nothing changes.
  const whileAnswered = await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-1", cardKind: "permission", participantId: "p-box", card: { approval: { id: "ap-1", changed: true } } });
  assert.equal(whileAnswered.body.results[0].status, "accepted");
  assert.equal((whileAnswered.body.results[0] as { card?: { state: string; answer?: unknown } }).card?.state, "answered");
  const settled = await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-1", outcome: { applied: true } });
  assert.equal(settled.body.results[0].status, "accepted");
  assert.deepEqual((await h.call<{ cards: unknown[] }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`)).body.cards, []);
  const feed = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body;
  assert.deepEqual(feed.entries.filter((entry) => entry.effect.kind.startsWith("card.")).map((entry) => entry.effect.kind), ["card.raise", "card.answer", "card.settle"]);
});

test("a card always names its member: one naming nobody, someone not in the chat, or a member of another device is refused, and it keeps its member", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-3" } };
  const raise = (who: typeof h.owner, extra: Record<string, unknown>) =>
    h.write(who, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-3", cardKind: "permission", card, ...extra } as unknown as HubOp);
  const nobody = await raise(h.machine, {});
  assert.equal(nobody.body.results[0].status, "rejected", "a card without its member");
  assert.match((nobody.body.results[0] as { reason: string }).reason, /names its member/);
  assert.equal((await raise(h.machine, { participantId: "p-gone" })).body.results[0].status, "rejected", "not a member of the chat");
  // The computer holds a copy of the machine member's card: never its to raise.
  assert.equal((await raise(h.owner, { participantId: "p-box" })).body.results[0].status, "rejected");
  // Nor the machine the computer's member's.
  assert.equal((await raise(h.machine, { participantId: "p-desk" })).body.results[0].status, "rejected");
  assert.equal((await raise(h.machine, { participantId: "p-box" })).body.results[0].status, "accepted");
  const choice = await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "choice:m-1", cardKind: "choice", participantId: "p-box",
    card: { choice: { id: "c-1" } } } as unknown as HubOp);
  assert.equal(choice.body.results[0].status, "rejected", "a choice names the message that asked it");
  const owner = await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-desk", cardKind: "permission", participantId: "p-desk", card });
  assert.equal(owner.body.results[0].status, "accepted", "the computer raises its own member's card");
  const moved = await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-desk", cardKind: "roster", participantId: "p-desk", card });
  assert.equal(moved.body.results[0].status, "rejected", "a card keeps its kind");
  const open = await h.call<{ cards: Array<{ cardId: string; participantId?: string; raisedBy: string }> }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`);
  assert.deepEqual(open.body.cards.map((item) => [item.cardId, item.participantId]).sort(), [["card-3", "p-box"], ["card-desk", "p-desk"]]);
});

test("the User answers from her computer or phone; a machine only says its own member's policy allowed its own card", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-4" } };
  await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-desk-4", cardKind: "permission", participantId: "p-desk", card });
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-box-4", cardKind: "roster", participantId: "p-box", card });
  const status = (response: { body: HubOpsResponse }) => response.body.results[0].status;
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-desk-4", answer: { approve: true } })), "rejected",
    "not another device's card");
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-desk-4", answer: { approve: true, auto: true } })), "rejected");
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-box-4", answer: { approve: true } })), "rejected",
    "nor its own as the User");
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-box-4", answer: { approve: true, auto: true } })), "accepted");
  assert.equal(status(await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-desk-4", answer: { approve: true } })), "accepted",
    "the computer answers its own member's card");
});

test("a settle that names an answer settles only that answer; a deleted chat takes its cards with it", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-5" } };
  const raise = () => h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-5", cardKind: "permission", participantId: "p-box", card });
  await raise();
  const first = id("op");
  await h.write(h.phone, { opId: first, kind: "card.answer", conversationId: chat, cardId: "card-5", answer: { approve: true } });
  // Refused and asked again; the User answers again.
  await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "refused", answerOpId: first } });
  await raise();
  const stale = await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "applied", answerOpId: first } });
  assert.equal(stale.body.results[0].status, "rejected", "a settle of the earlier answer never closes the card asked again");
  const second = id("op");
  await h.write(h.owner, { opId: second, kind: "card.answer", conversationId: chat, cardId: "card-5", answer: { approve: true } });
  assert.equal((await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "refused", answerOpId: first } }))
    .body.results[0].status, "rejected");
  assert.equal((await h.storage.hubOps().card("card-5"))?.state, "answered", "the newer answer stands");
  assert.equal((await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "applied", answerOpId: second } }))
    .body.results[0].status, "accepted");
  // Open cards of a chat that is deleted go with it.
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-6", cardKind: "permission", participantId: "p-box", card });
  await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "choice:m-6", cardKind: "choice", participantId: "p-desk", messageId: "m-6",
    card: { choice: { id: "c-6" }, sourceMessageId: "m-6" } });
  assert.equal((await h.storage.hubOps().openCards(chat)).length, 2);
  assert.equal((await h.write(h.owner, { opId: id("op"), kind: "conversation.delete", conversationId: chat })).body.results[0].status, "accepted");
  assert.deepEqual(await h.storage.hubOps().openCards(chat), []);
  assert.equal(await h.storage.hubOps().card("card-5"), undefined);
});

test("the phone reads a chat's newest cards first, without the mention approvals it does not show", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  for (const [cardId, cardKind, messageId] of [["old-1", "permission"], ["mention:m-1", "mention", "m-1"], ["new-1", "permission"]] as const) {
    await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId, cardKind, participantId: "p-desk",
      ...(messageId ? { messageId } : {}), card: { approval: { id: cardId } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual((await h.storage.hubOps().openCards(chat, 1, { newestFirst: true, exceptKinds: ["mention"] })).map((card) => card.cardId), ["new-1"]);
  assert.deepEqual((await h.storage.hubOps().openCards(chat)).map((card) => card.cardId), ["old-1", "mention:m-1", "new-1"]);
});

test("a server whose cards table predates the answer's operation id keeps its cards and gets the column", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-cards-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "hub.sqlite3");
  execFileSync("sqlite3", [dbPath, `create table hub_cards (card_id text primary key, conversation_id text not null, card_kind text not null,
    participant_id text, message_id text, raised_by text not null, raised_at text not null, card_json text not null,
    state text not null check(state in ('pending', 'answered', 'settled')), answer_json text, answered_by text, answered_at text,
    outcome_json text, settled_at text);
    insert into hub_cards(card_id, conversation_id, card_kind, participant_id, raised_by, raised_at, card_json, state)
      values ('old-card', 'chat-old', 'permission', 'p-box', 'device-box', '2026-10-27T08:00:00.000Z', '{"approval":{"id":"old-card"}}', 'pending');`]);
  const store = new StorageService({ dbPath }).hubOps();
  const card = await store.card("old-card");
  assert.deepEqual([card?.state, card?.participantId, card?.answerOpId], ["pending", "p-box", undefined]);
  await store.execute(store.cardSql({ ...card!, state: "answered", answer: { approve: true }, answeredBy: "device-phone", answeredAt: "2026-10-28T08:00:00.000Z", answerOpId: "op-answer" }));
  assert.equal((await store.card("old-card"))?.answerOpId, "op-answer");
});

test("a card its device could not apply is settled with why, and raised again it is asked again from the start", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-2" } };
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-2", cardKind: "permission", participantId: "p-box", card });
  const answerOp = id("op");
  assert.equal((await h.write(h.phone, { opId: answerOp, kind: "card.answer", conversationId: chat, cardId: "card-2", answer: { approve: true } })).body.results[0].status, "accepted");
  const refused = await h.write(h.machine,
    { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-2", outcome: { result: "refused", reason: "Approved on the desktop.", answerOpId: answerOp } },
    { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-2", cardKind: "permission", participantId: "p-box",
      card: { ...card, refusals: [{ operationId: answerOp, reason: "Approved on the desktop.", at: new Date().toISOString() }] } });
  assert.deepEqual(refused.body.results.map((result) => result.status), ["accepted", "accepted"]);
  const open = await h.call<{ cards: Array<{ cardId: string; state: string; answer?: unknown; answeredBy?: string; outcome?: unknown; card: Record<string, unknown> }> }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`);
  assert.equal(open.body.cards.length, 1);
  assert.equal(open.body.cards[0].state, "pending", "asked again");
  assert.equal(open.body.cards[0].answer, undefined, "the refused answer is gone");
  assert.equal(open.body.cards[0].answeredBy, undefined);
  assert.equal(open.body.cards[0].outcome, undefined);
  assert.ok(Array.isArray(open.body.cards[0].card.refusals), "the card says why the answer was not taken");
  const again = await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-2", answer: { approve: true } });
  assert.equal(again.body.results[0].status, "accepted", "answered again from another device");
});

test("documents: drafts follow the roster and the readers' policy, and an operation id answers the same every time", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const collect = { name: "Ideas", initialState: "collecting_drafts", operationId: "collect-1",
    allowedDraftAuthors: ["desk", "box"], requiredDraftAuthors: ["desk", "box"],
    audiencePolicyByAuthor: { desk: { allowedReaders: ["box"], requiredReaders: [] }, box: { allowedReaders: [], requiredReaders: [] } } };
  const created = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", collect)));
  assert.equal(created.ok, true, JSON.stringify(created));
  const artifactId = created.value!.summary!.id;
  // The same operation id again returns the same answer, not a second document.
  const again = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", collect)));
  assert.equal(again.value!.summary!.id, artifactId);
  const reused = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", { ...collect, name: "Other" })));
  assert.match(reused.error?.message ?? "", /already used with a different request/);
  // A reader the author's policy forbids is refused.
  const forbidden = answerOf(await h.write(h.machine, artifactOp("artifact.draft.save", chat, "box",
    { artifactId, expectedEditRevision: 0, content: "Box idea", readers: ["desk"], operationId: "box-save-1" })));
  assert.equal(forbidden.error?.code, "invalid_request");
  assert.match(forbidden.error?.message ?? "", /forbidden by the artifact audience policy/);
  const saved = answerOf(await h.write(h.machine, artifactOp("artifact.draft.save", chat, "box",
    { artifactId, expectedEditRevision: 0, content: "Box idea", readers: [], operationId: "box-save-2" })));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  // Only the User or the owner changes the roster.
  const roster = answerOf(await h.write(h.machine, artifactOp("artifact.roster", chat, "box", {
    artifactId, expectedDraftRosterRevision: 0, allowedDraftAuthors: ["box"], requiredDraftAuthors: ["box"],
    audiencePolicyByAuthor: { box: { allowedReaders: [], requiredReaders: [] } }, operationId: "roster-1" })));
  assert.equal(roster.error?.code, "access_denied");
  // Publication waits for every required draft.
  const early = answerOf(await h.write(h.machine, artifactOp("artifact.publish", chat, "box",
    { artifactId, content: "Merged", requiredSigners: [], sources: [{ draftId: saved.value!.id, disposition: "considered" }], operationId: "publish-1" })));
  assert.equal(early.error?.code, "access_denied", "only the owner (the User here) publishes");
  const notReady = answerOf(await h.write(h.phone, artifactOp("artifact.publish", chat, "user",
    { artifactId, content: "Merged", requiredSigners: [], sources: [{ draftId: saved.value!.id, disposition: "considered" }], operationId: "publish-2" })));
  assert.match(notReady.error?.message ?? "", /required drafts are submitted/);
});

test("a note that a member finished answering is written only by the device the member runs on", async (t) => {
  // It speaks for the member, as the member's reply does: another device
  // cannot post "@box finished answering · <anything>".
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const note = (messageId: string, participantId: string, extra: Record<string, unknown> = {}): ChatMessage => ({
    id: messageId, role: "system", content: "Done.", status: "done", createdAt: new Date().toISOString(),
    metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "r1", participantId, participantLabel: `@${participantId}` }, ...extra }
  } as ChatMessage);
  const write = (device: typeof h.owner, message: ChatMessage) =>
    h.write(device, { opId: id("op"), kind: "message.create", conversationId: chat, message });
  assert.equal((await write(h.owner, note("n-desk", "p-desk"))).body.results[0].status, "accepted", "the computer, for its own member");
  assert.equal((await write(h.machine, note("n-box", "p-box"))).body.results[0].status, "accepted", "the machine, for its member");
  assert.equal((await write(h.machine, note("n-forged", "p-desk"))).body.results[0].status, "rejected", "the machine, for the computer's member");
  assert.equal((await write(h.phone, note("n-phone", "p-box"))).body.results[0].status, "rejected", "a phone runs no member");
  const malformed = { ...note("n-bad", "p-desk"), metadata: { appMessageSource: "app_turn_finished_note" } } as ChatMessage;
  assert.equal((await write(h.owner, malformed)).body.results[0].status, "rejected", "a note that names no member and reply");
  const page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  assert.deepEqual(page.body.messages.map((message) => message.id), ["n-desk", "n-box"]);
});
