import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "../../main/services/storage";
import type { ChatMessage, Conversation } from "../../shared/types";
import { HubSemantic, type PrintableNote } from "./hubSemantic";
import { EmbeddingError, OpenAiEmbeddings } from "./openAiEmbeddings";
import { searchProjectChats } from "./projectChatSearch";

/**
 * Search by meaning when things happen at once: a key changed while OpenAI
 * answers for the old one, a message hidden while it is printed, a note
 * written while old ones are caught up, the database failing, the key
 * removed. OpenAI is a stand-in whose answers can be held back.
 */

const KEY_ONE = `sk-proj-${"1".repeat(40)}`;
const KEY_TWO = `sk-proj-${"2".repeat(40)}`;

function print(text: string): number[] {
  const values = new Array<number>(1536).fill(0);
  let hash = 0;
  for (const character of text.toLowerCase()) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  values[hash % 1536] = 1;
  values[(hash >>> 11) % 1536] += 0.5;
  return values;
}

interface Held {
  inputs: string[];
  key: string;
  release(status?: number, error?: Record<string, unknown>): void;
}

function openAi() {
  const state = {
    inputs: 0, answered: 0, held: [] as Held[], sent: [] as string[][],
    hold: undefined as ((inputs: string[], key: string) => boolean) | undefined,
    /** Texts OpenAI will not print (400). */
    refuse: undefined as ((input: string) => boolean) | undefined
  };
  const answer = (inputs: string[]) => {
    state.inputs += inputs.length;
    state.answered += 1;
    return new Response(JSON.stringify({ data: inputs.map((input, index) => ({ index, embedding: print(input) })) }), { status: 200 });
  };
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /, "");
    const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    state.sent.push(inputs);
    if (state.refuse && inputs.some(state.refuse)) return new Response(JSON.stringify({ error: { message: "Invalid input" } }), { status: 400 });
    if (!state.hold?.(inputs, key)) return answer(inputs);
    return new Promise<Response>((resolve) => {
      state.held.push({
        inputs, key,
        release: (status = 200, error) => {
          if (status === 200) resolve(answer(inputs));
          else {
            state.answered += 1;
            resolve(new Response(JSON.stringify({ error }), { status }));
          }
        }
      });
    });
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function setUp(
  t: test.TestContext,
  notes: () => Promise<PrintableNote[]> | PrintableNote[] = () => [],
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5))
) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-semantic-races-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const ai = openAi();
  const made: HubSemantic[] = [];
  const make = async () => {
    const semantic = new HubSemantic({ storage, fetchImpl: ai.fetchImpl, sleep });
    semantic.setNoteSource({ notesPage: async (afterId) => (afterId ? [] : await notes()) });
    await semantic.start();
    made.push(semantic);
    return semantic;
  };
  t.after(async () => {
    for (const semantic of made) await semantic.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { storage, ai, make };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function printRows(storage: StorageService, itemId: string): Promise<number> {
  const rows = await storage.sqlExecutor().queryJson<{ total: number }>(`select count(*) as total from semantic_prints where item_id = '${itemId}';`);
  return Number(rows[0]?.total ?? 0);
}

test("OpenAI refusing the old key late does not stop the key given since", async (t) => {
  const { ai, make } = await setUp(t);
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up");
  ai.state.hold = (inputs, key) => key === KEY_ONE && inputs[0] === "what was decided";
  const asked = semantic.printQuery("what was decided", 10_000);
  await until(() => ai.state.held.length === 1, "the query reached OpenAI");
  assert.ok((await semantic.setKey(KEY_TWO)).ok);
  ai.state.held[0].release(401, { message: "Incorrect API key provided" });
  assert.equal(await asked, undefined);
  assert.ok(semantic.enabled());
  assert.equal((await semantic.view()).keyError, undefined);
});

test("a note written while old notes are caught up is kept when the pass ends", async (t) => {
  let semantic: HubSemantic | undefined;
  const written: PrintableNote = { id: "note-new", title: "Written meanwhile", tags: [], body: "Came while the old notes were read." };
  // The note comes after the pass read its page: the pass never sees it.
  const { storage, make } = await setUp(t, () => {
    semantic?.noteChanged(written);
    return [];
  });
  semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic!.complete(), "caught up");
  assert.ok(semantic.noteCloseness(print("x"), ["note-new"]).has("note-new"));
  assert.equal(await printRows(storage, "note-new"), 1);
});

test("old notes are caught up after the database failed once", async (t) => {
  let calls = 0;
  const note: PrintableNote = { id: "note-old", title: "Old note", tags: [], body: "Kept from before." };
  const { make } = await setUp(t, () => {
    calls += 1;
    if (calls === 1) throw new Error("database is locked");
    return [note];
  });
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up after the retry");
  assert.ok(semantic.noteCloseness(print("x"), ["note-old"]).has("note-old"));
  assert.ok(semantic.ready());
});

test("a message hidden while OpenAI prints it is not kept, nor found", async (t) => {
  const { storage, ai, make } = await setUp(t);
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up");
  ai.state.hold = (inputs) => inputs.some((input) => input.includes("secret plan"));
  const message = { id: "m-secret", role: "user" as const, status: "done", content: "The secret plan for the release." };
  semantic.messageChanged("chat-1", message);
  await until(() => ai.state.held.length === 1, "the message reached OpenAI");
  semantic.messageChanged("chat-1", { ...message, metadata: { hiddenFromTimeline: true } });
  ai.state.held[0].release();
  // Printed in order: once the next message is kept, the hidden one was handled.
  semantic.messageChanged("chat-1", { id: "m-next", role: "user", status: "done", content: "Lunch at noon." });
  await until(async () => (await semantic.messageCloseness(print("x"), new Set(["chat-1"]), 10)).some((item) => item.messageId === "m-next"), "the next message kept");
  assert.ok(!(await semantic.messageCloseness(print("x"), new Set(["chat-1"]), 10)).some((item) => item.messageId === "m-secret"));
  assert.equal(await printRows(storage, "m-secret"), 0);
});

test("removing the key lets the prints go from memory; given again, they are read back without OpenAI", async (t) => {
  const note: PrintableNote = { id: "note-kept", title: "Kept", tags: [], body: "A note printed once." };
  const { ai, make } = await setUp(t, () => [note]);
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up");
  assert.equal(semantic.noteCloseness(print("x"), ["note-kept"]).size, 1);
  await semantic.removeKey();
  assert.equal(semantic.noteCloseness(print("x"), ["note-kept"]).size, 0);
  assert.deepEqual(await semantic.view(), { keySet: false });
  const inputsBefore = ai.state.inputs;
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up again");
  assert.equal(semantic.noteCloseness(print("x"), ["note-kept"]).size, 1);
  // Only the key's check went to OpenAI.
  assert.equal(ai.state.inputs - inputsBefore, 1);
});

test("a note kept with a passage missing is printed again when the server starts", async (t) => {
  const note: PrintableNote = { id: "note-long", title: "Long", tags: [], body: `${"word ".repeat(400)}` };
  const { storage, ai, make } = await setUp(t, () => [note]);
  const first = await make();
  assert.ok((await first.setKey(KEY_ONE)).ok);
  await until(() => first.complete(), "caught up");
  assert.equal(await printRows(storage, "note-long"), 2);
  await first.close();
  await storage.sqlExecutor().runSql("delete from semantic_prints where item_id = 'note-long' and part = 0;");
  const inputsBefore = ai.state.inputs;
  const second = await make();
  await until(() => second.complete(), "caught up after the restart");
  assert.equal(ai.state.inputs - inputsBefore, 2);
  assert.equal(await printRows(storage, "note-long"), 2);
});

test("no credit left is told by OpenAI's code, not by a message that names a quota", async () => {
  const answer = (status: number, error: Record<string, unknown>) => (async () => new Response(JSON.stringify({ error }), { status })) as unknown as typeof fetch;
  const noCredit = await new OpenAiEmbeddings(KEY_ONE, answer(429, { message: "You exceeded your current quota.", code: "insufficient_quota" })).embed(["x"], 1000).catch((error: unknown) => error);
  assert.ok(noCredit instanceof EmbeddingError && noCredit.kind === "key");
  const slowDown = await new OpenAiEmbeddings(KEY_ONE, answer(429, { message: "Rate limit reached for requests per min; your quota resets soon.", code: "rate_limit_exceeded" })).embed(["x"], 1000).catch((error: unknown) => error);
  assert.ok(slowDown instanceof EmbeddingError && slowDown.kind === "rate");
});

test("a chat search with neither meaning nor words to search by says so instead of finding nothing", async (t) => {
  const { storage } = await setUp(t);
  const result = await searchProjectChats({ storage, log: () => undefined }, { conversationId: "chat-1", projectPath: "/work" }, { query: "release plan" });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "server_unavailable");
});

