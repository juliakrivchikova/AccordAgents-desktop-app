import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createChatEventDeviceIdentity, createSignedChatEvent } from "../main/services/chatEventLog";
import { hubCertificateCrypto, sha256Hex, signHubRequest, signHubText } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { createHubDeviceClient, enrollHubPhone, createHubDeviceIdentity, hubTurnRunId, signHubRequestWeb } from "../shared/hubDeviceClient";
import type { HubOp, HubOpsResponse } from "../shared/hubOps";
import { hubPhoneInviteSigningText, verifyHubPhoneCertificate, verifyHubPhoneEnrollment, type HubPhoneCertificate, type HubPhoneInvite, type HubRosterResponse } from "../shared/hubProtocol";
import { encodeMachineProgress } from "../shared/machineProgress";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ReviewProgress } from "../shared/types";
import { composeHub } from "./main";
import { HubWaker } from "./hubPhoneState";
import { HubRetention, HUB_RETENTION_DEFAULTS } from "./hubRetention";

type Identity = ReturnType<typeof createChatEventDeviceIdentity>;

function vapid() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
}

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-phone-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  const rings: Array<{ url: string; at: number }> = [];
  const aws: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.startsWith("https://fcm.googleapis.com/")) {
      rings.push({ url: text, at: Date.now() });
      return new Response("", { status: 201 });
    }
    aws.push({ url: text, body: String(init?.body ?? "") });
    return new Response("<StartInstancesResponse/>", { status: 200 });
  }) as typeof fetch;
  const composed = composeHub({ storage, hubId: "hub-phone-test", version: "test", keys: vapid(), log: () => undefined, fetchImpl, pushDebounceMs: 50 });
  const http = await composed.server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await composed.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (identity: Identity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const settle = async () => {
    await composed.folder.idle();
    await composed.viewsIdle();
    await composed.folder.idle();
  };
  return { dir, storage, owner, base, call, settle, rings, aws, ...composed };
}

/** The desktop invites, the phone enrolls the way the PWA does: WebCrypto. */
async function pairPhone(h: Awaited<ReturnType<typeof hub>>, scope: HubPhoneInvite["scope"] = { scope: "device" }) {
  const token = randomBytes(32).toString("base64url");
  const invite: HubPhoneInvite = {
    version: 1, inviteId: `invite-${randomBytes(8).toString("hex")}`, hubId: "hub-phone-test", issuerDeviceId: h.owner.originId,
    tokenHash: sha256Hex(token), scope, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  assert.equal((await h.call(h.owner, "PUT", "/v1/phone-invites", { invite, signature: signHubText(h.owner, hubPhoneInviteSigningText(invite)) })).status, 200);
  const identity = await createHubDeviceIdentity();
  const answer = await enrollHubPhone({ hubUrl: h.base, hubId: "hub-phone-test", token, identity, name: "iPhone" });
  const client = createHubDeviceClient({ hubUrl: h.base, identity: async () => identity });
  return { identity, client, answer, invite };
}

/** Operations a device writes, signed as the request that carries them. */
function writer(h: Awaited<ReturnType<typeof hub>>) {
  let count = 0;
  const opId = () => `op-${++count}-${randomBytes(3).toString("hex")}`;
  const write = async (identity: Identity, ...ops: HubOp[]) => {
    const answer = await h.call(identity, "POST", "/v3/ops", { ops });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await h.settle();
    return answer.body as unknown as HubOpsResponse;
  };
  return { opId, write };
}

/** The User's message as the phone writes it: its id is its operation's. */
function phoneMessage(content: string, targets: string[], extra: Partial<ChatMessage["metadata"]> = {}): ChatMessage {
  const messageId = crypto.randomUUID();
  return { id: messageId, role: "user", content, createdAt: new Date().toISOString(), status: "done",
    metadata: { appMessageSource: "mobile-relay", mobileEventId: messageId, threadId: messageId, deliveryTargets: targets, ...extra } as ChatMessage["metadata"] };
}

const machineMember: ChatParticipant = { id: "p-box", handle: "box", roleConfigId: "software-engineer", kind: "claude-code", homeMachineId: "m-1" };
const localMember: ChatParticipant = { id: "p-mac", handle: "mac", roleConfigId: "software-engineer", kind: "codex-cli" };

async function seedChat(h: Awaited<ReturnType<typeof hub>>, machine: Identity) {
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1" }
  ] });
  const ops = writer(h);
  await ops.write(h.owner, { opId: ops.opId(), kind: "conversation.create", conversationId: "chat-1",
    conversation: { title: "Work", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [machineMember, localMember] } } });
  return ops;
}

