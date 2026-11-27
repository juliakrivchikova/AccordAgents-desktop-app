import assert from "node:assert/strict";
import test from "node:test";
import type { HubAlertRequest, HubAlertResult, UrgentAlertRaised, UrgentAlertView } from "../../shared/urgentAlerts";
import { UrgentAlertOutbox, urgentAlertCardMessageId, type UrgentAlertCardHost, type UrgentAlertServerAccess } from "./urgentAlertTools";

const actor = { conversationId: "chat-1", participantId: "member-1" };

/** The server as the outbox reaches it: answers in order (the last repeats). */
function server(answers: Array<HubAlertResult<unknown> | "throw" | (() => Promise<HubAlertResult<unknown>>)>) {
  const requests: HubAlertRequest[] = [];
  let index = 0;
  const access: UrgentAlertServerAccess = {
    async alerts<T>(request: HubAlertRequest): Promise<HubAlertResult<T>> {
      requests.push(request);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer === "throw") throw new Error("socket hang up");
      return (typeof answer === "function" ? await answer() : answer) as HubAlertResult<T>;
    }
  };
  return { access, requests, raises: () => requests.filter((request) => request.action === "raise") };
}

function cards() {
  const shown = new Map<string, { conversationId: string; participantId: string; text: string; alert: UrgentAlertView }>();
  const removed: string[] = [];
  const host: UrgentAlertCardHost = {
    async show(card) {
      shown.set(card.messageId, { conversationId: card.conversationId, participantId: card.participantId, text: card.text, alert: card.alert });
      return true;
    },
    async update(_conversationId, messageId, change) {
      const card = shown.get(messageId);
      if (!card) return undefined;
      card.alert = change(card.alert);
      return card.alert;
    },
    async remove(_conversationId, messageId) {
      removed.push(messageId);
      shown.delete(messageId);
    }
  };
  return { host, shown, removed };
}

function store(initial?: string) {
  const box = { value: initial };
  return { box, store: { read: async () => box.value, write: async (value: string) => { box.value = value; } } };
}

const unreachable: HubAlertResult<unknown> = { ok: false, error: { code: "server_unavailable", message: "Your server could not be reached (fetch failed)." } };

function raisedFor(requestId: string, overrides: Partial<UrgentAlertRaised> = {}): HubAlertResult<unknown> {
  return { ok: true, value: { alertId: "server-alert-1", messageId: urgentAlertCardMessageId(actor.conversationId, actor.participantId, requestId), state: "not_set_up", telegram: false, phone: false, ...overrides } };
}

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the card's message id is the same on the device and the server, and differs per alert", () => {
  const id = urgentAlertCardMessageId("chat-1", "member-1", "req-1");
  assert.equal(id, urgentAlertCardMessageId("chat-1", "member-1", "req-1"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, urgentAlertCardMessageId("chat-1", "member-1", "req-2"));
  assert.notEqual(id, urgentAlertCardMessageId("chat-1", "member-2", "req-1"));
  assert.notEqual(id, urgentAlertCardMessageId("chat-2", "member-1", "req-1"));
});

test("the server takes it: no card here, the note says what went out", async () => {
  const s = server([raisedFor("req-1", { state: "waiting", telegram: true, phone: true })]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined });
  const result = await outbox.raise(actor, { message: "  Production is down  ", requestId: "req-1" }) as { ok: boolean; note: string };
  assert.equal(result.ok, true);
  assert.match(result.note, /Telegram/);
  assert.match(result.note, /phone rings/);
  assert.equal(c.shown.size, 0);
  assert.equal((s.raises()[0] as { text: string }).text, "Production is down", "trimmed");
});

test("an empty or too long message is refused at once, server or not, and shows nothing", async () => {
  const s = server([unreachable]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined });
  assert.equal((await outbox.raise(actor, { message: "   " }) as { error: { code: string } }).error.code, "invalid_request");
  assert.equal((await outbox.raise(actor, { message: "x".repeat(1001) }) as { error: { code: string } }).error.code, "invalid_request");
  assert.equal(s.requests.length, 0);
  assert.equal(c.shown.size, 0);
});

test("the server cannot be reached: the card stands here at once, and the alert goes there once it can; the server's card takes its place", async () => {
  const s = server([unreachable, "throw", raisedFor("req-1")]);
  const c = cards();
  const kept = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; value: UrgentAlertRaised; note: string };
  assert.equal(result.ok, true, "it reached her, as a card");
  assert.equal(result.value.state, "unsent");
  assert.match(result.note, /only as a red card in this chat on her computer/);
  assert.match(result.note, /no Telegram and no call yet/);
  const messageId = urgentAlertCardMessageId(actor.conversationId, actor.participantId, "req-1");
  assert.equal(result.value.messageId, messageId);
  const card = c.shown.get(messageId)!;
  assert.equal(card.alert.state, "unsent");
  assert.deepEqual(card.alert.unsent, { reason: "unreachable", retrying: true });
  assert.ok(card.alert.id.startsWith("unsent-"));
  assert.match(kept.box.value ?? "", /req-1/, "kept across a restart");
  // Raised again until it gets through, with the same request id (never twice).
  await until(() => s.raises().length >= 3);
  await until(() => !(kept.box.value ?? "").includes("req-1"));
  assert.deepEqual(s.raises().map((request) => (request as { requestId: string }).requestId), ["req-1", "req-1", "req-1"]);
  assert.deepEqual(c.removed, [], "the server's card carries the same id and replaces this one itself");
  outbox.stop();
});