test("after Remove key, the rest of a batch OpenAI refused one text of is not sent", async (t) => {
  const { ai, make } = await setUp(t);
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up");
  // The batch fails on one text; then each is sent alone, the first one held.
  ai.state.refuse = (input) => input === "bad text";
  ai.state.hold = (inputs) => inputs.length === 1 && inputs[0] === "first of three";
  for (const [id, content] of [["m1", "first of three"], ["m2", "bad text"], ["m3", "third of three"]]) {
    semantic.messageChanged("chat-1", { id, role: "user", status: "done", content });
  }
  await until(() => ai.state.held.length === 1, "the first text alone reached OpenAI");
  await semantic.removeKey();
  ai.state.held[0].release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!ai.state.sent.some((inputs) => inputs.length === 1 && inputs[0] === "third of three"), JSON.stringify(ai.state.sent));
});

test("an answer from OpenAI that stops half way ends at the time limit", async () => {
  const stalled = (async () => new Response(new ReadableStream({ start() { /* never sends nor closes */ } }), { status: 200 })) as unknown as typeof fetch;
  const started = Date.now();
  const failed = await new OpenAiEmbeddings(KEY_ONE, stalled).embed(["x"], 200).catch((error: unknown) => error);
  assert.ok(failed instanceof EmbeddingError && failed.kind === "other", String(failed));
  assert.ok(Date.now() - started < 5_000);
});