test("a phone's message is an operation the server takes once, asking a turn of each member it names", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { identity, client, answer } = await pairPhone(h);
  assert.equal(answer.deviceId, identity.deviceId);
  const message = phoneMessage("@box please look", [machineMember.id]);
  const op: HubOp = { opId: message.id, kind: "message.create", conversationId: "chat-1", message };
  const first = await client.postOps([op]);
  assert.deepEqual(first.results.map((result) => result.status), ["accepted"]);
  // The same operation again (an answer lost on the way): the same one, never a second copy.
  const again = await client.postOps([op]);
  assert.deepEqual(again.results.map((result) => result.status), ["duplicate"]);
  assert.equal(again.results[0].status === "duplicate" && first.results[0].status === "accepted" && again.results[0].seq, first.results[0].status === "accepted" && first.results[0].seq);
  await h.settle();
  const timeline = await client.getJson<{ events: Array<{ messageId: string; mobileEventId?: string; role: string; turns?: Array<{ participantId: string; runId: string; state: string }> }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  const rows = timeline.events.filter((event) => event.messageId === message.id);
  assert.equal(rows.length, 1, "one message, however often it was sent");
  assert.equal(rows[0].role, "you");
  assert.equal(rows[0].mobileEventId, message.id, "the phone's own row settles on it");
  // The turn the message asks of the member, the same id on every device.
  assert.deepEqual(rows[0].turns, [{ participantId: machineMember.id, runId: hubTurnRunId(message.id, machineMember.id), state: "requested" }]);
  assert.equal(hubTurnRunId(message.id, machineMember.id), `turn-${message.id}-${machineMember.id}`);
  // Taken by the member's own device: the page says so.
  await write(machine, { opId: opId(), kind: "turn.claim", conversationId: "chat-1", runId: hubTurnRunId(message.id, machineMember.id), messageId: message.id, participantId: machineMember.id });
  const claimed = await client.getJson<{ events: Array<{ messageId: string; turns?: Array<{ state: string }> }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(claimed.events.find((event) => event.messageId === message.id)?.turns?.map((turn) => turn.state), ["claimed"]);
  // A phone does not write a member's message, and nobody reuses its id.
  const asMember = await client.postOps([{ opId: crypto.randomUUID(), kind: "message.create", conversationId: "chat-1",
    message: { id: crypto.randomUUID(), role: "participant", participantId: machineMember.id, content: "forged", createdAt: new Date().toISOString(), status: "done" } }]);
  assert.equal(asMember.results[0].status, "rejected");
  const reused = await write(h.owner, { opId: message.id, kind: "message.create", conversationId: "chat-1", message: phoneMessage("again", []) });
  assert.equal(reused.results[0].status, "rejected");
});

test("a machine's card on the server is the phone's card: it rings once, an answer from the phone waits, and settled it leaves", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/phone-1", keys: { p256dh: "x", auth: "y" } });
  const approval: ChatAppToolApproval = {
    id: "approval-1", conversationId: "chat-1", requesterParticipantId: machineMember.id, requesterHandle: "box", requesterRoleConfigId: "software-engineer",
    toolName: "app_artifact_create", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Create a document", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), homeMachineId: "m-1"
  };
  const raise = () => write(machine, { opId: opId(), kind: "card.raise", conversationId: "chat-1", cardId: approval.id, cardKind: "permission", participantId: machineMember.id, card: { approval } });
  await raise();
  // Raised again while it waits (its device restarted): still one ring.
  await raise();
  let timeline = await client.getJson<{ cards: Array<{ id: string; kind: string; status: string; title: string; options: Array<{ id: string }> }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.kind, card.status, card.title]), [["approval-1", "permission", "pending", "Create a document"]]);
  assert.deepEqual(timeline.cards[0].options.map((option) => option.id), ["allow", "deny"]);
  const chats = await client.getJson<{ chats: Array<{ id: string; pendingCards?: Array<{ id: string }> }> }>("/v1/phone/chats");
  assert.deepEqual(chats.chats.find((chat) => chat.id === "chat-1")?.pendingCards?.map((card) => card.id), ["approval-1"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 1, "rung once for the card");
  const notices = await client.getJson<{ notices: Array<{ kind: string; conversationId: string; body: string; seq: number }>; head: number }>("/v1/phone/notices");
  assert.deepEqual(notices.notices.map((notice) => [notice.kind, notice.conversationId, notice.body]), [["approval", "chat-1", "@box is waiting for your answer."]]);
  await client.postJson("/v1/phone/seen", { through: notices.head });
  assert.deepEqual((await client.getJson<{ notices: unknown[] }>("/v1/phone/notices")).notices, [], "seen is not shown again");
  // Answered on the phone: the server holds the answer, the card waits for the machine.
  const waiting = (h.waker as unknown as { waiting: Map<string, { hubSeq: number }> }).waiting;
  assert.equal(waiting.has("m-1"), false, "nothing for the machine to do before the answer");
  const answered = await client.postOps([{ opId: crypto.randomUUID(), kind: "card.answer", conversationId: "chat-1", cardId: approval.id, answer: { approve: true } }]);
  assert.equal(answered.results[0].status, "accepted");
  await h.settle();
  // The answer is the machine's to apply: a stopped machine is woken for it.
  for (let i = 0; i < 50 && !waiting.has("m-1"); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(waiting.get("m-1")?.hubSeq, answered.results[0].status === "accepted" ? answered.results[0].seq : -1, "the answer is work for the member's machine");
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status, (card as { waiting?: boolean }).waiting, (card as { outcome?: string }).outcome]),
    [["approval-1", "answered", true, "Allowed. Waiting for it to be applied."]]);
  const listed = await client.getJson<{ chats: Array<{ id: string; pendingCards?: unknown[] }> }>("/v1/phone/chats");
  assert.deepEqual(listed.chats.find((chat) => chat.id === "chat-1")?.pendingCards, [], "nothing waits for the User any more");
  // A second answer (another device, a second tap) is refused, with its reason.
  const second = await client.postOps([{ opId: crypto.randomUUID(), kind: "card.answer", conversationId: "chat-1", cardId: approval.id, answer: { approve: false } }]);
  assert.deepEqual(second.results.map((result) => result.status === "rejected" ? result.reason : result.status), ["This card was already answered."]);
  // The machine applied it: the card leaves the phone's views.
  await write(machine, { opId: opId(), kind: "card.settle", conversationId: "chat-1", cardId: approval.id, outcome: { applied: true } });
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards, []);
});

