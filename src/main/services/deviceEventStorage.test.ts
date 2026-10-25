import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatEventLogService, createChatEventDeviceIdentity, createSignedChatEvent } from "./chatEventLog";
import { StorageService } from "./storage";
import type { ChatEventEnvelope } from "../../shared/chatEvents";

const recipient = { deviceId: "peer", channelId: "room" };
const now = "2026-09-06T00:00:00.000Z";
const identity = createChatEventDeviceIdentity(now);

test("outbox failure rolls back event and clock; retry/restart sends the identical event to every recipient", async () => {
  const db = await database();
  try {
    const before = await db.storage.getChatEventClock();
    await db.sql(`create trigger reject_outbox before insert on device_event_outbox
      begin select raise(abort, 'SQLITE_FULL injected outbox write'); end;`);
    const request = { ...action(), eventId: "stable-action", recipients: [recipient, { ...recipient, deviceId: "other" }] };
    await assert.rejects(new ChatEventLogService(db.storage).appendLocalEvent(request));
    assert.equal(await db.storage.getChatEvent(request.eventId), undefined);
    assert.deepEqual(await db.reopen().getChatEventClock(), before);
    await db.sql("drop trigger reject_outbox;");
    const first = await new ChatEventLogService(db.storage).appendLocalEvent(request);
    const restarted = db.reopen();
    const retry = await new ChatEventLogService(restarted, () => new Date(1)).appendLocalEvent(request);
    assert.deepEqual(retry.event, JSON.parse(JSON.stringify(first.event)));
    assert.equal(retry.status, "duplicate");
    const pending = await restarted.deviceEvents().listPending("room");
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((item) => item.event), [retry.event, retry.event]);
    await assert.rejects(new ChatEventLogService(restarted).appendLocalEvent({ ...request, payload: { text: "different" } }), /does not match/);
  } finally { await db.cleanup(); }
});

test("delivery is not application; one recipient ACK cannot release another's retained event", async () => {
  const db = await database();
  try {
    const event = (await new ChatEventLogService(db.storage).appendLocalEvent({
      ...action(), recipients: [recipient, { ...recipient, deviceId: "other" }]
    })).event;
    const delivery = db.storage.deviceEvents();
    await delivery.markDelivered(event.eventId, event.eventHash, recipient.deviceId, now);
    let pending = await delivery.listPending("room");
    assert.equal(pending.length, 2);
    assert.equal(pending[0].deliveredAt, now);
    const receipt = { eventId: event.eventId, eventHash: event.eventHash, outcome: "applied" as const, appliedAt: now };
    assert.equal(await delivery.acknowledge("stranger", receipt), false);
    assert.equal(await delivery.acknowledge("peer", { ...receipt, eventHash: "wrong" }), false);
    await db.sql(`create trigger reject_ack before update on device_event_outbox
      when new.acknowledged_at is not null begin select raise(abort, 'SQLITE_FULL ACK'); end;`);
    await assert.rejects(delivery.acknowledge("peer", receipt));
    assert.equal((await db.reopen().deviceEvents().listPending("room")).length, 2);
    await db.sql("drop trigger reject_ack;");
    assert.equal(await delivery.acknowledge("peer", receipt), true);
    pending = await db.reopen().deviceEvents().listPending("room");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recipient.deviceId, "other");
    assert.equal(await delivery.acknowledge("peer", receipt), true);
    assert.equal(await delivery.acknowledge("other", receipt), true);
    assert.equal((await delivery.listPending("room")).length, 0);
    assert.ok(await db.storage.getChatEvent(event.eventId), "origin history remains available beyond relay TTL for repair");
  } finally { await db.cleanup(); }
});

