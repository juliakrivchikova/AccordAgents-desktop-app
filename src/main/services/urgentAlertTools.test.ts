import assert from "node:assert/strict";
import test from "node:test";
import type { HubAlertRequest, HubAlertResult, UrgentAlertRaised, UrgentAlertView } from "../../shared/urgentAlerts";
import { URGENT_ALERT_SERVER_TOO_OLD } from "../../shared/urgentAlerts";
import { UrgentAlertOutbox, urgentAlertCardMessageId, type UrgentAlertCardHost, type UrgentAlertServerAccess } from "./urgentAlertTools";

const actor = { conversationId: "chat-1", participantId: "member-1" };
const cardId = (requestId: string) => urgentAlertCardMessageId(actor.conversationId, actor.participantId, requestId);

type Answer = HubAlertResult<unknown> | "throw" | (() => Promise<HubAlertResult<unknown>>);

/** The server as the outbox reaches it: raises and closes answered in
 *  order (the last answer repeats). */
function server(raises: Answer[], closes: Answer[] = [{ ok: true, value: {} }]) {
  const requests: HubAlertRequest[] = [];
  const next = { raise: 0, close: 0 };
  const answer = async (list: Answer[], kind: "raise" | "close") => {
    const picked = list[Math.min(next[kind], list.length - 1)]!;
    next[kind] += 1;
    if (picked === "throw") throw new Error("socket hang up");
    return typeof picked === "function" ? await picked() : picked;
  };
  const access: UrgentAlertServerAccess = {
    async alerts<T>(request: HubAlertRequest): Promise<HubAlertResult<T>> {
      requests.push(request);
      return await answer(request.action === "close" ? closes : raises, request.action === "close" ? "close" : "raise") as HubAlertResult<T>;
    }
  };
  return {
    access, requests,
    raises: () => requests.filter((request) => request.action === "raise"),
    closes: () => requests.filter((request) => request.action === "close")
  };
}

/** The chat as the outbox sees it: this computer's cards and the server's. */
function cards() {
  const messages = new Map<string, { text: string; alert: UrgentAlertView; server: boolean }>();
  const removed: string[] = [];
  const host: UrgentAlertCardHost = {
    async show(card) {
      const current = messages.get(card.messageId);
      if (current?.server) return "server";
      if (current?.alert.state === "acknowledged") return "answered";
      messages.set(card.messageId, { text: card.text, alert: card.alert, server: false });
      return "shown";
    },
    async update(_conversationId, messageId, change) {
      const card = messages.get(messageId);
      if (!card || card.server) return undefined;
      card.alert = change(card.alert);
      return card.alert;
    },
    async remove(_conversationId, messageId) {
      removed.push(messageId);
      if (!messages.get(messageId)?.server) messages.delete(messageId);
    },
    async alertOf(_conversationId, messageId) {
      return messages.get(messageId)?.alert;
    }
  };
  /** The server's card arrives through the feed under the same id. */
  const arrive = (messageId: string, alert: UrgentAlertView) => messages.set(messageId, { text: "", alert, server: true });
  return { host, messages, removed, arrive };
}

function store(initial?: string) {
  const box = { value: initial };
  return { box, store: { read: async () => box.value, write: async (value: string) => { box.value = value; } } };
}

function kept(box: { value?: string }): Array<{ requestId: string; stage: string; serverAlertId?: string; refusals: number }> {
  return box.value ? (JSON.parse(box.value) as { alerts: [] }).alerts : [];
}

const unreachable: HubAlertResult<unknown> = { ok: false, error: { code: "server_unavailable", message: "Your server could not be reached (fetch failed)." } };
const notInChat: HubAlertResult<unknown> = { ok: false, error: { code: "access_denied", message: "This member is not in the chat." } };

function raisedFor(requestId: string, overrides: Partial<UrgentAlertRaised> = {}): HubAlertResult<unknown> {
  return { ok: true, value: { alertId: "server-alert-1", messageId: cardId(requestId), state: "not_set_up", telegram: false, phone: false, ...overrides } };
}

function serverView(state: UrgentAlertView["state"], id = "server-alert-1"): UrgentAlertView {
  return { id, state, createdAt: "2026-11-27T10:00:00.000Z", calls: [], phone: true, callMode: "keypad" };
}

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the card's message id is the same on the device and the server, and differs per alert", () => {
  const id = urgentAlertCardMessageId("chat-1", "member-1", "req-1");
  assert.equal(id, urgentAlertCardMessageId("chat-1", "member-1", "req-1"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, urgentAlertCardMessageId("chat-1", "member-1", "req-2"));
  assert.notEqual(id, urgentAlertCardMessageId("chat-1", "member-2", "req-1"));
  assert.notEqual(id, urgentAlertCardMessageId("chat-2", "member-1", "req-1"));
});

