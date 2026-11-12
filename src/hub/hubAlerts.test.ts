import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeviceIdentity } from "../main/services/deviceIdentity";
import { sha256Hex, signHubRequest, signHubText } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { createHubDeviceClient, createHubDeviceIdentity, enrollHubPhone } from "../shared/hubDeviceClient";
import type { HubFeedResponse, HubOp } from "../shared/hubOps";
import { hubPhoneInviteSigningText, type HubPhoneInvite } from "../shared/hubProtocol";
import type { ChatMessage, ChatParticipant } from "../shared/types";
import type { UrgentAlertRaised, UrgentAlertSettingsView, UrgentAlertView } from "../shared/urgentAlerts";
import { spokenAlert, twilioSignature } from "./alertChannels";
import { callTwiml } from "./hubAlerts";
import { HUB_SERVER_WRITER } from "./hubOps";
import { composeHub } from "./main";

type Identity = ReturnType<typeof createDeviceIdentity>;

const TELEGRAM = "https://telegram.test";
const TWILIO = "https://twilio.test";
const PUBLIC = "https://hub.example";
const BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const AUTH_TOKEN = "a".repeat(32);
const USER_CHAT = 4242;

function vapid() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
}

/** Telegram and Twilio as the server sees them: what it sent, and what the
 *  User does (updates to read, how each call goes). */
function outside() {
  const sent: Array<{ chatId: number; text: string; buttons: string[]; messageId: number }> = [];
  const edits: Array<{ messageId: number; text: string; buttons: string[] }> = [];
  const answers: string[] = [];
  let updates: unknown[] = [];
  let nextUpdate = 1;
  let nextMessage = 100;
  const calls: Array<{ sid: string; to: string; from: string; twiml: string; status: string }> = [];
  /** How each new call ends, in order (default: rings out unanswered). */
  const outcomes: string[] = [];
  /** Telegram answers "too many requests" to this many sends first. */
  const throttle = { sends: 0 };
  const buttonsOf = (markup: unknown) => ((markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? [])
    .flat().map((button) => button.callback_data);
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(TELEGRAM)) {
      const method = url.split("/").pop() ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      if (!url.includes(`/bot${BOT_TOKEN}/`)) return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
      if (method === "getMe") return ok({ id: 1, is_bot: true, username: "svetlana_accord_bot", first_name: "Accord" });
      if (method === "deleteWebhook") return ok(true);
      if (method === "getUpdates") {
        const offset = typeof body.offset === "number" ? body.offset : 0;
        const ready = updates.filter((update) => (update as { update_id: number }).update_id >= offset);
        if (!ready.length) await new Promise((resolve) => setTimeout(resolve, 30));
        updates = updates.filter((update) => (update as { update_id: number }).update_id >= offset);
        return ok(ready);
      }
      if (method === "sendMessage") {
        if (throttle.sends > 0) {
          throttle.sends -= 1;
          return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 1" }), { status: 429 });
        }
        const messageId = ++nextMessage;
        sent.push({ chatId: Number(body.chat_id), text: String(body.text), buttons: buttonsOf(body.reply_markup), messageId });
        return ok({ message_id: messageId });
      }
      if (method === "editMessageText") {
        edits.push({ messageId: Number(body.message_id), text: String(body.text), buttons: buttonsOf(body.reply_markup) });
        return ok(true);
      }
      if (method === "answerCallbackQuery") {
        answers.push(String(body.text ?? ""));
        return ok(true);
      }
      return new Response(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }), { status: 404 });
    }
    if (url.startsWith(TWILIO)) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth !== `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`) {
        return new Response(JSON.stringify({ message: "Authenticate" }), { status: 401 });
      }
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")).entries());
      if (url.endsWith(`/Accounts/${ACCOUNT_SID}.json`)) return Response.json({ sid: ACCOUNT_SID, friendly_name: "My first account", type: "Trial", status: "active" });
      if (url.includes("/IncomingPhoneNumbers.json") && init?.method === "GET") return Response.json({ incoming_phone_numbers: [{ phone_number: "+14155550134", friendly_name: "x", capabilities: { voice: true } }] });
      if (url.endsWith("/Calls.json")) {
        const sid = `CA${randomBytes(16).toString("hex")}`;
        calls.push({ sid, to: form.To, from: form.From, twiml: form.Twiml, status: "ringing" });
        return Response.json({ sid, status: "queued" });
      }
      const callMatch = /\/Calls\/(CA[0-9a-f]+)\.json$/.exec(url);
      if (callMatch) {
        const call = calls.find((item) => item.sid === callMatch[1]);
        if (!call) return new Response("{}", { status: 404 });
        if (init?.method === "POST") {
          call.status = form.Status;
          return Response.json({ sid: call.sid, status: call.status });
        }
        // A call rings once, then ends as told.
        if (call.status === "ringing") {
          call.status = "rung";
          return Response.json({ sid: call.sid, status: "ringing" });
        }
        if (call.status === "rung") call.status = outcomes.shift() ?? "no-answer";
        return Response.json({ sid: call.sid, status: call.status, duration: call.status === "completed" ? "12" : "0" });
      }
      return new Response("{}", { status: 404 });
    }
    return new Response("", { status: 201 });
  }) as typeof fetch;
  const pushUpdate = (update: Record<string, unknown>) => {
    updates.push({ update_id: nextUpdate++, ...update });
  };
  const start = (code?: string, chat = USER_CHAT) => pushUpdate({ message: { message_id: 1, chat: { id: chat, first_name: "Svetlana" }, from: { id: chat, first_name: "Svetlana" }, text: code ? `/start ${code}` : "/start" } });
  const press = (data: string, messageId: number) => pushUpdate({ callback_query: { id: `cb-${nextUpdate}`, from: { id: USER_CHAT }, data, message: { message_id: messageId, chat: { id: USER_CHAT } } } });
  return { fetchImpl, sent, edits, answers, calls, outcomes, throttle, start, press };
}