test("concurrent retries from separate service instances converge on one immutable event", async () => {
  const db = await database();
  try {
    await new ChatEventLogService(db.storage).getOrCreateDeviceIdentity();
    const append = db.storage.appendChatEvent.bind(db.storage);
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    db.storage.appendChatEvent = async (event, options) => {
      if (++entered <= 2) { if (entered === 2) release(); await barrier; }
      return append(event, options);
    };
    const request = { ...action(), eventId: "concurrent-retry", recipients: [recipient] };
    const [a, b] = await Promise.all([
      new ChatEventLogService(db.storage, () => new Date(1000)).appendLocalEvent(request),
      new ChatEventLogService(db.storage, () => new Date(2000)).appendLocalEvent(request)
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(a.event)), JSON.parse(JSON.stringify(b.event)));
    assert.deepEqual([a.status, b.status].sort(), ["appended", "duplicate"]);
    assert.equal((await db.storage.deviceEvents().listPending("room")).length, 1);
  } finally { await db.cleanup(); }
});

test("receive is durable before apply; gaps, broken hash chains, and failed apply receipts cannot advance the head", async () => {
  const db = await database();
  try {
    const first = incoming(1);
    const second = incoming(2, first.eventHash);
    const third = incoming(3, second.eventHash);
    await db.storage.appendChatEvent(second, { ingress: recipient });
    const inbox = db.storage.deviceEvents();
    assert.deepEqual(await inbox.ready("room"), []);
    assert.deepEqual(await inbox.gaps("room"), [{ originId: identity.originId, logScopeId: "chat", fromSeq: 1, toSeq: 1 }]);
    await assert.rejects(inbox.markApplied(second, "applied", now), /next contiguous/);
    assert.equal(await inbox.receipt(second.eventId), undefined);
    await db.storage.appendChatEvent(first, { ingress: recipient });
    assert.deepEqual((await db.reopen().deviceEvents().ready("room")).map((e) => e.eventId), [first.eventId]);
    await db.sql(`create trigger reject_apply before update on device_event_inbox
      begin select raise(abort, 'SQLITE_FULL applied receipt'); end;`);
    await assert.rejects(inbox.markApplied(first, "applied", now));
    assert.deepEqual((await inbox.ready("room")).map((e) => e.eventId), [first.eventId], "head rolled back with receipt");
    await db.sql("drop trigger reject_apply;");
    const receipt = await inbox.markApplied(first, "applied", now);
    assert.deepEqual(await inbox.markApplied(first, "superseded", "later"), receipt, "receipt is immutable on replay");
    assert.deepEqual((await inbox.ready("room")).map((e) => e.eventId), [second.eventId]);
    await inbox.markApplied(second, "superseded", now);
    const broken = { ...third, prevHash: "wrong" };
    await db.storage.appendChatEvent(broken, { ingress: recipient });
    assert.deepEqual(await inbox.ready("room"), []);
    await assert.rejects(inbox.markApplied(broken, "applied", now), /next contiguous/);
    assert.equal(await inbox.receipt(broken.eventId), undefined);
  } finally { await db.cleanup(); }
});

test("an ID collision cannot enqueue the rejected variant or create an inbox record", async () => {
  const db = await database();
  try {
    const first = incoming(1);
    await db.storage.appendChatEvent(first);
    const collision = { ...incoming(2), eventId: first.eventId };
    assert.equal((await db.storage.appendChatEvent(collision, { recipients: [recipient], ingress: recipient })).status, "conflict");
    assert.equal((await db.storage.deviceEvents().listPending("room")).length, 0);
    assert.deepEqual(await db.storage.deviceEvents().ready("room"), []);
  } finally { await db.cleanup(); }
});