test("the server takes it: no card here, the note says what went out, nothing is kept", async () => {
  const s = server([raisedFor("req-1", { state: "waiting", telegram: true, phone: true })]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined });
  const result = await outbox.raise(actor, { message: "  Production is down  ", requestId: "req-1" }) as { ok: boolean; note: string };
  assert.equal(result.ok, true);
  assert.match(result.note, /Telegram/);
  assert.match(result.note, /phone rings/);
  assert.equal(c.messages.size, 0);
  assert.equal((s.raises()[0] as { text: string }).text, "Production is down", "trimmed");
  assert.deepEqual(kept(k.box), []);
});

test("an empty or too long message is refused at once, server or not, and shows nothing", async () => {
  const s = server([unreachable]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined });
  assert.equal((await outbox.raise(actor, { message: "   " }) as { error: { code: string } }).error.code, "invalid_request");
  assert.equal((await outbox.raise(actor, { message: "x".repeat(1001) }) as { error: { code: string } }).error.code, "invalid_request");
  assert.equal(s.requests.length, 0);
  assert.equal(c.messages.size, 0);
});

test("the server cannot be reached: the card stands here at once; the alert goes there once it can, and is let go when the server's card arrives", async () => {
  const s = server([unreachable, "throw", raisedFor("req-1")]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; value: UrgentAlertRaised; note: string };
  assert.equal(result.ok, true, "it reached her, as a card");
  assert.equal(result.value.state, "unsent");
  assert.match(result.note, /red card in this chat on her computer/);
  assert.match(result.note, /Telegram and calls go out only once her server takes it/);
  assert.equal(result.value.messageId, cardId("req-1"));
  const card = c.messages.get(cardId("req-1"))!;
  assert.equal(card.alert.state, "unsent");
  assert.deepEqual(card.alert.unsent, { reason: "unreachable", retrying: true });
  assert.ok(card.alert.id.startsWith("unsent-"));
  assert.deepEqual(kept(k.box).map((item) => item.stage), ["waiting"], "kept across a restart");
  await until(() => s.raises().length >= 3);
  await until(() => kept(k.box)[0]?.stage === "reached");
  assert.deepEqual(s.raises().map((request) => (request as { requestId: string }).requestId), ["req-1", "req-1", "req-1"], "never under another request id");
  assert.equal(kept(k.box)[0]?.serverAlertId, "server-alert-1");
  assert.deepEqual(c.removed, [], "the server's card carries the same id and takes this one's place itself");
  await outbox.serverCardArrived(actor.conversationId, cardId("req-1"), serverView("not_set_up"));
  assert.deepEqual(kept(k.box), []);
  outbox.stop();
});

test("a server older than urgent alerts: the card says so, and the alert waits for it to update", async () => {
  const s = server([{ ok: false, error: { code: "server_unavailable", message: URGENT_ALERT_SERVER_TOO_OLD } }]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  await outbox.raise(actor, { message: "Production is down", requestId: "req-1" });
  assert.deepEqual(c.messages.get(cardId("req-1"))!.alert.unsent, { reason: "outdated", retrying: true });
  outbox.stop();
});

test("a server older than this change writes its card under another id: this card comes down, so one card stands", async () => {
  const s = server([unreachable, raisedFor("req-1", { messageId: "random-server-id" })]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 20 });
  await outbox.raise(actor, { message: "Production is down", requestId: "req-1" });
  assert.ok(c.messages.has(cardId("req-1")));
  await until(() => c.removed.includes(cardId("req-1")));
  assert.equal(c.messages.size, 0);
  assert.deepEqual(kept(k.box), []);
  outbox.stop();
});