test("a member's choice raised on the server stands under its message, and its answer is the record once settled", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const choice = { id: "choice-1", title: "Target", question: "Where should it go?", options: [{ id: "a", label: "Staging" }, { id: "b", label: "Main" }],
    recommendedOptionId: "a", status: "pending" as const };
  const asking: ChatMessage = { id: "ask-1", role: "participant", participantId: localMember.id, participantLabel: "@mac", content: "Which one?", status: "done",
    createdAt: new Date().toISOString(), metadata: { pendingChoice: choice } as ChatMessage["metadata"] };
  await write(h.owner, { opId: opId(), kind: "message.create", conversationId: "chat-1", message: asking });
  await write(h.owner, { opId: opId(), kind: "card.raise", conversationId: "chat-1", cardId: choice.id, cardKind: "choice", participantId: localMember.id, messageId: asking.id,
    card: { choice, sourceMessageId: asking.id } });
  let timeline = await client.getJson<{ cards: Array<{ id: string; kind: string; status: string; sourceMessageId?: string; requesterLabel?: string; recommendedOptionId?: string; outcome?: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.kind, card.status, card.sourceMessageId, card.requesterLabel, card.recommendedOptionId]),
    [["choice-1", "choice", "pending", "ask-1", "@mac", "a"]]);
  await client.postOps([{ opId: crypto.randomUUID(), kind: "card.answer", conversationId: "chat-1", cardId: choice.id, answer: { selectedOptionId: "b" } }]);
  await h.settle();
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status, card.outcome]), [["choice-1", "answered", "Main"]]);
  // The member's device applied it: its message says what was chosen, and the card is settled.
  await write(h.owner, { opId: opId(), kind: "message.update", conversationId: "chat-1",
    message: { ...asking, metadata: { pendingChoice: { ...choice, status: "selected", selectedOptionId: "b" } } as ChatMessage["metadata"] } });
  await write(h.owner, { opId: opId(), kind: "card.settle", conversationId: "chat-1", cardId: choice.id, outcome: { applied: true } });
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status, card.outcome]), [["choice-1", "answered", "Main"]], "the record under its message");
});

test("an approved removal on the server waits on the phone, however many cards come after it, until its device settles it", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const at = () => new Date().toISOString();
  const removal: ChatAppToolApproval = {
    id: "removal-1", conversationId: "chat-1", requesterParticipantId: machineMember.id, requesterHandle: "box", requesterRoleConfigId: "software-engineer",
    toolName: "app_participants_request_change", capability: "participants.manage", status: "pending", approvalScope: "once",
    request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: localMember.id, handle: "mac" }] },
    summary: "Remove @mac from this chat", createdAt: at(), updatedAt: at(), homeMachineId: "m-1"
  };
  await write(machine, { opId: opId(), kind: "card.raise", conversationId: "chat-1", cardId: removal.id, cardKind: "roster", participantId: machineMember.id, card: { approval: removal } });
  let timeline = await client.getJson<{ cards: Array<{ id: string; status: string; waiting?: boolean; title: string; outcome?: string; options: Array<{ label: string }> }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.title, card.options.map((option) => option.label)]),
    [["@box wants to remove @mac from this chat", ["Yes, remove @mac", "No, keep @mac in this chat"]]], "in the desktop card's words");
  await client.postOps([{ opId: crypto.randomUUID(), kind: "card.answer", conversationId: "chat-1", cardId: removal.id, answer: { approve: true } }]);
  // Many cards after it, raised and settled (a member asking permission after permission).
  for (let index = 0; index < 40; index += 1) {
    const other = { ...removal, id: `answered-${index}`, toolName: "app_artifact_create", capability: "artifacts.write" as ChatAppToolApproval["capability"],
      request: {} as ChatAppToolApproval["request"], summary: "Create a document" };
    await write(machine, { opId: opId(), kind: "card.raise", conversationId: "chat-1", cardId: other.id, cardKind: "permission", participantId: machineMember.id, card: { approval: other } },
      { opId: opId(), kind: "card.settle", conversationId: "chat-1", cardId: other.id, outcome: { withdrawn: true } });
  }
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status, card.waiting, card.title, card.outcome]),
    [["removal-1", "answered", true, "Removal approved", "Waiting for running turns to finish and for your Mac to apply it, then @mac leaves this chat."]]);
  await write(machine, { opId: opId(), kind: "card.settle", conversationId: "chat-1", cardId: removal.id, outcome: { applied: true } });
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards, [], "applied: gone from the phone");
});