const member: ChatParticipant = { id: "p-taylor", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" };
const cloudMember: ChatParticipant = { id: "p-box", handle: "box", roleConfigId: "software-engineer", kind: "claude-code", homeMachineId: "m-1" };

async function hub(t: test.TestContext, options: { publicUrl?: boolean; dir?: string; minuteMs?: number } = {}) {
  const dir = options.dir ?? await mkdtemp(path.join(tmpdir(), "accord-hub-alerts-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createDeviceIdentity(new Date().toISOString());
  if (!options.dir) {
    await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  }
  const world = outside();
  const composed = composeHub({
    storage, hubId: "hub-alerts-test", version: "test", keys: vapid(), log: () => undefined, fetchImpl: world.fetchImpl, pushDebounceMs: 50,
    alerts: {
      telegramBaseUrl: TELEGRAM, twilioBaseUrl: TWILIO, callPollMs: 20, callRetryMs: 120, minuteMs: 150, telegramWaitSeconds: 1, telegramRetryMs: 20,
      publicUrlOverride: options.publicUrl ? PUBLIC : "",
      ...(options.minuteMs ? { minuteMs: options.minuteMs } : {})
    }
  });
  const http = await composed.server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await composed.close();
  };
  t.after(async () => {
    await close();
    if (!options.dir) await rm(dir, { recursive: true, force: true });
  });
  const call = async <T = unknown>(identity: Identity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as T };
  };
  const alerts = <T>(identity: Identity, request: Record<string, unknown>) =>
    call<{ ok: boolean; value?: T; error?: { code: string; message: string } }>(identity, "POST", "/v3/alerts", request).then((answer) => answer.body);
  return { ...composed, dir, storage, owner, base, call, alerts, world, close };
}

type Hub = Awaited<ReturnType<typeof hub>>;

async function seedChat(h: Hub, extra: ChatParticipant[] = []) {
  const op: HubOp = { opId: `op-${randomBytes(4).toString("hex")}`, kind: "conversation.create", conversationId: "chat-1",
    conversation: { title: "Deploy monitoring", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [member, ...extra] } } };
  const answer = await h.call(h.owner, "POST", "/v3/ops", { ops: [op] });
  assert.equal(answer.status, 200);
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string, ms = 4_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** The alert's card as the server holds it in the chat. */
async function card(h: Hub, alertId: string): Promise<ChatMessage | undefined> {
  const chat = await h.storage.getConversation("chat-1");
  return chat?.messages.find((message) => message.metadata?.urgentAlert?.id === alertId);
}

async function stateOf(h: Hub, alertId: string): Promise<UrgentAlertView | undefined> {
  return (await card(h, alertId))?.metadata?.urgentAlert;
}

async function connectTelegram(h: Hub) {
  const connected = await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "telegram.connect", token: BOT_TOKEN });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.value?.telegram?.botUsername, "svetlana_accord_bot");
  assert.equal(connected.value?.telegram?.step, "start");
  const code = connected.value?.telegram?.startCode;
  assert.ok(code, "a one-time Start code");
  // Someone who found the bot connects nobody.
  h.world.start(undefined, 777);
  await until(() => h.world.sent.find((item) => item.chatId === 777), "the stranger to be told how to connect");
  assert.equal((await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "settings" })).value?.telegram?.step, "start");
  h.world.start(code);
  const test = await until(() => h.world.sent.find((item) => item.buttons.some((data) => data.startsWith("test:"))), "the test message");
  h.world.press(test.buttons[0], test.messageId);
  await until(async () => (await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "settings" })).value?.telegram?.connected, "Telegram to connect");
}