test("Got it on the card here: it never goes out, the card folds as Got it in the app, and the member's repeated call does not send it", async () => {
  const s = server([unreachable]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  const closed = await outbox.close({ alertId: result.value.alertId });
  assert.ok(closed && "handled" in closed && closed.handled.ok);
  const view = (closed as { handled: { ok: true; value: UrgentAlertView } }).handled.value;
  assert.equal(view.state, "acknowledged");
  assert.equal(view.ackSource, "app");
  assert.ok(view.closedAt);
  assert.equal(view.unsent?.retrying, false);
  const raisesAtClose = s.raises().length;
  await pause(120);
  assert.equal(s.raises().length, raisesAtClose, "not raised on the server any more");
  assert.deepEqual(kept(k.box).map((item) => item.stage), ["closed"]);
  const again = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised; note: string };
  assert.equal(again.value.state, "acknowledged");
  assert.match(again.note, /already pressed Got it/);
  assert.equal(s.raises().length, raisesAtClose, "the repeated call does not reach the server");
  assert.equal(c.messages.get(cardId("req-1"))!.alert.state, "acknowledged", "the card stays as she left it");
  assert.equal(await outbox.close({ alertId: "server-alert-uuid" }), undefined, "a server's card is closed there");
  outbox.stop();
});

test("Got it on one card while another alert is being raised: the one she answered is not raised in that pass", async () => {
  let letThrough!: () => void;
  const slowFirst = () => new Promise<HubAlertResult<unknown>>((resolve) => { letThrough = () => resolve(raisedFor("req-a")); });
  const s = server([unreachable, unreachable, slowFirst, raisedFor("req-b")]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 20 });
  await outbox.raise(actor, { message: "A down", requestId: "req-a" });
  const b = await outbox.raise(actor, { message: "B down", requestId: "req-b" }) as { value: UrgentAlertRaised };
  await until(() => s.raises().length === 3);
  await outbox.close({ alertId: b.value.alertId });
  letThrough();
  await pause(150);
  assert.deepEqual(s.raises().map((request) => (request as { requestId: string }).requestId).filter((id) => id === "req-b"), ["req-b"], "B was raised only by the member's own call");
  outbox.stop();
});

