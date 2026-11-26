import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeviceIdentity } from "../../main/services/deviceIdentity";
import { signHubRequest } from "../../main/services/hubAuth";
import { StorageService } from "../../main/services/storage";
import type { HubOp } from "../../shared/hubOps";
import type { ChatSearchValue, MemoryIndexValue, MemoryNote, MemoryPickValue, MemoryResult, MemorySearchValue, SemanticSettingsView } from "../../shared/memory";
import type { ChatMessage, ChatParticipant } from "../../shared/types";
import { composeHub } from "../main";

/**
 * Search by meaning on the User's server, put together as the program is,
 * with OpenAI played by a stand-in: a print is a few topics a text speaks
 * of (in any language), so what is close in meaning is known in advance.
 */

const TOPICS = [
  ["release", "релиз", "выпуст", "выкат", "deploy", "beta", "бет"],
  ["lunch", "обед", "кофе", "eat"],
  ["alert", "тревог", "telegram", "звон", "phone"]
];
const GOOD_KEY = `sk-proj-${"a".repeat(40)}`;
const REFUSED_KEY = `sk-proj-${"r".repeat(40)}`;

function fakePrint(text: string): number[] {
  const print = new Array<number>(1536).fill(0);
  const lower = text.toLowerCase();
  TOPICS.forEach((words, index) => { if (words.some((word) => lower.includes(word))) print[index * 10] = 1; });
  // A little of each text's own, so unrelated texts are not all alike.
  let hash = 0;
  for (const character of lower) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  print[300 + (hash % 50)] += 0.2;
  return print;
}