test("a machine's live progress shows as the pending row with the turn it is, the reply settling it rings the phone, and an open app is not rung", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client, identity } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/phone-2", keys: { p256dh: "x", auth: "y" } });
  const asked = phoneMessage("@box go", [machineMember.id]);
  await client.postOps([{ opId: asked.id, kind: "message.create", conversationId: "chat-1", message: asked }]);
  const runId = hubTurnRunId(asked.id, machineMember.id);
  const pending: ChatMessage = { id: "bubble-1", role: "participant", participantId: machineMember.id, participantLabel: "@box", content: "", createdAt: new Date().toISOString(), status: "pending",
    metadata: { runId, sourceMessageId: asked.id } as ChatMessage["metadata"] };
  await write(machine, { opId: opId(), kind: "turn.claim", conversationId: "chat-1", runId, messageId: asked.id, participantId: machineMember.id },
    { opId: opId(), kind: "message.create", conversationId: "chat-1", message: pending });
  const progress: ReviewProgress = { runId, phase: "debate", message: "working", createdAt: new Date().toISOString(),
    agentProgress: { participantId: machineMember.id, participantLabel: "@box", state: "running", messageId: "bubble-1", partialContent: "Half of the answer" } } as ReviewProgress;
  const frame = encodeMachineProgress(undefined, progress, { conversationId: "chat-1", streamId: "stream-1", sequence: 1 });
  const progressEvent = createSignedChatEvent(machine, { conversationId: "chat-1", logScopeId: `device:rv-1:["chat-1","terminal:${runId}"]`, kind: "machine.turn.progress.delta", payload: frame, originSeq: 1, createdAt: new Date().toISOString() });
  await h.call(machine, "POST", "/v1/events", { events: [progressEvent] });
  await h.settle();
  const live = await client.getJson<{ events: Array<{ id: string; content: string; status: string; runId: string; participantId?: string; sourceMessageId?: string }> }>("/v1/phone/progress", { conversationId: "chat-1" });
  assert.deepEqual(live.events.map((event) => [event.id, event.content, event.status, event.runId, event.participantId, event.sourceMessageId]),
    [["bubble-1", "Half of the answer", "pending", runId, machineMember.id, asked.id]], "with what a Stop names its turn by");
  // The phone is looking (its wait for news is open): not rung.
  const changes = await client.getJson<{ instance: string; seq: number }>("/v1/phone/changes", { instance: "none", after: 0 });
  const waiting = client.getJson("/v1/phone/changes", { instance: changes.instance, after: changes.seq, waitMs: 3000 }, { timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(h.phone.isActive(identity.deviceId));
  await write(machine, { opId: opId(), kind: "message.update", conversationId: "chat-1", message: { ...pending, content: "The whole answer", status: "done" } });
  await waiting;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 0, "an open app shows the reply itself");
  const after = await client.getJson<{ events: unknown[] }>("/v1/phone/progress", { conversationId: "chat-1" });
  assert.deepEqual(after.events, [], "a settled reply has no live row");
  const notices = await client.getJson<{ notices: Array<{ kind: string; body: string }> }>("/v1/phone/notices");
  assert.deepEqual(notices.notices.map((notice) => [notice.kind, notice.body]), [["reply", "@box replied."]], "a notice names who, not what");
});

test("a picture the phone puts on the server is read back by its message, and a custom avatar from the catalog", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const bytes = new Uint8Array(randomBytes(500_000));
  const blob = await client.uploadBlob(bytes);
  assert.equal(blob.fragments, 2, "split as every device splits a body");
  const message = phoneMessage("", [], { imageAttachments: [{ id: "att-1", filename: "photo.png", mimeType: "image/png", sizeBytes: bytes.length, width: 10, height: 10,
    storageKey: "attachments/att-1.png", createdAt: new Date().toISOString(), hubBlob: blob }] } as unknown as Partial<ChatMessage["metadata"]>);
  assert.equal((await client.postOps([{ opId: message.id, kind: "message.create", conversationId: "chat-1", message }])).results[0].status, "accepted");
  await h.settle();
  const messageId = message.id;
  const picture = await client.getJson<{ dataBase64?: string; mimeType?: string }>("/v1/phone/attachment", { conversationId: "chat-1", messageId, attachmentId: "att-1" });
  assert.equal(picture.mimeType, "image/png");
  assert.equal(Buffer.from(picture.dataBase64 ?? "", "base64").equals(Buffer.from(bytes)), true);
  // The catalog the desktop publishes: roles, prompts, skills, avatars.
  const avatarBytes = randomBytes(2_000);
  const avatarBlob = await client.uploadBlob(new Uint8Array(avatarBytes));
  const catalog = { version: 1, publishedAt: new Date().toISOString(), roles: { "software-engineer": "Engineer" },
    prompts: [{ id: "pr-1", label: "Review", trigger: "review", body: "Please review" }],
    skills: [{ skillId: "s-1", displayName: "Ship", frontmatterName: "ship", description: "Ship it", contentHash: "h", capabilityState: "invocable", variants: [], providerKinds: ["claude-code"] }],
    avatars: { "custom:a1": { mimeType: "image/png", blob: avatarBlob } } };
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", { catalog })).status, 200);
  assert.equal((await h.call(machine, "PUT", "/v1/catalog", { catalog })).status, 403, "only the owner publishes it");
  const composer = await client.getJson<{ prompts: Array<{ trigger: string }>; skills: Array<{ frontmatterName: string }>; commands: Array<{ id: string }> }>("/v1/phone/composer", { conversationId: "chat-1", query: "", content: "@box /" });
  assert.deepEqual(composer.prompts.map((prompt) => prompt.trigger), ["review"]);
  assert.deepEqual(composer.skills.map((skill) => skill.frontmatterName), ["ship"], "a skill the target's provider runs");
  assert.deepEqual(composer.commands.map((command) => command.id), ["compact", "goal"], "one clear member: both commands");
  const codexOnly = await client.getJson<{ skills: unknown[] }>("/v1/phone/composer", { conversationId: "chat-1", query: "", content: "@mac /" });
  assert.deepEqual(codexOnly.skills, [], "not a skill another provider's member cannot run");
  const avatar = await client.getJson<{ dataBase64?: string }>("/v1/phone/avatar", { conversationId: "chat-1", avatarId: "custom:a1" });
  assert.equal(Buffer.from(avatar.dataBase64 ?? "", "base64").equals(avatarBytes), true);
  const chats = await client.getJson<{ chats: Array<{ members: Array<{ roleLabel: string }> }> }>("/v1/phone/chats");
  assert.equal(chats.chats[0].members[0].roleLabel, "Engineer", "the role's name as the desktop calls it");
});