test("Got it while the raise is on its way: once it lands it is closed there too, tried again until the server confirms", async () => {
  let letThrough!: () => void;
  const s = server([unreachable, () => new Promise((resolve) => { letThrough = () => resolve(raisedFor("req-1")); })], [unreachable, { ok: true, value: {} }]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  await until(() => s.raises().length === 2);
  await outbox.close({ alertId: result.value.alertId });
  letThrough();
  await until(() => s.closes().length >= 2);
  assert.deepEqual(s.closes()[0], { action: "close", alertId: "server-alert-1" });
  await until(() => kept(k.box).length === 0);
  outbox.stop();
});

test("a raise that timed out did land: Got it here before the next try still closes it once its card arrives", async () => {
  const s = server([unreachable]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  await outbox.close({ alertId: result.value.alertId });
  // The server had taken it after all: its card comes through the feed, waiting.
  c.arrive(cardId("req-1"), serverView("waiting", "server-alert-7"));
  await outbox.serverCardArrived(actor.conversationId, cardId("req-1"), serverView("waiting", "server-alert-7"));
  assert.deepEqual(s.closes(), [{ action: "close", alertId: "server-alert-7" }]);
  assert.deepEqual(kept(k.box), []);
  outbox.stop();
});

test("Got it here, and the server's card that arrives says it never left the app either: it is closed there too, so her Got it stands", async () => {
  const s = server([unreachable]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  await outbox.close({ alertId: result.value.alertId });
  await outbox.serverCardArrived(actor.conversationId, cardId("req-1"), serverView("not_set_up", "server-alert-8"));
  assert.deepEqual(s.closes(), [{ action: "close", alertId: "server-alert-8" }]);
  outbox.stop();
});

test("Got it folds the card at once even when the server's alert cannot be closed now; the close is tried again later", async () => {
  const k = store();
  const c = cards();
  const first = new UrgentAlertOutbox({ access: () => server([unreachable]).access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  const result = await first.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  first.stop();
  const s = server([raisedFor("req-1")], [() => new Promise(() => undefined)]);
  const second = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000, raiseTimeoutMs: 60_000 });
  await second.retryDue();
  const started = Date.now();
  const closed = await second.close({ alertId: result.value.alertId });
  assert.ok(Date.now() - started < 1_000, "not held by the server");
  assert.ok(closed && "handled" in closed && closed.handled.ok);
  assert.deepEqual(kept(k.box).map((item) => item.stage), ["closed"], "kept until the server confirms");
  second.stop();
});

test("Got it after a restart on a card the server took meanwhile (its card not arrived yet) closes the server's alert", async () => {
  const k = store();
  const c = cards();
  const first = new UrgentAlertOutbox({ access: () => server([unreachable]).access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  const result = await first.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  first.stop();
  const s = server([raisedFor("req-1")]);
  const second = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  await second.retryDue();
  assert.equal(kept(k.box)[0]?.stage, "reached");
  second.stop();
  const third = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  const closed = await third.close({ alertId: result.value.alertId });
  assert.ok(closed && "handled" in closed && closed.handled.ok);
  await until(() => kept(k.box).length === 0);
  assert.deepEqual(s.closes(), [{ action: "close", alertId: "server-alert-1" }]);
  third.stop();
});

test("Got it on a card nothing was kept for (the store was lost) still folds it; on a card the server's took over it goes there", async () => {
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => server([unreachable]).access, store: store().store, cards: c.host, log: () => undefined, retryMs: 60_000 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  const fresh = new UrgentAlertOutbox({ access: () => undefined, store: store().store, cards: c.host, log: () => undefined });
  const closed = await fresh.close({ alertId: result.value.alertId, conversationId: actor.conversationId, messageId: cardId("req-1") });
  assert.ok(closed && "handled" in closed && closed.handled.ok);
  assert.equal(c.messages.get(cardId("req-1"))!.alert.state, "acknowledged");
  const other = await outbox.raise(actor, { message: "Disk full", requestId: "req-2" }) as { value: UrgentAlertRaised };
  c.arrive(cardId("req-2"), serverView("waiting", "server-alert-2"));
  assert.deepEqual(await fresh.close({ alertId: other.value.alertId, conversationId: actor.conversationId, messageId: cardId("req-2") }), { forwardTo: "server-alert-2" });
  outbox.stop();
});

test("the server refuses (a member or chat it does not know yet): asked again for a while, then the card says it did not take it", async () => {
  const s = server([notInChat]);
  const c = cards();
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: c.host, log: () => undefined, retryMs: 5 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; note: string };
  assert.equal(result.ok, true);
  assert.match(result.note, /keeps raising it there/);
  await until(() => c.messages.get(cardId("req-1"))!.alert.unsent?.retrying === false, 5_000);
  assert.deepEqual(c.messages.get(cardId("req-1"))!.alert.unsent, { reason: "refused", message: "This member is not in the chat.", retrying: false });
  const asked = s.raises().length;
  assert.equal(asked, 20);
  await pause(60);
  assert.equal(s.raises().length, asked, "not asked again");
  assert.deepEqual(kept(k.box), []);
  outbox.stop();
});

test("a refusal that clears (the roster caught up) lets the alert go out", async () => {
  const s = server([notInChat, notInChat, raisedFor("req-1")]);
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: cards().host, log: () => undefined, retryMs: 20 });
  await outbox.raise(actor, { message: "Production is down", requestId: "req-1" });
  await until(() => kept(k.box)[0]?.stage === "reached");
  assert.equal(s.raises().length, 3);
  outbox.stop();
});

test("not linked yet (no access): the card stands and the alert waits for the link", async () => {
  let linked: UrgentAlertServerAccess | undefined;
  const s = server([raisedFor("req-1")]);
  const outbox = new UrgentAlertOutbox({ access: () => linked, store: store().store, cards: cards().host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  assert.equal(result.value.state, "unsent");
  linked = s.access;
  await until(() => s.raises().length === 1);
  outbox.stop();
});

test("a machine shows nothing of its own: the member hears nothing may have reached User yet, and it is raised until her server takes it", async () => {
  const s = server([unreachable, unreachable, raisedFor("req-1")]);
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "server_unavailable");
  assert.match(result.error.message, /nothing may have reached her yet/);
  await until(() => kept(k.box)[0]?.stage === "reached");
  await outbox.serverCardArrived(actor.conversationId, cardId("req-1"), serverView("not_set_up"));
  assert.deepEqual(kept(k.box), []);
  outbox.stop();
});

test("a machine whose alert the server keeps refusing lets it go in the end", async () => {
  const s = server([notInChat]);
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, log: () => undefined, retryMs: 5 });
  await outbox.raise(actor, { message: "Production is down", requestId: "req-1" });
  await until(() => s.raises().length === 20, 5_000);
  await until(() => kept(k.box).length === 0);
  outbox.stop();
});

test("after a restart the kept alert goes out", async () => {
  const k = store();
  const first = new UrgentAlertOutbox({ access: () => server([unreachable]).access, store: k.store, cards: cards().host, log: () => undefined, retryMs: 60_000 });
  await first.raise(actor, { message: "Production is down", requestId: "req-1" });
  first.stop();
  const s = server([raisedFor("req-1")]);
  const second = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: cards().host, log: () => undefined, retryMs: 20 });
  second.start();
  await until(() => s.raises().length === 1);
  assert.equal((s.raises()[0] as { text: string }).text, "Production is down");
  await until(() => kept(k.box)[0]?.stage === "reached");
  second.stop();
});