function openAi() {
  const state = { calls: 0, inputs: 0, down: false, refuseAll: false, keys: new Set<string>() };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (!text.startsWith("https://api.openai.com/")) return new Response("{}", { status: 200 });
    const key = String((init?.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /, "");
    state.keys.add(key);
    state.calls += 1;
    if (state.down) return new Response(JSON.stringify({ error: { message: "Server error" } }), { status: 500 });
    if (key === REFUSED_KEY || state.refuseAll) return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key.slice(0, 8)}****` } }), { status: 401 });
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string; dimensions: number };
    assert.equal(body.model, "text-embedding-3-small");
    state.inputs += body.input.length;
    return new Response(JSON.stringify({ data: body.input.map((input, index) => ({ index, embedding: fakePrint(input) })) }), { status: 200 });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function vapid() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
}

type DeviceIdentity = ReturnType<typeof createDeviceIdentity>;

const taylor: ChatParticipant = { id: "p-taylor", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" };
const CHAT_A = "chat-accord-a";
const CHAT_B = "chat-accord-b";
const CHAT_C = "chat-other";

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-semantic-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  const ai = openAi();
  const composed = composeHub({ storage, hubId: "hub-semantic-test", version: "test", keys: vapid(), log: () => undefined, fetchImpl: ai.fetchImpl });
  const http = await composed.server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await composed.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const call = async (identity: DeviceIdentity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, text: await response.text() };
  };
  const memory = async <T>(request: Record<string, unknown>): Promise<MemoryResult<T>> => {
    const answer = await call(owner, "POST", "/v3/memory", request);
    assert.equal(answer.status, 200, answer.text);
    return JSON.parse(answer.text) as MemoryResult<T>;
  };
  const ok = async <T>(request: Record<string, unknown>): Promise<T> => {
    const answer = await memory<T>(request);
    assert.ok(answer.ok, JSON.stringify(answer));
    return answer.value;
  };
  const write = async (...ops: HubOp[]) => {
    const answer = await call(owner, "POST", "/v3/ops", { ops });
    assert.equal(answer.status, 200, answer.text);
  };
  for (const [id, repoPath, title] of [[CHAT_A, "/work/accord", "Plans"], [CHAT_B, "/work/accord", "Releases"], [CHAT_C, "/work/other", "Other project"]]) {
    await write({ opId: randomUUID(), kind: "conversation.create", conversationId: id,
      conversation: { title, kind: "chat", repoPath, createdAt: new Date().toISOString(), metadata: { participants: [taylor] } } } as HubOp);
  }
  const say = (conversationId: string, content: string, role: "user" | "participant" = "user") => {
    const message: ChatMessage = role === "user"
      ? { id: randomUUID(), role, content, createdAt: new Date().toISOString(), status: "done" }
      : { id: randomUUID(), role, participantId: taylor.id, participantLabel: "taylor", content, createdAt: new Date().toISOString(), status: "done" };
    return write({ opId: message.id, kind: "message.create", conversationId, message } as HubOp);
  };
  const member = { conversationId: CHAT_A, participantId: taylor.id };
  return { ai, call, memory, ok, say, member, owner, storage };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value).slice(0, 1000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("with the User's key the server finds notes and messages by meaning and picks notes that fit a message; without it, by words", async (t) => {
  const h = await hub(t);
  const note = (title: string, body: string) => h.ok<MemoryNote>({ action: "write", ...h.member, requestId: randomUUID(), kind: "runbook", scope: "project", title, body, tags: [] });
  const release = await note("Shipping the beta", "Run the Release workflow on GitHub, then check the update feed.");
  await note("Lunch places", "Where the team eats on Fridays.");
  await note("Urgent alerts", "Telegram first, then the phone rings.");
  await h.say(CHAT_A, "Let's deploy the beta tonight.");
  await h.say(CHAT_B, "The beta release went out; the feed shows it.", "participant");
  await h.say(CHAT_B, "Lunch at noon?");
  await h.say(CHAT_C, "Deploy the other project's beta.");

  // No key: nothing is picked, the list is as before, and chats are searched by words.
  assert.deepEqual(await h.ok<SemanticSettingsView>({ action: "semantic-settings" }), { keySet: false });
  assert.deepEqual(await h.ok<MemoryPickValue>({ action: "pick", ...h.member, text: "release the beta" }), { enabled: false, notes: [] });
  const listed = await h.ok<MemoryIndexValue>({ action: "index", ...h.member, picks: true });
  assert.equal(listed.notes.length, 3);
  assert.equal(listed.picks, undefined);
  const byWords = await h.ok<ChatSearchValue>({ action: "chat-search", ...h.member, query: "deployment beta" });
  assert.equal(byWords.ranking, "any-word");
  // Only this project's chats: the other project's message is never found.
  assert.deepEqual(byWords.hits.map((hit) => hit.chatTitle).sort(), ["Plans", "Releases"]);
  assert.ok(byWords.hits.find((hit) => hit.chatTitle === "Plans")?.thisChat);
  assert.equal(byWords.hits.find((hit) => hit.chatTitle === "Releases")?.author, "taylor");
  assert.match(byWords.hits.find((hit) => hit.chatTitle === "Plans")?.snippet ?? "", /deploy the beta/);

  // The key: checked with OpenAI first, kept on the server, never given back.
  assert.match(JSON.stringify(await h.memory({ action: "semantic-key", key: "nope" })), /doesn't look like an OpenAI API key/);
  const refused = JSON.stringify(await h.memory({ action: "semantic-key", key: REFUSED_KEY }));
  assert.match(refused, /OpenAI refused the key/);
  assert.ok(!refused.includes(REFUSED_KEY.slice(8)));
  // Never in an address, where logs keep it.
  assert.equal((await h.call(h.owner, "GET", `/v3/memory?${new URLSearchParams({ request: JSON.stringify({ action: "semantic-key", key: GOOD_KEY }) })}`)).status, 400);
  const set = await h.memory<SemanticSettingsView>({ action: "semantic-key", key: GOOD_KEY });
  assert.ok(set.ok && set.value.keySet);
  assert.ok(!JSON.stringify(set).includes(GOOD_KEY));
  // Old notes and messages are printed in the background (system lines and the other project's too: search filters by project).
  const view = await until(() => h.ok<SemanticSettingsView>({ action: "semantic-settings" }), (value) => value.catchingUp === false);
  assert.equal(view.notesPrinted, 3);
  assert.equal(view.messagesPrinted, 4);
  assert.ok(!JSON.stringify(view).includes(GOOD_KEY));

  // Memory by meaning: Russian words the note does not hold find it first, with a passage.
  const found = await h.ok<MemorySearchValue>({ action: "search", ...h.member, query: "выкатка новой версии" });
  assert.equal(found.ranking, "meaning");
  assert.equal(found.notes[0]?.title, "Shipping the beta");
  assert.match(found.notes[0]?.snippet ?? "", /Release workflow/);
  assert.equal(found.notes.length, 1);

  // A message about releasing gets the release note; one about nothing gets none; a note given already is not given again.
  const picked = await h.ok<MemoryPickValue>({ action: "pick", ...h.member, text: "давай выпустим бету сегодня" });
  assert.deepEqual(picked.notes.map((item) => item.title), ["Shipping the beta"]);
  assert.equal(picked.enabled, true);
  assert.deepEqual((await h.ok<MemoryPickValue>({ action: "pick", ...h.member, text: "я дома" })).notes, []);
  assert.deepEqual((await h.ok<MemoryPickValue>({ action: "pick", ...h.member, text: "release it", shown: [{ id: release.id, version: release.version }] })).notes, []);
  // The list at a session's start gives way to the picks, for an app that adds them.
  const index = await h.ok<MemoryIndexValue>({ action: "index", ...h.member, picks: true });
  assert.deepEqual(index.notes, []);
  assert.equal(index.picks, true);
  assert.equal(index.more, 3);
  assert.equal((await h.ok<MemoryIndexValue>({ action: "index", ...h.member })).notes.length, 3);

  // Chats by meaning: Russian finds the English messages, only in this project.
  const chats = await h.ok<ChatSearchValue>({ action: "chat-search", ...h.member, query: "выкатка" });
  assert.equal(chats.ranking, "meaning");
  assert.deepEqual(chats.hits.map((hit) => hit.chatTitle).sort(), ["Plans", "Releases"]);

  // A new message is printed as it comes.
  await h.say(CHAT_B, "Telegram alert rang my phone twice.");
  await until(() => h.ok<SemanticSettingsView>({ action: "semantic-settings" }), (value) => value.messagesPrinted === 5);
  const alerts = await h.ok<ChatSearchValue>({ action: "chat-search", ...h.member, query: "тревога звонок", limit: 1 });
  assert.match(alerts.hits[0]?.snippet ?? "", /Telegram alert rang/);

  // OpenAI down: the same search by words, and no picks.
  h.ai.state.down = true;
  const fallback = await h.ok<MemorySearchValue>({ action: "search", ...h.member, query: "release workflow" });
  assert.equal(fallback.ranking, "any-word");
  assert.equal(fallback.notes[0]?.title, "Shipping the beta");
  assert.deepEqual((await h.ok<MemoryPickValue>({ action: "pick", ...h.member, text: "release" })).notes, []);
  h.ai.state.down = false;

  // OpenAI stops taking the key: said in Settings, and the server goes back to words.
  h.ai.state.refuseAll = true;
  await h.ok({ action: "pick", ...h.member, text: "release again" });
  const stopped = await h.ok<SemanticSettingsView>({ action: "semantic-settings" });
  assert.match(stopped.keyError ?? "", /OpenAI refused the key/);
  assert.equal((await h.ok<MemoryPickValue>({ action: "pick", ...h.member, text: "release" })).enabled, false);
  h.ai.state.refuseAll = false;

  // Removed: Settings shows no key.
  assert.deepEqual(await h.ok<SemanticSettingsView>({ action: "semantic-key", remove: true }), { keySet: false });
  assert.deepEqual([...h.ai.state.keys].sort(), [GOOD_KEY, REFUSED_KEY].sort());
});

test("a server restarted with the key reads the prints it kept and prints only what is new", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-semantic-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  const ai = openAi();
  const start = async () => {
    const composed = composeHub({ storage, hubId: "hub-semantic-restart", version: "test", keys: vapid(), log: () => undefined, fetchImpl: ai.fetchImpl });
    const http = await composed.server.listenHttp(0, "127.0.0.1");
    return { composed, base: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
  };
  const ask = async (base: string, request: Record<string, unknown>) => {
    const text = JSON.stringify(request);
    const response = await fetch(`${base}/v3/memory`, { method: "POST", body: text,
      headers: { "content-type": "application/json", authorization: signHubRequest(owner, { method: "POST", pathWithQuery: "/v3/memory", body: text }) } });
    return (await response.json() as MemoryResult<SemanticSettingsView>);
  };
  const first = await start();
  const write = async (base: string, ops: HubOp[]) => {
    const text = JSON.stringify({ ops });
    await fetch(`${base}/v3/ops`, { method: "POST", body: text,
      headers: { "content-type": "application/json", authorization: signHubRequest(owner, { method: "POST", pathWithQuery: "/v3/ops", body: text }) } });
  };
  await write(first.base, [{ opId: randomUUID(), kind: "conversation.create", conversationId: CHAT_A,
    conversation: { title: "Plans", kind: "chat", repoPath: "/work/accord", createdAt: new Date().toISOString(), metadata: { participants: [taylor] } } } as HubOp]);
  const message = (content: string): HubOp => {
    const id = randomUUID();
    return { opId: id, kind: "message.create", conversationId: CHAT_A, message: { id, role: "user", content, createdAt: new Date().toISOString(), status: "done" } } as HubOp;
  };
  await write(first.base, [message("Deploy the beta."), message("Lunch at noon.")]);
  assert.ok((await ask(first.base, { action: "semantic-key", key: GOOD_KEY })).ok);
  await until(async () => (await ask(first.base, { action: "semantic-settings" })), (value) => value.ok && value.value.catchingUp === false && value.value.messagesPrinted === 2);
  await first.composed.close();
  const inputsBefore = ai.state.inputs;

  const second = await start();
  t.after(() => second.composed.close());
  await write(second.base, [message("The phone alert rang.")]);
  const after = await until(async () => (await ask(second.base, { action: "semantic-settings" })), (value) => value.ok && value.value.catchingUp === false && value.value.messagesPrinted === 3);
  assert.ok(after.ok);
  // Only the new message was sent to OpenAI again.
  assert.equal(ai.state.inputs - inputsBefore, 1);
});