async function connectPhone(h: Hub) {
  const checked = await h.alerts<{ trial: boolean; numbers: string[] }>(h.owner, { action: "phone.check", accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN });
  assert.deepEqual(checked.value, { accountName: "My first account", trial: true, numbers: ["+14155550134"] });
  const saved = await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "phone.save", accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, from: "+14155550134", to: "+357 99 123 342" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.value?.phone, { from: "+14155550134", to: "+35799123342", trial: true });
  await h.alerts(h.owner, { action: "wait", minutes: 1 });
}

async function raise(h: Hub, identity: Identity, text = "Production deploy failed: 3 of 4 instances fail health checks.", participantId = member.id) {
  return h.alerts<UrgentAlertRaised>(identity, { action: "raise", conversationId: "chat-1", participantId, text, requestId: randomBytes(6).toString("hex") });
}

test("with nothing connected an alert stays a card in the chat, written by the server", async (t) => {
  const h = await hub(t);
  await seedChat(h);
  const raised = await raise(h, h.owner);
  assert.equal(raised.ok, true, JSON.stringify(raised));
  assert.equal(raised.value?.state, "not_set_up");
  const message = await card(h, raised.value!.alertId);
  assert.ok(message);
  assert.equal(message.role, "participant");
  assert.equal(message.participantId, member.id);
  assert.equal(message.content, "Production deploy failed: 3 of 4 instances fail health checks.");
  assert.equal(message.metadata?.serverWriter, HUB_SERVER_WRITER);
  // Every device reads it from the feed as another's.
  const feed = await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0&wait=0");
  const entry = feed.body.entries.find((item) => item.effect.kind === "message.create" && item.effect.message.id === message.id);
  assert.equal(entry?.deviceId, HUB_SERVER_WRITER);
  // No device may change what the server wrote.
  const forged: HubOp = { opId: `op-${randomBytes(4).toString("hex")}`, kind: "message.update", conversationId: "chat-1", message: { ...message, content: "forged" } };
  const refused = await h.call<{ results: Array<{ status: string }> }>(h.owner, "POST", "/v3/ops", { ops: [forged] });
  assert.equal(refused.body.results[0].status, "rejected");
  // Nor make one of its own: the card's data does not survive a device's write.
  const fake: ChatMessage = { id: "fake-alert", role: "participant", participantId: member.id, content: "Pay this invoice now", createdAt: new Date().toISOString(),
    status: "done", metadata: { urgentAlert: { ...message.metadata!.urgentAlert!, id: "fake" } } };
  const written = await h.call<{ results: Array<{ status: string }> }>(h.owner, "POST", "/v3/ops", { ops: [{ opId: `op-${randomBytes(4).toString("hex")}`, kind: "message.create", conversationId: "chat-1", message: fake }] });
  assert.equal(written.body.results[0].status, "accepted");
  const stored = (await h.storage.getConversation("chat-1"))?.messages.find((item) => item.id === "fake-alert");
  assert.equal(stored?.metadata?.urgentAlert, undefined);
});