test("the server wakes a machine that leaves a phone's message unread, at most once a while, and the phone's Wake asks it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().replaceRoster([{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1", addedAt: "" }], new Date().toISOString());
  await storage.hub().replaceMachineWake([{ machineId: "m-1", configJson: JSON.stringify({ machineId: "m-1", instanceId: "i-0123456789abcdef0", region: "us-east-1",
    credentials: { accessKeyId: "AKIAEXAMPLEEXAMPLE12", secretAccessKey: "secretsecretsecretsecretsecret", region: "us-east-1" } }) }], new Date().toISOString());
  let clock = Date.now();
  const calls: Array<{ url: string; body: string; authorization: string }> = [];
  const waker = new HubWaker({ storage, now: () => clock, fetchImpl: (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), authorization: String((init?.headers as Record<string, string>).authorization ?? "") });
    return new Response("<StartInstancesResponse/>", { status: 200 });
  }) as typeof fetch });
  // The machine last read long ago; work for it lands now.
  await storage.hub().setCursor(machine.originId, 3, new Date(clock - 3_600_000).toISOString());
  waker.noteWork("m-1", 10);
  await waker.check();
  assert.equal(calls.length, 0, "not before the machine had its chance to read it");
  clock += 31_000;
  await waker.check();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/ec2\.us-east-1\.amazonaws\.com\/$/);
  assert.match(calls[0].body, /Action=StartInstances/);
  assert.match(calls[0].body, /InstanceId\.1=i-0123456789abcdef0/);
  assert.match(calls[0].authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE12\//);
  assert.equal((await waker.status())[0].waking, true);
  clock += 60_000;
  await waker.check();
  assert.equal(calls.length, 1, "asked again only after a while");
  // The machine came up and read past the work: nothing waits for it.
  await storage.hub().setCursor(machine.originId, 12, new Date(clock).toISOString());
  await waker.check();
  assert.equal((await waker.status())[0].waking, false);
  clock += 10 * 60_000;
  const manual = await waker.wakeNow("m-1");
  assert.equal(manual.ok, true);
  assert.equal(calls.length, 2, "the phone's Wake asks at once");
  assert.equal((await waker.wakeNow("m-2")).ok, false, "a machine without a key");
});

test("a phone's message for a machine member that is not reading makes the server wake it", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const message = phoneMessage("@box go", [machineMember.id]);
  await client.postOps([{ opId: message.id, kind: "message.create", conversationId: "chat-1", message }]);
  await h.settle();
  // Work is noted for the machine's home (no key here: nothing is asked of AWS).
  const status = await client.getJson<{ machines: Array<{ machineId: string; canWake: boolean }> }>("/v1/phone/machines");
  assert.deepEqual(status.machines.map((item) => [item.machineId, item.canWake]), [["m-1", false]]);
  const wake = await client.postJson<{ started: boolean; message: string }>("/v1/phone/wake", { machineId: "m-1" });
  assert.equal(wake.started, false);
  assert.match(wake.message, /no key/);
});