test("a server older than this app writes its card under another id: this card comes down, so one card stands", async () => {
  const s = server([unreachable, raisedFor("req-1", { messageId: "random-server-id" })]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 20 });
  await outbox.raise(actor, { message: "Production is down", requestId: "req-1" });
  const messageId = urgentAlertCardMessageId(actor.conversationId, actor.participantId, "req-1");
  assert.ok(c.shown.has(messageId));
  await until(() => c.removed.includes(messageId));
  assert.equal(c.shown.size, 0);
  outbox.stop();
});

test("Got it on the card here keeps the alert from going out; the card folds as Got it in the app", async () => {
  const s = server([unreachable]);
  const c = cards();
  const kept = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  const closed = await outbox.close(result.value.alertId);
  assert.ok(closed && "handled" in closed && closed.handled.ok);
  const view = (closed as { handled: { ok: true; value: UrgentAlertView } }).handled.value;
  assert.equal(view.state, "acknowledged");
  assert.equal(view.ackSource, "app");
  assert.ok(view.closedAt);
  assert.equal(view.unsent?.retrying, false);
  const raisesAtClose = s.raises().length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(s.raises().length, raisesAtClose, "not raised on the server any more");
  assert.doesNotMatch(kept.box.value ?? "", /req-1/);
  assert.equal(await outbox.close("server-alert-uuid"), undefined, "a server's card is closed there");
  outbox.stop();
});

test("Got it pressed while the alert is on its way: once the server takes it, it is closed there too", async () => {
  let let_through!: () => void;
  const s = server([unreachable, () => new Promise((resolve) => { let_through = () => resolve(raisedFor("req-1")); }), { ok: true, value: {} }]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  await until(() => s.raises().length === 2);
  await outbox.close(result.value.alertId);
  let_through();
  await until(() => s.requests.some((request) => request.action === "close"));
  assert.deepEqual(s.requests.find((request) => request.action === "close"), { action: "close", alertId: "server-alert-1" });
  outbox.stop();
});

test("the server refuses the alert: the card still stands here, says why, and it is not raised again", async () => {
  const s = server([{ ok: false, error: { code: "access_denied", message: "This member is not in the chat." } }]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; note: string };
  assert.equal(result.ok, true);
  assert.match(result.note, /did not take the alert/);
  const card = [...c.shown.values()][0]!;
  assert.deepEqual(card.alert.unsent, { reason: "refused", message: "This member is not in the chat.", retrying: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.raises().length, 1);
  outbox.stop();
});

test("not linked yet (no access): the card stands and the alert waits for the link", async () => {
  let linked: UrgentAlertServerAccess | undefined;
  const s = server([raisedFor("req-1")]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => linked, store: store().store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  assert.equal(result.value.state, "unsent");
  linked = s.access;
  await until(() => s.raises().length === 1);
  outbox.stop();
});

test("a machine shows nothing of its own: the member hears nothing reached User yet, and it is raised until her server takes it", async () => {
  const s = server([unreachable, unreachable, raisedFor("req-1")]);
  const kept = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "server_unavailable");
  assert.match(result.error.message, /nothing reached her yet/);
  await until(() => s.raises().length >= 3);
  await until(() => !(kept.box.value ?? "").includes("req-1"));
  outbox.stop();
});

test("a machine whose alert the server refuses keeps nothing and tells the member", async () => {
  const s = server([{ ok: false, error: { code: "access_denied", message: "This member is not in the chat." } }]);
  const kept = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; error: { code: string } };
  assert.equal(result.error.code, "access_denied");
  assert.doesNotMatch(kept.box.value ?? "", /req-1/);
  outbox.stop();
});

test("after a restart the kept alert goes out", async () => {
  const kept = store();
  const first = new UrgentAlertOutbox({ access: () => server([unreachable]).access, store: kept.store, cards: cards().host, log: () => undefined, retryMs: 60_000 });
  await first.raise(actor, { message: "Production is down", requestId: "req-1" });
  first.stop();
  const s = server([raisedFor("req-1")]);
  const second = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, cards: cards().host, log: () => undefined, retryMs: 20 });
  second.start();
  await until(() => s.raises().length === 1);
  assert.equal((s.raises()[0] as { text: string }).text, "Production is down");
  await until(() => !(kept.box.value ?? "").includes("req-1"));
  second.stop();
});

