// The worker's MCP stub ships to the box as a script string. Nothing typechecks
// it and, until this file, nothing had ever executed one of its tool handlers —
// which is how a handler that returned a Promise nobody awaited would have gone
// to a real worker unnoticed.
//
// This runs the shipped source: it lifts the handler out of the exact string
// the desktop uploads and drives it against a run-start snapshot of the shape
// chat.ts now produces.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { detachedWorkerScript } = require(path.join(repoRoot, "dist/main/main/services/remoteRuns.js"));

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SNAPSHOT = {
  conversationId: "conversation-1",
  participantId: "participant-taylor",
  attachments: [
    {
      messageId: "m1",
      sequence: 0,
      author: "User",
      attachment: { id: "att-old", filename: "old.png", mimeType: "image/png", sizeBytes: 68 },
      dataBase64: PIXEL
    },
    {
      messageId: "m3",
      sequence: 2,
      author: "User",
      attachment: { id: "att-report", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 68 },
      dataBase64: PIXEL
    }
  ],
  attachmentWindow: { omittedCount: 1, limit: 6 },
  messages: [
    { id: "m1", sequence: 0, role: "user", content: "the bug report", metadata: {} },
    { id: "m2", sequence: 1, role: "participant", participantLabel: "@gera", content: "a reply", metadata: { threadId: "thread-1" } },
    { id: "m3", sequence: 2, role: "user", content: "one more", metadata: {} }
  ],
  messageWindow: { maxSequence: 2, totalMessages: 3, oldestIncludedSequence: 0 }
};

/** Loads the shipped worker script up to the point where it starts listening,
 *  with the filesystem intercepted. Everything above that point is declarations
 *  the handlers close over — appendEvent, the sequence counter, contextSnapshot
 *  — so slicing narrower silently loses them. */
function loadShippedWorker(snapshot, appended = []) {
  const script = detachedWorkerScript();
  const body = script.slice(0, script.indexOf("function startRelay"));
  const fsStub = {
    readFileSync: () => JSON.stringify(snapshot),
    existsSync: () => true,
    appendFileSync: (_file, line) => appended.push(JSON.parse(line)),
    writeFileSync() {},
    mkdirSync() {},
    unlinkSync() {}
  };
  const sandbox = {
    console, Buffer, JSON, Math, Date, isFinite, Promise, setTimeout, clearTimeout, process,
    require: (name) => (name === "node:fs" || name === "fs" ? fsStub : require(name))
  };
  vm.createContext(sandbox);
  vm.runInContext(`${body}\nglobalThis.__handle = handleRpcRequest;`, sandbox);
  assert.ok(sandbox.__handle, "the shipped script must define handleRpcRequest");
  return {
    appended,
    raw: (name, args) => sandbox.__handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args ?? {} }
    }),
    list: () => sandbox.__handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  };
}

function shippedHandler(snapshot) {
  const worker = loadShippedWorker(snapshot);
  return async (name, args) => JSON.parse((await worker.raw(name, args)).result.content[0].text);
}

test("the worker advertises the chat read tool", async () => {
  const listed = await loadShippedWorker({}).list();
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("app_chat_read_messages"), `tools/list must offer the reader: ${names.join(", ")}`);
  const reader = listed.result.tools.find((tool) => tool.name === "app_chat_read_messages");
  // A member must be able to tell a quiet chat from a stale window.
  assert.match(reader.description, /fixed at run start/);
});