test("Telegram connects by Start and the test button; an alert's Got it ends it before any call", async (t) => {
  // A wait no test run outlasts: no call may come at all.
  const h = await hub(t, { publicUrl: true, minuteMs: 60_000 });
  await seedChat(h);
  await connectTelegram(h);
  await connectPhone(h);
  const raised = await raise(h, h.owner);
  assert.equal(raised.value?.state, "waiting");
  assert.equal(raised.value?.telegram, true);
  assert.equal(raised.value?.phone, true);
  const alertId = raised.value!.alertId;
  const message = await until(() => h.world.sent.find((item) => item.buttons.includes(`ack:${alertId}`)), "the alert in Telegram");
  assert.equal(message.chatId, USER_CHAT);
  assert.match(message.text, /Urgent alert · @taylor · Deploy monitoring/);
  assert.match(message.text, /I'll call you in 1 min unless you press Got it/);
  const waiting = await until(async () => (await stateOf(h, alertId))?.telegram?.sentAt ? stateOf(h, alertId) : undefined, "the card to say sent");
  assert.ok(waiting.callAt);
  h.world.press(`ack:${alertId}`, message.messageId);
  const done = await until(async () => { const view = await stateOf(h, alertId); return view?.state === "acknowledged" ? view : undefined; }, "Got it");
  assert.equal(done.ackSource, "telegram");
  assert.equal(done.callAt, undefined);
  const edit = await until(() => h.world.edits.find((item) => item.messageId === message.messageId && /You pressed Got it/.test(item.text)), "the Telegram message to change");
  assert.deepEqual(edit.buttons, []);
  // Well past the wait: no call.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(h.world.calls.length, 0);
});

test("with no reaction it calls three times, three minutes apart, then says nobody answered", async (t) => {
  const h = await hub(t, { publicUrl: true });
  await seedChat(h);
  await connectTelegram(h);
  await connectPhone(h);
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  const view = await until(async () => { const current = await stateOf(h, alertId); return current?.state === "unanswered" ? current : undefined; }, "three calls", 8_000);
  assert.equal(view.calls.length, 3);
  assert.deepEqual(view.calls.map((call) => call.status), ["no-answer", "no-answer", "no-answer"]);
  assert.equal(h.world.calls.length, 3);
  assert.equal(h.world.calls[0].to, "+35799123342");
  assert.equal(h.world.calls[0].from, "+14155550134");
  // With a server Twilio reaches, the call asks for 1, at this alert's address.
  assert.match(h.world.calls[0].twiml, /<Gather numDigits="1"/);
  assert.match(h.world.calls[0].twiml, new RegExp(`${PUBLIC}/v1/alerts/twilio\\?alert=${alertId}&amp;token=`));
  assert.match(h.world.calls[0].twiml, /Production deploy failed/);
  await until(() => h.world.edits.some((edit) => edit.text.includes("Called you 3 times")), "Telegram to say nobody answered");
  // Got it still ends it afterwards.
  const message = h.world.sent.find((item) => item.buttons.includes(`ack:${alertId}`))!;
  h.world.press(`ack:${alertId}`, message.messageId);
  await until(async () => (await stateOf(h, alertId))?.state === "acknowledged", "a late Got it");
});

test("1 on the call ends it, by a request Twilio signed; a forged one is refused", async (t) => {
  const h = await hub(t, { publicUrl: true });
  await seedChat(h);
  await connectPhone(h);
  // Keep the first call talking until a key is pressed.
  h.world.outcomes.push("in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress");
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  await until(() => h.world.calls[0], "the first call");
  const twiml = h.world.calls[0].twiml;
  const action = /action="([^"]+)"/.exec(twiml)![1].replace(/&amp;/g, "&");
  const address = new URL(action);
  const local = `${h.base}${address.pathname}${address.search}`;
  const params = { CallSid: h.world.calls[0].sid, Digits: "1", From: "+14155550134", To: "+35799123342" };
  const body = new URLSearchParams(params).toString();
  const forged = await fetch(local, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bm9wZQ==" } });
  assert.equal(forged.status, 403);
  assert.notEqual((await stateOf(h, alertId))?.state, "acknowledged");
  const signed = await fetch(local, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(AUTH_TOKEN, action, params) } });
  assert.equal(signed.status, 200);
  assert.match(await signed.text(), /Got it\. Goodbye\./);
  const done = await until(async () => { const view = await stateOf(h, alertId); return view?.state === "acknowledged" ? view : undefined; }, "1 on the call");
  assert.equal(done.ackSource, "call");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(h.world.calls.length, 1, "no further call");
});