test("large real-shaped actions are paged by UTF-8 bytes and a missing first ACK does not starve later actions", async () => {
  const db = await database();
  try {
    const events = Array.from({ length: 9 }, (_, i) => ({
      ...incoming(i + 1), payload: { text: "я".repeat(130_000) }
    }));
    await db.storage.appendChatEvents(events, { recipients: [recipient] });
    const queue = db.storage.deviceEvents();
    const seen: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = await queue.listPending("room", cursor);
      if (!page.length) break;
      assert.ok(page.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry.event)), 0) <= 1024 * 1024);
      seen.push(...page.map((entry) => entry.event.eventId));
      cursor = page.at(-1)!.rowId;
    }
    assert.deepEqual(seen, events.map((e) => e.eventId));
    assert.equal((await queue.pressure("room")).events, events.length);
    assert.equal((await queue.listPending("room"))[0].event.eventId, events[0].eventId, "next retry pass retains the unacknowledged first event");
    const repaired = await queue.repair("room", "peer", { originId: identity.originId, logScopeId: "chat", fromSeq: 1, toSeq: 9 });
    assert.ok(repaired.length < events.length);
    assert.ok(repaired.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0) <= 1024 * 1024);
  } finally { await db.cleanup(); }
});

test("a persisted channel's home identity cannot change after restart", async () => {
  const db = await database();
  try {
    await db.storage.deviceEvents().saveHostMachineId("room", "home");
    const restarted = db.reopen().deviceEvents();
    await restarted.saveHostMachineId("room", "home");
    await assert.rejects(restarted.saveHostMachineId("room", "different"));
    assert.equal(await db.reopen().deviceEvents().hostMachineId("room"), "home");
  } finally { await db.cleanup(); }
});

function incoming(originSeq: number, prevHash?: string): ChatEventEnvelope {
  return createSignedChatEvent(identity, { ...action(), originSeq, prevHash, createdAt: now });
}

test("queue pressure includes large referenced bodies for every pending recipient", async () => {
  const db = await database();
  try {
    const payload = await db.storage.deviceEventBlobs().prepare({ text: "x".repeat(500_000) });
    const log = new ChatEventLogService(db.storage);
    await log.appendLocalEvent({ ...action(), payload,
      recipients: [{ channelId: "room", deviceId: "first" }, { channelId: "room", deviceId: "second" }] });
    const pressure = await db.storage.deviceEvents().pressure("room");
    assert.equal(pressure.events, 1);
    assert.equal(pressure.recipients, 2);
    assert.ok(pressure.bytes > 1_000_000, "a blob manifest must not make a large delivery appear tiny");
  } finally { await db.cleanup(); }
});

test("the outbox forgets an event only when every roster machine has it, and names who is behind", async () => {
  const db = await database();
  try {
    const log = new ChatEventLogService(db.storage);
    const first = (await log.appendLocalEvent({
      ...action(), eventId: "retain-1",
      recipients: [recipient, { ...recipient, deviceId: "cloud-box" }]
    })).event;
    const second = (await log.appendLocalEvent({
      ...action(), eventId: "retain-2",
      recipients: [recipient, { ...recipient, deviceId: "cloud-box" }]
    })).event;

    const events = db.storage.deviceEvents();
    const before = await events.retention("room");
    assert.deepEqual(before.releasable, [], "nothing is releasable while both peers are behind");
    assert.deepEqual(before.pressure.map((peer) => peer.peerId).sort(), ["cloud-box", "peer"]);
    assert.match(before.warning ?? "", /not caught up/);
    assert.equal(before.truncated, false);

    // One peer applies both; the relay may well have forgotten them by now.
    for (const event of [first, second]) {
      await events.acknowledge("peer", {
        eventId: event.eventId, eventHash: event.eventHash, outcome: "applied", appliedAt: now
      });
    }
    const partial = await events.retention("room");
    assert.deepEqual(partial.releasable, [], "one machine's acknowledgement is not every machine's");
    assert.deepEqual(partial.pressure.map((peer) => peer.peerId), ["cloud-box"]);
    assert.equal(partial.pressure[0].pendingEvents, 2);
    assert.ok(partial.heldBytes > 0);

    await events.acknowledge("cloud-box", {
      eventId: first.eventId, eventHash: first.eventHash, outcome: "applied", appliedAt: now
    });
    const nearly = await events.retention("room");
    assert.deepEqual(nearly.releasable, ["retain-1"]);
    assert.deepEqual(nearly.retained, [{ eventId: "retain-2", awaiting: ["cloud-box"] }]);

    await events.acknowledge("cloud-box", {
      eventId: second.eventId, eventHash: second.eventHash, outcome: "applied", appliedAt: now
    });
    const done = await events.retention("room");
    assert.deepEqual(done.releasable.sort(), ["retain-1", "retain-2"], "with every machine caught up the emitter may forget both");
    assert.deepEqual(done.retained, []);
    assert.equal(done.warning, undefined, "with everyone caught up there is nothing to warn about");
  } finally { await db.cleanup(); }
});