test("a desktop's card for its own member rings once however often it is raised, and a phone can neither raise one for a member nor post progress, which a machine can", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client, identity } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/phone-3", keys: { p256dh: "x", auth: "y" } });
  const approval: ChatAppToolApproval = {
    id: "approval-local", conversationId: "chat-1", requesterParticipantId: localMember.id, requesterHandle: "mac", requesterRoleConfigId: "software-engineer",
    toolName: "app_artifact_create", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Create a document", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const raise = (card: ChatAppToolApproval) => ({ opId: opId(), kind: "card.raise" as const, conversationId: "chat-1", cardId: card.id, cardKind: "permission" as const, participantId: localMember.id, card: { approval: card } });
  await write(h.owner, raise(approval));
  // The desktop restarted and raised the same waiting card again.
  await write(h.owner, raise({ ...approval }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  let timeline = await client.getJson<{ cards: Array<{ id: string; status: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((card) => [card.id, card.status]), [["approval-local", "pending"]]);
  assert.equal(h.rings.length, 1, "one ring for one waiting card");
  // Answered on the desktop and applied there: gone from the phone.
  await write(h.owner, { opId: opId(), kind: "card.answer", conversationId: "chat-1", cardId: approval.id, answer: { approve: true } },
    { opId: opId(), kind: "card.settle", conversationId: "chat-1", cardId: approval.id, outcome: { applied: true } });
  timeline = await client.getJson("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards, [], "answered on the desktop: gone from the phone");
  // A phone writes messages, answers and Stops: not a member's card.
  const forged = await client.postOps([raise({ ...approval, id: "approval-forged" })]);
  assert.deepEqual(forged.results.map((result) => result.status === "rejected" ? result.reason : result.status), ["Only the device this member runs on raises its cards."]);
  // Live progress is posted by the devices members run on, the computer and
  // the machines (and is never stored); a phone runs nothing.
  assert.equal((await h.call(machine, "POST", "/v1/progress", { frames: [] })).status, 200);
  const phoneProgress = await fetch(`${h.base}/v1/progress`, { method: "POST", headers: { "content-type": "application/json",
    authorization: await signHubRequestWeb(identity, { method: "POST", pathWithQuery: "/v1/progress", body: "{\"frames\":[]}" }) }, body: "{\"frames\":[]}" });
  assert.equal(phoneProgress.status, 403);
});

test("a desktop member's live progress reaches the phone by a post the server keeps only in memory", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client } = await pairPhone(h);
  const runId = "turn-run-local-1";
  const pending: ChatMessage = { id: "bubble-local", role: "participant", participantId: localMember.id, participantLabel: "@mac", content: "", createdAt: new Date().toISOString(), status: "pending", metadata: { runId } as ChatMessage["metadata"] };
  await write(h.owner, { opId: opId(), kind: "message.create", conversationId: "chat-1", message: pending });
  const before = await h.storage.hubOps().head();
  const progress: ReviewProgress = { runId, phase: "debate", message: "working", createdAt: new Date().toISOString(),
    agentProgress: { participantId: localMember.id, participantLabel: "@mac", state: "running", messageId: "bubble-local", partialContent: "Привет, half done 👋" } } as ReviewProgress;
  const frame = encodeMachineProgress(undefined, progress, { conversationId: "chat-1", streamId: "stream-local", sequence: 1 });
  assert.equal((await h.call(h.owner, "POST", "/v1/progress", { frames: [frame] })).status, 200);
  const live = await client.getJson<{ events: Array<{ id: string; content: string }> }>("/v1/phone/progress", { conversationId: "chat-1" });
  assert.deepEqual(live.events.map((event) => [event.id, event.content]), [["bubble-local", "Привет, half done 👋"]]);
  assert.equal(await h.storage.hubOps().head(), before, "nothing of it went into the order");
});

test("a certificate is refused when anything in it was changed, or its owner is not the issuer", async (t) => {
  const h = await hub(t);
  const { answer } = await pairPhone(h);
  const check = (certificate: HubPhoneCertificate, issuer: Identity = h.owner) =>
    verifyHubPhoneCertificate(certificate, { issuerDeviceId: issuer.originId, issuerPublicKeyDerBase64: issuer.publicKeyDerBase64, ...hubCertificateCrypto });
  const certificate = answer.certificate as HubPhoneCertificate;
  assert.equal(check(certificate), true);
  assert.equal(check({ ...certificate, invite: { ...certificate.invite, name: "Other" } }), false, "an invite changed after the owner signed it");
  assert.equal(check({ ...certificate, token: randomBytes(32).toString("base64url") }), false, "a token that is not the invite's");
  assert.equal(check({ ...certificate, enrollment: { ...certificate.enrollment, enrolledAt: "2000-01-01T00:00:00.000Z" } }), false, "an enrollment changed after the phone signed it");
  const other = await createHubDeviceIdentity();
  assert.equal(check({ ...certificate, enrollment: { ...certificate.enrollment, deviceId: other.deviceId, publicKeyDerBase64: other.publicKeyDerBase64 } }), false, "another key under the same signature");
  assert.equal(check(certificate, createChatEventDeviceIdentity(new Date().toISOString())), false, "not this owner's invite");
});

test("the owner learns a phone that enrolled from the roster, with what it enrolled with, and checks it with its own key", async (t) => {
  const h = await hub(t);
  const { identity, invite } = await pairPhone(h);
  const roster = (await h.call(h.owner, "GET", "/v1/roster")).body as unknown as HubRosterResponse;
  const phone = roster.devices.find((device) => device.deviceId === identity.deviceId);
  assert.equal(phone?.role, "phone");
  assert.equal(phone?.inviteId, invite.inviteId);
  const record = roster.enrollments?.find((item) => item.deviceId === identity.deviceId);
  assert.ok(record, "the roster says what the phone enrolled with");
  const check = (value: unknown, issuer: Identity = h.owner) =>
    verifyHubPhoneEnrollment(value, { issuerDeviceId: issuer.originId, issuerPublicKeyDerBase64: issuer.publicKeyDerBase64, ...hubCertificateCrypto });
  assert.equal(check(record), true, "this owner's invite, accepted with the phone's own key");
  assert.equal(record!.enrollment.publicKeyDerBase64, identity.publicKeyDerBase64);
  assert.equal(check({ ...record!, invite: { ...record!.invite, scope: { scope: "conversation", conversationId: "chat-x" } } }), false, "an invite changed after the owner signed it");
  const other = await createHubDeviceIdentity();
  assert.equal(check({ ...record!, enrollment: { ...record!.enrollment, deviceId: other.deviceId, publicKeyDerBase64: other.publicKeyDerBase64 } }), false, "another key");
  assert.equal(check(record, createChatEventDeviceIdentity(new Date().toISOString())), false, "not this owner's invite");
  // Only the owner reads the roster.
  assert.equal((await fetch(`${h.base}/v1/roster`, { headers: { authorization: await signHubRequestWeb(identity, { method: "GET", pathWithQuery: "/v1/roster" }) } })).status, 403);
  // The owner's next roster keeps the phone while its invite is not settled, and names it once it is.
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" }] });
  assert.ok((await h.storage.hub().devices()).some((device) => device.deviceId === identity.deviceId), "not dropped by a roster that does not name it yet");
});

test("words in any script reach the server as the phone wrote them, and a removed phone is told so", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { identity, client } = await pairPhone(h);
  const content = "Привет, @box 👋 second line — «quotes» 漢字";
  const message = phoneMessage(content, [machineMember.id]);
  assert.deepEqual((await client.postOps([{ opId: message.id, kind: "message.create", conversationId: "chat-1", message }])).results.map((result) => result.status), ["accepted"]);
  await h.settle();
  const timeline = await client.getJson<{ events: Array<{ messageId: string; content: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.equal(timeline.events.find((event) => event.messageId === message.id)?.content, content);
  // An app from before (a mailbox token) is told it was removed.
  const old = await fetch(`${h.base}/v1/phone/chats`, { headers: { authorization: "Bearer old-mailbox-token" } });
  assert.equal(old.status, 401);
  assert.equal((await old.json() as { error: string }).error, "phone_revoked");
  // Off the roster: said as such (the phone asks to be paired again).
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" }],
    resolvedInviteIds: [(await h.storage.hub().devices()).find((device) => device.deviceId === identity.deviceId)!.inviteId!] });
  await assert.rejects(client.getJson("/v1/phone/chats"), (error: { status?: number; body?: string }) => error.status === 401 && String(error.body).includes("not on the hub's roster"));
  await assert.rejects(client.postOps([{ opId: crypto.randomUUID(), kind: "message.create", conversationId: "chat-1", message: phoneMessage("still here?", []) }]),
    (error: { status?: number }) => error.status === 401, "and writes nothing");
});