test("closing the card in the app counts as Got it and folds it; the phone closes it too, a machine never", async (t) => {
  const h = await hub(t, { publicUrl: true, minuteMs: 60_000 });
  await seedChat(h, [cloudMember]);
  await connectTelegram(h);
  await connectPhone(h);
  const machine = createDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1" }
  ] });
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  const message = await until(() => h.world.sent.find((item) => item.buttons.includes(`ack:${alertId}`)), "the alert in Telegram");
  // A machine speaks for members, never for the User.
  const byMachine = await h.alerts(machine, { action: "close", alertId });
  assert.equal(byMachine.error?.code, "access_denied");
  // The User's computer closes it.
  const closed = await h.alerts<UrgentAlertView>(h.owner, { action: "close", alertId });
  assert.equal(closed.value?.state, "acknowledged");
  assert.equal(closed.value?.ackSource, "app");
  assert.ok(closed.value?.closedAt);
  const edit = await until(() => h.world.edits.find((item) => item.messageId === message.messageId && /Closed in the app/.test(item.text)), "Telegram to say closed");
  assert.deepEqual(edit.buttons, []);
  // From the phone, the way the phone app asks.
  const token = randomBytes(32).toString("base64url");
  const invite: HubPhoneInvite = {
    version: 1, inviteId: `invite-${randomBytes(8).toString("hex")}`, hubId: "hub-alerts-test", issuerDeviceId: h.owner.originId,
    tokenHash: sha256Hex(token), scope: { scope: "device" }, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  assert.equal((await h.call(h.owner, "PUT", "/v1/phone-invites", { invite, signature: signHubText(h.owner, hubPhoneInviteSigningText(invite)) })).status, 200);
  const identity = await createHubDeviceIdentity();
  await enrollHubPhone({ hubUrl: h.base, hubId: "hub-alerts-test", token, identity, name: "iPhone" });
  const phone = createHubDeviceClient({ hubUrl: h.base, identity: async () => identity });
  const second = await raise(h, h.owner, "Second alert");
  const byPhone = await phone.postJson<{ ok: boolean; value?: UrgentAlertView }>("/v3/alerts", { action: "close", alertId: second.value!.alertId });
  assert.equal(byPhone.ok, true, JSON.stringify(byPhone));
  assert.equal(byPhone.value?.ackSource, "app");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(h.world.calls.length, 0);
});