test("an edit undone while the edited text is printed keeps the print of the text the message has", async (t) => {
  const { ai, make } = await setUp(t);
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up");
  const original = "The plan as first written.";
  semantic.messageChanged("chat-1", { id: "m-edit", role: "user", status: "done", content: original });
  await until(async () => (await semantic.messageCloseness(print(original), new Set(["chat-1"]), 5)).some((item) => item.messageId === "m-edit"), "printed");
  ai.state.hold = (inputs) => inputs.includes("The plan, edited.");
  semantic.messageChanged("chat-1", { id: "m-edit", role: "user", status: "done", content: "The plan, edited." });
  await until(() => ai.state.held.length === 1, "the edit reached OpenAI");
  semantic.messageChanged("chat-1", { id: "m-edit", role: "user", status: "done", content: original });
  ai.state.held[0].release();
  semantic.messageChanged("chat-1", { id: "m-after", role: "user", status: "done", content: "A later line." });
  await until(async () => (await semantic.messageCloseness(print("x"), new Set(["chat-1"]), 10)).some((item) => item.messageId === "m-after"), "the later line kept");
  const found = (await semantic.messageCloseness(print(original), new Set(["chat-1"]), 5)).find((item) => item.messageId === "m-edit");
  assert.ok(found && found.score > 0.99, JSON.stringify(found));
});

test("a reply with long posts is printed alike as it comes and when read back from the database", async (t) => {
  const { storage, ai, make } = await setUp(t);
  const longPost = `${"Long finding about the release. ".repeat(900)}`;
  const reply: ChatMessage = {
    id: "m-posts", role: "participant", participantId: "p1", participantLabel: "taylor", status: "done", createdAt: new Date().toISOString(),
    content: "Done.", metadata: { interimPosts: [{ id: "post-1", content: longPost, createdAt: new Date().toISOString() }] } as ChatMessage["metadata"]
  };
  const conversation = { id: "chat-1", title: "Plans", kind: "chat", createdAt: reply.createdAt, updatedAt: reply.createdAt, messages: [reply], findings: [],
    metadata: { participantSessions: [], warnings: [], running: false } } as unknown as Conversation;
  await storage.saveConversation(conversation);
  const semantic = await make();
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => semantic.complete(), "caught up");
  assert.equal((await semantic.messageCloseness(print("x"), new Set(["chat-1"]), 5)).length, 1);
  const inputsBefore = ai.state.inputs;
  // The same reply as it comes again (a change elsewhere in it): nothing to print.
  semantic.messageChanged("chat-1", reply);
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  assert.equal(ai.state.inputs, inputsBefore);
});

test("a new key does not wait behind the old key's pause after a failure", async (t) => {
  const note: PrintableNote = { id: "note-wait", title: "Waits", tags: [], body: "Printed once a key works." };
  // A pause ends only when its work is called off.
  const { ai, make } = await setUp(t, () => [note], (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })));
  const semantic = await make();
  ai.state.hold = (inputs, key) => key === KEY_ONE && inputs[0] !== "test";
  assert.ok((await semantic.setKey(KEY_ONE)).ok);
  await until(() => ai.state.held.length === 1, "the old key's batch reached OpenAI");
  ai.state.held[0].release(500, { message: "Server error" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await semantic.setKey(KEY_TWO)).ok);
  await until(() => semantic.complete() && semantic.noteCloseness(print("x"), ["note-wait"]).size === 1, "printed with the new key", 5_000);
});