test("the server gives up starting a machine that does not read its work after a few tries", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-wake-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().replaceRoster([{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1", addedAt: "" }], new Date().toISOString());
  await storage.hub().replaceMachineWake([{ machineId: "m-1", configJson: JSON.stringify({ machineId: "m-1", instanceId: "i-0123456789abcdef0", region: "us-east-1",
    credentials: { accessKeyId: "AKIAEXAMPLEEXAMPLE12", secretAccessKey: "secretsecretsecretsecretsecret", region: "us-east-1" } }) }], new Date().toISOString());
  let clock = Date.now();
  let calls = 0;
  const waker = new HubWaker({ storage, now: () => clock, fetchImpl: (async () => { calls += 1; return new Response("<StartInstancesResponse/>", { status: 200 }); }) as unknown as typeof fetch });
  await storage.hub().setCursor(machine.originId, 3, new Date(clock - 3_600_000).toISOString());
  waker.noteWork("m-1", 10);
  for (let round = 0; round < 8; round += 1) {
    clock += 6 * 60_000;
    await waker.check();
  }
  assert.equal(calls, 3, "three starts for the same unread work, then no more");
  assert.equal((await waker.status())[0].waking, false);
});

test("a phone paired again is rung once, under its new key", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const first = await pairPhone(h);
  const second = await pairPhone(h);
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/same-browser", keys: { p256dh: "x", auth: "y" } };
  await first.client.registerPushSubscription(subscription);
  await second.client.registerPushSubscription(subscription);
  const held = (await h.storage.hub().pushSubscriptions()).filter((item) => item.endpoint === subscription.endpoint);
  assert.deepEqual(held.map((item) => item.deviceId), [second.identity.deviceId]);
});

test("after a restart the server rings a phone for what it missed, not again for what it was rung for", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await seedChat(h, machine);
  const { client, identity } = await pairPhone(h);
  await client.registerPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/restart", keys: { p256dh: "x", auth: "y" } });
  const notice = { conversationId: "chat-1", kind: "reply" as const, title: "Work", body: "@box replied.", createdAt: new Date().toISOString() };
  const first = await h.storage.hub().addNotice(notice);
  await h.push.noteNotice({ seq: first, conversationId: "chat-1" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 1);
  // The program stops before it rings for the next one.
  await h.storage.hub().addNotice(notice);
  await h.push.rearm();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 2, "rung for the one it missed");
  await h.push.rearm();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rings.length, 2, "and not again");
  assert.equal(await h.storage.hub().phoneRungNotice(identity.deviceId), first + 1);
});