test("without a server Twilio reaches, answering the call is what ends it", async (t) => {
  const h = await hub(t);
  await seedChat(h);
  await connectPhone(h);
  h.world.outcomes.push("completed");
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  const done = await until(async () => { const view = await stateOf(h, alertId); return view?.state === "acknowledged" ? view : undefined; }, "an answered call");
  assert.equal(done.callMode, "answer");
  assert.equal(done.ackSource, "call");
  assert.doesNotMatch(h.world.calls[0].twiml, /Gather/);
});

test("a member raises alerts only from the device it runs on; a repeat is the same alert", async (t) => {
  const h = await hub(t);
  await seedChat(h, [cloudMember]);
  const machine = createDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "m-1" }
  ] });
  const wrong = await raise(h, h.owner, "x", cloudMember.id);
  assert.equal(wrong.error?.code, "access_denied");
  const fromMachine = await h.alerts<UrgentAlertRaised>(machine, { action: "raise", conversationId: "chat-1", participantId: cloudMember.id, text: "Box is down", requestId: "same" });
  assert.equal(fromMachine.ok, true, JSON.stringify(fromMachine));
  const again = await h.alerts<UrgentAlertRaised>(machine, { action: "raise", conversationId: "chat-1", participantId: cloudMember.id, text: "Box is down", requestId: "same" });
  assert.equal(again.value?.alertId, fromMachine.value?.alertId);
  // Only the User's computer changes settings.
  const settings = await h.alerts(machine, { action: "settings" });
  assert.equal(settings.ok, false);
  const tooLong = await raise(h, h.owner, "x".repeat(1_001));
  assert.equal(tooLong.error?.code, "invalid_request");
});

test("a call due while the server was down is placed after it starts again", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-alerts-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await hub(t, { publicUrl: true, dir });
  // The first start sets the owner itself (no dir given would); do it here.
  await first.storage.hub().setOwner({ deviceId: first.owner.originId, publicKeyDerBase64: first.owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  await seedChat(first);
  await connectPhone(first);
  const raised = await raise(first, first.owner);
  const alertId = raised.value!.alertId;
  await first.close();
  assert.equal(first.world.calls.length, 0);
  const second = await hub(t, { publicUrl: true, dir });
  await until(() => second.world.calls[0], "the call after the restart");
  const view = await until(async () => { const current = await stateOf(second, alertId); return current?.calls.length ? current : undefined; }, "the card to show the call");
  assert.equal(view.calls[0].attempt, 1);
});

test("a long message still fits the call Twilio takes", () => {
  const long = `${"A & B < C ".repeat(150)}`.slice(0, 1_000);
  for (const mode of ["keypad", "answer"] as const) {
    const twiml = callTwiml(mode, spokenAlert("@taylor", "Deploy monitoring", long), `${PUBLIC}/v1/alerts/twilio?alert=x&token=y`);
    assert.ok(twiml.length <= 3_900, `${mode}: ${twiml.length}`);
    assert.match(twiml, /Urgent alert from taylor in the chat Deploy monitoring\./);
  }
  const colored = callTwiml("answer", spokenAlert("@taylor", "", "\u001b[31mERROR\u001b[0m disk\u0007 full"), "");
  assert.doesNotMatch(colored, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, "nothing XML cannot carry");
  assert.match(colored, /ERROR disk  full/);
  const short = callTwiml("answer", spokenAlert("@taylor", "", "Disk full."), "");
  assert.match(short, /Urgent alert from taylor\. Disk full\..*Urgent alert from taylor\. Disk full\./s, "read twice when it fits");
});

test("a phone disconnected while it rings ends that call; no further call is placed", async (t) => {
  const h = await hub(t, { publicUrl: true });
  await seedChat(h);
  await connectPhone(h);
  h.world.outcomes.push("in-progress", "in-progress", "in-progress", "in-progress", "in-progress");
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  await until(() => h.world.calls[0], "the first call");
  await h.alerts(h.owner, { action: "phone.disconnect" });
  const view = await until(async () => { const current = await stateOf(h, alertId); return current?.calls[0]?.status === "canceled" ? current : undefined; }, "the call to end");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.world.calls.length, 1, "no call without a phone");
  const after = await stateOf(h, alertId);
  assert.equal(after?.phone, false);
  assert.equal(view.calls.length, 1);
});