test("a timeout is not an answer: the member is told it may have gone out, and a retry finds the alert the server did take", async () => {
  const s = server([() => new Promise(() => undefined), raisedFor("req-1")]);
  const outbox = new UrgentAlertOutbox({ access: () => ({ alerts: <T>(request: HubAlertRequest, cancel?: AbortSignal) => {
    const pending = s.access.alerts<T>(request, cancel);
    return new Promise<HubAlertResult<T>>((resolve, reject) => {
      cancel?.addEventListener("abort", () => resolve({ ok: false, error: { code: "server_unavailable", message: "Your server could not be reached (The operation was aborted due to timeout)." } }), { once: true });
      pending.then(resolve, reject);
    });
  } }), store: store().store, cards: cards().host, log: () => undefined, retryMs: 20, raiseTimeoutMs: 50 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised; note: string };
  assert.equal(result.value.state, "unsent");
  assert.match(result.note, /may have taken it after all/);
  await until(() => s.raises().length === 2);
  outbox.stop();
});

test("what was kept cannot be read (damaged, another version): nothing is taken up, and new alerts still work", async () => {
  for (const raw of ["{not json", JSON.stringify({ version: 99, alerts: [] }), JSON.stringify({ version: 1, alerts: "x" }),
    JSON.stringify({ version: 1, alerts: [{ alertId: "unsent-1" }, null, 5] })]) {
    const k = store(raw);
    const s = server([unreachable]);
    const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: cards().host, log: () => undefined, retryMs: 60_000 });
    await outbox.retryDue();
    assert.equal(s.raises().length, 0, raw);
    const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
    assert.equal(result.value.state, "unsent");
    assert.deepEqual(kept(k.box).map((item) => item.requestId), ["req-1"]);
    outbox.stop();
  }
});

test("only settled alerts are let go past 50; every alert still to go out is kept", async () => {
  const k = store();
  const outbox = new UrgentAlertOutbox({ access: () => server([unreachable]).access, store: k.store, cards: cards().host, log: () => undefined, retryMs: 60_000 });
  const raised: UrgentAlertRaised[] = [];
  for (let index = 0; index < 60; index += 1) {
    raised.push((await outbox.raise(actor, { message: `alert ${index}`, requestId: `req-${index}` }) as { value: UrgentAlertRaised }).value);
  }
  assert.equal(kept(k.box).length, 60, "60 waiting, none dropped");
  for (const alert of raised.slice(0, 55)) await outbox.close({ alertId: alert.alertId });
  const now = kept(k.box);
  assert.equal(now.filter((item) => item.stage === "waiting").length, 5);
  assert.equal(now.filter((item) => item.stage === "closed").length, 50);
  assert.equal(now.filter((item) => item.stage === "closed")[0]?.requestId, "req-5", "the oldest closed ones went first");
  outbox.stop();
});

test("a closed alert whose card never came, and a reached one whose card never came, are let go in time", async () => {
  let now = Date.parse("2026-11-27T10:00:00.000Z");
  const k = store();
  const s = server([unreachable, unreachable, raisedFor("req-2")]);
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: k.store, cards: cards().host, log: () => undefined, retryMs: 60_000, now: () => now });
  const one = await outbox.raise(actor, { message: "one", requestId: "req-1" }) as { value: UrgentAlertRaised };
  await outbox.raise(actor, { message: "two", requestId: "req-2" });
  await outbox.close({ alertId: one.value.alertId });
  await outbox.retryDue();
  assert.deepEqual(kept(k.box).map((item) => [item.requestId, item.stage]), [["req-1", "closed"], ["req-2", "reached"]]);
  now += 61 * 60_000;
  await outbox.retryDue();
  assert.deepEqual(kept(k.box).map((item) => item.requestId), ["req-1"]);
  now += 24 * 60 * 60_000;
  await outbox.retryDue();
  assert.deepEqual(kept(k.box), []);
  outbox.stop();
});