test("a timeout is not an answer: the card stands, and a retry finds the alert the server did take", async () => {
  const s = server([() => new Promise(() => undefined), raisedFor("req-1")]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => ({ alerts: <T>(request: HubAlertRequest, cancel?: AbortSignal) => {
    const pending = s.access.alerts<T>(request, cancel);
    return new Promise<HubAlertResult<T>>((resolve, reject) => {
      cancel?.addEventListener("abort", () => resolve({ ok: false, error: { code: "server_unavailable", message: "Your server could not be reached (The operation was aborted due to timeout)." } }), { once: true });
      pending.then(resolve, reject);
    });
  } }), store: store().store, cards: c.host, log: () => undefined, retryMs: 20, raiseTimeoutMs: 50 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  assert.equal(result.value.state, "unsent");
  await until(() => s.raises().length === 2);
  outbox.stop();
});

test("Got it on a card the server took meanwhile goes to the server's alert", async () => {
  const s = server([unreachable, raisedFor("req-1", { alertId: "server-alert-9" })]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
  await until(() => s.raises().length === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await outbox.close(result.value.alertId), { forwardTo: "server-alert-9" });
  outbox.stop();
});

test("what was kept cannot be read (damaged, another version): nothing is taken up, and new alerts still work", async () => {
  for (const raw of ["{not json", JSON.stringify({ version: 99, alerts: [] }), JSON.stringify({ version: 1, alerts: "x" }),
    JSON.stringify({ version: 1, alerts: [{ alertId: "unsent-1" }, null, 5] })]) {
    const kept = store(raw);
    const s = server([unreachable]);
    const outbox = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, cards: cards().host, log: () => undefined, retryMs: 60_000 });
    await outbox.retryDue();
    assert.equal(s.raises().length, 0, raw);
    const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised };
    assert.equal(result.value.state, "unsent");
    assert.match(kept.box.value ?? "", /req-1/);
    outbox.stop();
  }
});

test("at most 50 alerts are kept; the oldest the server refused go first, never one still to go out", async () => {
  const refused: HubAlertResult<unknown> = { ok: false, error: { code: "access_denied", message: "This member is not in the chat." } };
  let answer: HubAlertResult<unknown> = refused;
  const kept = store();
  const outbox = new UrgentAlertOutbox({ access: () => ({ alerts: async <T>() => answer as HubAlertResult<T> }), store: kept.store, cards: cards().host, log: () => undefined, retryMs: 60_000 });
  for (let index = 0; index < 10; index += 1) await outbox.raise(actor, { message: `refused ${index}`, requestId: `refused-${index}` });
  answer = unreachable;
  for (let index = 0; index < 45; index += 1) await outbox.raise(actor, { message: `waiting ${index}`, requestId: `waiting-${index}` });
  const alerts = (JSON.parse(kept.box.value!) as { alerts: Array<{ requestId: string; retrying: boolean }> }).alerts;
  assert.equal(alerts.length, 50);
  assert.equal(alerts.filter((item) => item.retrying).length, 45, "every alert still to go out is kept");
  assert.deepEqual(alerts.filter((item) => !item.retrying).map((item) => item.requestId), ["refused-5", "refused-6", "refused-7", "refused-8", "refused-9"]);
  outbox.stop();
});

test("a server that does not have the chat yet is asked again for a while; a card gone meanwhile (the chat deleted) ends it", async () => {
  const noChat: HubAlertResult<unknown> = { ok: false, error: { code: "access_denied", message: "The server has no such chat (yet)." } };
  const s = server([noChat, noChat, raisedFor("req-1")]);
  const c = cards();
  const kept = store();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: kept.store, cards: c.host, log: () => undefined, retryMs: 20 });
  const result = await outbox.raise(actor, { message: "Production is down", requestId: "req-1" }) as { value: UrgentAlertRaised; note: string };
  assert.match(result.note, /keeps raising it/);
  assert.equal([...c.shown.values()][0]!.alert.unsent?.retrying, true);
  await until(() => s.raises().length === 3);
  await until(() => !(kept.box.value ?? "").includes("req-1"));
  outbox.stop();

  const s2 = server([noChat]);
  const c2 = cards();
  const kept2 = store();
  const outbox2 = new UrgentAlertOutbox({ access: () => s2.access, store: kept2.store, cards: c2.host, log: () => undefined, retryMs: 20 });
  await outbox2.raise(actor, { message: "Production is down", requestId: "req-2" });
  c2.shown.clear();
  await until(() => !(kept2.box.value ?? "").includes("req-2"));
  const asked = s2.raises().length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(s2.raises().length, asked, "not asked again once its card is gone");
  outbox2.stop();
});

test("a server that keeps not having the chat: after a while the alert counts as refused and the card says so", async () => {
  const noChat: HubAlertResult<unknown> = { ok: false, error: { code: "access_denied", message: "The server has no such chat (yet)." } };
  const s = server([noChat]);
  const c = cards();
  const outbox = new UrgentAlertOutbox({ access: () => s.access, store: store().store, cards: c.host, log: () => undefined, retryMs: 5 });
  await outbox.raise(actor, { message: "Production is down", requestId: "req-1" });
  await until(() => [...c.shown.values()][0]!.alert.unsent?.retrying === false, 5_000);
  assert.deepEqual([...c.shown.values()][0]!.alert.unsent, { reason: "refused", message: "The server has no such chat (yet).", retrying: false });
  const asked = s.raises().length;
  assert.ok(asked >= 20 && asked <= 21, `asked ${asked} times`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(s.raises().length, asked);
  outbox.stop();
});