test("Telegram that is briefly too busy still gets the alert", async (t) => {
  const h = await hub(t, { minuteMs: 60_000 });
  await seedChat(h);
  await connectTelegram(h);
  h.world.throttle.sends = 2;
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  await until(() => h.world.sent.find((item) => item.buttons.includes(`ack:${alertId}`)), "the alert after two refusals");
  const view = await until(async () => { const current = await stateOf(h, alertId); return current?.telegram?.sentAt ? current : undefined; }, "the card to say sent");
  assert.equal(view.telegram?.error, undefined);
  assert.equal(view.state, "waiting");
});

test("Got it while a call rings stops that call, and the card says it was stopped", async (t) => {
  const h = await hub(t, { publicUrl: true });
  await seedChat(h);
  await connectTelegram(h);
  await connectPhone(h);
  h.world.outcomes.push("in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress");
  const raised = await raise(h, h.owner);
  const alertId = raised.value!.alertId;
  const call = await until(() => h.world.calls[0], "the first call");
  const message = h.world.sent.find((item) => item.buttons.includes(`ack:${alertId}`))!;
  h.world.press(`ack:${alertId}`, message.messageId);
  const view = await until(async () => { const current = await stateOf(h, alertId); return current?.state === "acknowledged" ? current : undefined; }, "Got it");
  assert.equal(view.calls[0].status, "canceled");
  await until(() => call.status === "completed" || call.status === "canceled", "Twilio to be told to end the call");
});

test("Twilio's key press is refused with the wrong token; 2 repeats the message", async (t) => {
  const h = await hub(t, { publicUrl: true });
  await seedChat(h);
  await connectPhone(h);
  h.world.outcomes.push("in-progress", "in-progress", "in-progress", "in-progress", "in-progress", "in-progress");
  await raise(h, h.owner);
  await until(() => h.world.calls[0], "the first call");
  const action = /action="([^"]+)"/.exec(h.world.calls[0].twiml)![1].replace(/&amp;/g, "&");
  const params = { CallSid: h.world.calls[0].sid, Digits: "2" };
  const post = (url: string) => fetch(`${h.base}${new URL(url).pathname}${new URL(url).search}`, { method: "POST", body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(AUTH_TOKEN, url, params) } });
  const wrong = action.replace(/token=[^&]+/, "token=nope");
  assert.equal((await post(wrong)).status, 403);
  const repeat = await post(action);
  assert.equal(repeat.status, 200);
  assert.match(await repeat.text(), /<Gather numDigits="1"[\s\S]*Production deploy failed/);
});

test("settings refuse what cannot work: wait bounds, a plain-http address, malformed keys", async (t) => {
  const h = await hub(t);
  for (const minutes of [0, 61, Number.NaN]) assert.equal((await h.alerts(h.owner, { action: "wait", minutes })).error?.code, "invalid_request");
  assert.equal((await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "wait", minutes: 7 })).value?.waitMinutes, 7);
  const http = await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "public-url", url: "http://1.2.3.4" });
  assert.equal(http.value?.callMode, "answer", "only https is an address Twilio may post to");
  const https = await h.alerts<UrgentAlertSettingsView>(h.owner, { action: "public-url", url: "https://1.2.3.4/" });
  assert.equal(https.value?.callMode, "keypad");
  assert.equal((await h.alerts(h.owner, { action: "telegram.connect", token: "not a token" })).error?.code, "invalid_request");
  assert.equal((await h.alerts(h.owner, { action: "phone.check", accountSid: "AC123", authToken: "x" })).error?.code, "invalid_request");
  assert.equal((await h.alerts(h.owner, { action: "telegram.test" })).error?.code, "not_set_up");
  assert.equal((await h.alerts(h.owner, { action: "nonsense" })).error?.code, "invalid_request");
});