test("under retention a phone holds nothing back, and its pictures, avatars and cards stay", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const { opId, write } = await seedChat(h, machine);
  const { client } = await pairPhone(h);
  // A picture the phone sends, and one it put up but never sent.
  const picture = new Uint8Array(randomBytes(2_000));
  const pictureBlob = await client.uploadBlob(picture);
  const stray = await client.uploadBlob(new Uint8Array(randomBytes(1_500)));
  const sent = phoneMessage("look", [machineMember.id], { imageAttachments: [{ id: "att-r", filename: "p.png", mimeType: "image/png", sizeBytes: picture.length, width: 1, height: 1,
    storageKey: "attachments/att-r.png", createdAt: new Date().toISOString(), hubBlob: pictureBlob }] } as unknown as Partial<ChatMessage["metadata"]>);
  const second = phoneMessage("and this", []);
  assert.deepEqual((await client.postOps([
    { opId: sent.id, kind: "message.create", conversationId: "chat-1", message: sent },
    { opId: second.id, kind: "message.create", conversationId: "chat-1", message: second }
  ])).results.map((result) => result.status), ["accepted", "accepted"]);
  // A desktop's card for its own member, and the catalog with an avatar.
  const avatarBlob = await client.uploadBlob(new Uint8Array(randomBytes(1_000)));
  await h.call(h.owner, "PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: {}, prompts: [], skills: [], avatars: { "custom:a": { mimeType: "image/png", blob: avatarBlob } } } });
  const approval: ChatAppToolApproval = {
    id: "approval-old", conversationId: "chat-1", requesterParticipantId: localMember.id, requesterHandle: "mac", requesterRoleConfigId: "software-engineer",
    toolName: "Bash", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
    summary: "Run", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await write(h.owner, { opId: opId(), kind: "card.raise", conversationId: "chat-1", cardId: approval.id, cardKind: "permission", participantId: localMember.id, card: { approval } });
  // Every reader (the computer, the machine) read everything; the phone never reads the feed.
  const head = await h.storage.hubOps().head();
  await h.call(h.owner, "GET", `/v3/feed?after=${head}`);
  await h.call(machine, "GET", `/v3/feed?after=${head}`);
  const later = 40 * 24 * 60 * 60_000;
  const retention = new HubRetention({ storage: h.storage, config: { ...HUB_RETENTION_DEFAULTS, batch: 50 }, now: () => Date.now() + later });
  const report = await retention.runOnce();
  assert.ok(report.ops.events >= 3, "what every reader read is forgotten: a phone does not hold the feed back");
  await retention.runOnce();
  await retention.runOnce();
  // The card is still shown; the picture, the avatar stay; the stray goes.
  const timeline = await client.getJson<{ cards: Array<{ id: string }> }>("/v1/phone/timeline", { conversationId: "chat-1" });
  assert.deepEqual(timeline.cards.map((item) => item.id), ["approval-old"]);
  const shown = await client.getJson<{ dataBase64?: string }>("/v1/phone/attachment", { conversationId: "chat-1", messageId: sent.id, attachmentId: "att-r" });
  assert.equal(Buffer.from(shown.dataBase64 ?? "", "base64").equals(Buffer.from(picture)), true, "the picture a message names stays");
  const avatar = await client.getJson<{ dataBase64?: string }>("/v1/phone/avatar", { conversationId: "chat-1", avatarId: "custom:a" });
  assert.ok(avatar.dataBase64, "the catalog's avatar stays");
  assert.ok(stray.blobHash, "a body nothing names is the sweep's (see the next test)");
  // The phone keeps writing after what was forgotten.
  const third = phoneMessage("back again", []);
  assert.deepEqual((await client.postOps([{ opId: third.id, kind: "message.create", conversationId: "chat-1", message: third }])).results.map((result) => result.status), ["accepted"]);
});

test("a phone's picture put up before its message arrives is kept for a month, then let go", async (t) => {
  const h = await hub(t);
  const { client } = await pairPhone(h);
  const early = await client.uploadBlob(new Uint8Array(randomBytes(1_200)));
  const blobs = h.storage.deviceEventBlobs();
  const sweep = (afterMs: number) => blobs.collectOrphans({ now: Date.now() + afterMs, graceMs: 60 * 60_000, scanRows: 50_000 });
  await sweep(2 * 60 * 60_000);
  await sweep(4 * 60 * 60_000);
  assert.equal((await sweep(6 * 60 * 60_000)).deleted, 0, "a day later it is still there");
  // A sweep is a look at everything, then a deletion a while later.
  const deleted = (await sweep(31 * 24 * 60 * 60_000)).deleted + (await sweep(32 * 24 * 60 * 60_000)).deleted + (await sweep(33 * 24 * 60 * 60_000)).deleted;
  assert.equal(deleted, 1, "a month later, never named, it goes");
  assert.ok(early.blobHash);
});