test("the worker serves chat messages with the desktop tool's semantics", async () => {
  const call = shippedHandler(SNAPSHOT);

  const all = await call("app_chat_read_messages");
  assert.equal(all.ok, true);
  assert.deepEqual(all.messages.map((message) => message.id), ["m1", "m2", "m3"]);
  assert.equal(all.snapshotAtRunStart, true, "the answer states that the window is fixed at run start");
  assert.equal(all.page.totalMessages, 3);

  // A bare limit reads the NEWEST, as the desktop tool does — a member asking
  // for "the last few" must not get the beginning of history.
  assert.deepEqual((await call("app_chat_read_messages", { limit: 2 })).messages.map((m) => m.id), ["m2", "m3"]);

  // A forward page reads from the start of the match instead.
  assert.deepEqual((await call("app_chat_read_messages", { afterSequence: 0, limit: 2 })).messages.map((m) => m.id), ["m2", "m3"]);

  // Both bounds are exclusive.
  assert.deepEqual((await call("app_chat_read_messages", { beforeSequence: 2 })).messages.map((m) => m.id), ["m1", "m2"]);

  assert.deepEqual((await call("app_chat_read_messages", { threadId: "thread-1" })).messages.map((m) => m.id), ["m2"]);

  // An explicit id ignores every other filter, including one that contradicts it.
  const byId = await call("app_chat_read_messages", { messageId: "m1", threadId: "thread-1", limit: 1 });
  assert.deepEqual(byId.messages.map((m) => m.id), ["m1"]);

  // Paging flags describe the snapshot honestly.
  const page = await call("app_chat_read_messages", { limit: 1 });
  assert.equal(page.page.hasMoreBefore, true);
  assert.equal(page.page.hasMoreAfter, false);
});

test("the worker lists the images bundled with the run, and says what it dropped", async () => {
  const call = shippedHandler(SNAPSHOT);
  const listed = await call("app_chat_list_attachments");
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.attachments.map((item) => item.attachment.id), ["att-old", "att-report"]);
  // Silence about a dropped image reads as "there were none".
  assert.equal(listed.omittedCount, 1);
  assert.equal(listed.snapshotAtRunStart, true);
  // Bytes never ride along in the listing.
  assert.ok(!JSON.stringify(listed).includes(PIXEL), "the list must not carry image bytes");

  assert.deepEqual(
    (await call("app_chat_list_attachments", { messageId: "m3" })).attachments.map((item) => item.attachment.id),
    ["att-report"]
  );
});

test("the worker returns a bundled image as image content", async () => {
  const worker = loadShippedWorker(SNAPSHOT);
  const response = await worker.raw("app_chat_read_attachment", { attachmentId: "att-report" });
  const content = response.result.content;
  const image = content.find((part) => part.type === "image");
  assert.ok(image, "an image read must return image content, not a base64 string in prose");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, PIXEL);
  const summary = JSON.parse(content.find((part) => part.type === "text").text);
  assert.equal(summary.messageId, "m3");
  assert.equal(summary.dataBase64, "[omitted: returned as MCP image content]", "the bytes must not be duplicated in the text part");

  // An id that was not bundled refuses with a reason and a next step.
  const denied = await worker.raw("app_chat_read_attachment", { attachmentId: "att-missing" });
  assert.ok(denied.error, "an absent attachment is an error, not an empty image");
  assert.match(denied.error.message, /app_chat_list_attachments/);
});

test("a mid-run post is queued honestly, not claimed as sent", async () => {
  const appended = [];
  const worker = loadShippedWorker(SNAPSHOT, appended);
  const call = async (args) => worker.raw("app_chat_send_message", args);

  const posted = JSON.parse((await call({ content: "  halfway through, all green so far  " })).result.content[0].text);
  assert.equal(posted.ok, true);
  assert.equal(posted.status, "queued_for_desktop");
  // A fabricated message id would be a lie the member then quotes back.
  assert.equal(posted.messageId, undefined);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, "chat_message");
  assert.equal(appended[0].content, "halfway through, all green so far", "content is trimmed once, at the edge");
  assert.ok(appended[0].workerSeq > 0, "the event must be sequenced so the desktop can order it");

  // Empty text is refused rather than posting a blank row.
  const empty = await call({ content: "   " });
  assert.ok(empty.error);
  assert.match(empty.error.message, /non-empty content/);

  // An image the member believes it sent, and did not, is worse than a refusal.
  const withImage = await call({ content: "look", attachments: [{ kind: "image", sourcePath: "a.png" }] });
  assert.ok(withImage.error);
  assert.match(withImage.error.message, /attachments cannot be sent from a cloud run/);

  assert.equal(appended.length, 1, "a refused post must not queue anything");
});

test("an empty snapshot answers rather than throwing", async () => {
  const call = shippedHandler({});
  const empty = await call("app_chat_read_messages");
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.page.hasMoreBefore, false);
});