function action() {
  return { conversationId: "chat", logScopeId: "chat", kind: "message.created", payload: { text: "hello" } };
}

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-device-events-"));
  const dbPath = path.join(directory, "accordagents.sqlite3");
  const storage = new StorageService({ dbPath });
  await storage.init();
  return {
    storage,
    reopen: () => new StorageService({ dbPath }),
    sql: (sql: string): Promise<void> => (storage as any).runSql(sql),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("with the hub, a device forgets its own channel events once pushed and a week old, keeping each chain's newest", async () => {
  const db = await database();
  try {
    const log = new ChatEventLogService(db.storage);
    const room = (n: number) => ({ conversationId: "c", logScopeId: `device:room-1:${JSON.stringify(["c", "actions"])}`, kind: "machine.turn.request", payload: { n } });
    const e1 = (await log.appendLocalEvent(room(1))).event;
    // A recipient on the relay still waits for this one.
    const e2 = (await log.appendLocalEvent({ ...room(2), recipients: [recipient] })).event;
    const e3 = (await log.appendLocalEvent(room(3))).event;
    const e4 = (await log.appendLocalEvent(room(4))).event;
    const relay = (await log.appendLocalEvent({ conversationId: "c", logScopeId: `device:room-2:${JSON.stringify(["c", "actions"])}`, kind: "x", payload: {} })).event;
    const relayNext = (await log.appendLocalEvent({ conversationId: "c", logScopeId: `device:room-2:${JSON.stringify(["c", "actions"])}`, kind: "x", payload: { n: 2 } })).event;
    await db.sql(`update chat_events set received_at = '2026-01-01T00:00:00.000Z';`);
    const rowid = Number((await (db.storage as any).queryJson(`select rowid from chat_events where event_id = '${e3.eventId}';`))[0].rowid);
    const origin = (await log.getOrCreateDeviceIdentity()).originId;
    const forgotten = await db.storage.deviceEvents().pruneOwnDeviceEvents(origin, { pushedThroughRowid: rowid, cutoffIso: now, scopePrefixes: ["device:room-1:"] });
    assert.equal(forgotten, 2);
    assert.equal(await db.storage.getChatEvent(e1.eventId), undefined);
    assert.ok(await db.storage.getChatEvent(e2.eventId), "a relay recipient still waits for it");
    assert.equal(await db.storage.getChatEvent(e3.eventId), undefined);
    assert.ok(await db.storage.getChatEvent(e4.eventId), "not pushed yet, and the chain's newest");
    assert.ok(await db.storage.getChatEvent(relay.eventId) && await db.storage.getChatEvent(relayNext.eventId), "a relay channel is not the hub's");
    // Young events stay whatever their state.
    assert.equal(await db.storage.deviceEvents().pruneOwnDeviceEvents(origin, { pushedThroughRowid: 1_000, cutoffIso: "2025-01-01T00:00:00.000Z", scopePrefixes: ["device:room-1:"] }), 0);
    // The next event still continues the chain.
    const e5 = (await log.appendLocalEvent(room(5))).event;
    assert.equal(e5.originSeq, 5);
    assert.equal(e5.prevHash, e4.eventHash);
  } finally { await db.cleanup(); }
});

test("a stretch the hub forgot is passed over: the chain continues after it, and what waited below it is superseded", async () => {
  const db = await database();
  try {
    const peer = createChatEventDeviceIdentity(now);
    const scope = `device:room:${JSON.stringify(["c", "terminal:r"])}`;
    const events: ChatEventEnvelope[] = [];
    let prev: string | undefined;
    for (let n = 1; n <= 4; n += 1) {
      const event = createSignedChatEvent(peer, { conversationId: "c", logScopeId: scope, kind: "machine.turn.progress.delta", payload: { n }, originSeq: n, ...(prev ? { prevHash: prev } : {}), createdAt: now });
      events.push(event);
      prev = event.eventHash;
    }
    // Received 2 and 4, never 1 and 3.
    await db.storage.appendChatEvent(events[1], { ingress: { deviceId: peer.originId, channelId: "room" } });
    await db.storage.appendChatEvent(events[3], { ingress: { deviceId: peer.originId, channelId: "room" } });
    assert.equal((await db.storage.deviceEvents().ready("room")).length, 0);
    assert.equal(await db.storage.deviceEvents().skipTo(peer.originId, scope, 3, events[2].eventHash, now), true);
    assert.equal(await db.storage.deviceEvents().appliedHead(peer.originId, scope), 3);
    assert.deepEqual((await db.storage.deviceEvents().ready("room")).map((event) => event.originSeq), [4], "the next one applies");
    assert.equal((await db.storage.deviceEvents().gaps("room")).length, 0, "and nothing waits below it");
    assert.equal(await db.storage.deviceEvents().skipTo(peer.originId, scope, 2, events[1].eventHash, now), false, "never backwards");
  } finally { await db.cleanup(); }
});

test("a body no stored event refers to is deleted after a whole look at the events; one referred to, or newer than the look, stays", async () => {
  const db = await database();
  try {
    const blobs = db.storage.deviceEventBlobs();
    const log = new ChatEventLogService(db.storage);
    const kept = await blobs.prepare({ text: "k".repeat(200_000) });
    await log.appendLocalEvent({ conversationId: "c", logScopeId: "chat-changes:c", kind: "chat.changes", payload: kept });
    for (let n = 0; n < 5; n += 1) await log.appendLocalEvent({ conversationId: "c", logScopeId: "c", kind: "message.created", payload: { n } });
    // A body fetched for an event this device never kept.
    const orphan = await blobs.prepare({ text: "o".repeat(200_000) }) as { blobHash: string };
    const t0 = Date.parse(now);
    // A few events per call: the look spans several runs.
    let result = await blobs.collectOrphans({ now: t0, graceMs: 60_000, scanRows: 2 });
    assert.equal(result.swept, false);
    const young = await blobs.prepare({ text: "y".repeat(200_000) }) as { blobHash: string };
    for (let run = 0; run < 5 && !result.swept; run += 1) result = await blobs.collectOrphans({ now: t0 + 1_000, graceMs: 60_000, scanRows: 2 });
    assert.equal(result.swept, false, "not before the grace period has passed");
    result = await blobs.collectOrphans({ now: t0 + 120_000, graceMs: 60_000, scanRows: 2 });
    assert.equal(result.swept, true);
    assert.equal(result.deleted, 1);
    const left = (await (db.storage as any).queryJson("select blob_hash as h from device_event_blobs order by h;")).map((row: { h: string }) => row.h);
    assert.ok(left.includes((kept as { blobHash: string }).blobHash), "referred to");
    assert.ok(left.includes(young.blobHash), "newer than the look");
    assert.ok(!left.includes(orphan.blobHash));
    assert.equal((await (db.storage as any).queryJson("select count(*) as n from device_event_blob_fragments where blob_hash = '" + orphan.blobHash + "';"))[0].n, 0);
    assert.deepEqual(await blobs.hydrate(kept), { text: "k".repeat(200_000) });
  } finally { await db.cleanup(); }
});
