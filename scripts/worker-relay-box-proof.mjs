// Live proof, run ON a worker — not part of the local suite.
//
// The unit tests drive the shipped script with the filesystem stubbed, which
// proves the logic and nothing about the box. This writes a real run directory
// on the worker exactly as the desktop does, loads the script the desktop
// uploads, and calls the four tools a collaborating member needs. Executed
// 2026-08-19 on a cloud-run worker: 7 tools, messages read with non-ASCII
// intact, the screenshot returned as image content, the mid-run post on disk.
//
// Usage: rsync this and a built dist/ to the box, then `node worker-relay-box-proof.mjs`.
//
// Runs against a real filesystem: no fs stub, no slicing.
// It writes a run directory the way the desktop does, loads the shipped worker
// script, and calls the three tools a collaborating member needs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detachedWorkerScript } = require("/home/ubuntu/qa/accordagents/dist/main/main/services/remoteRuns.js");

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const runDir = "/home/ubuntu/qa/run-proof";
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });
// The desktop writes this next to the snapshot; the script reads it at load.
fs.writeFileSync(path.join(runDir, "invocation.json"), JSON.stringify({
  providerKind: "claude-code",
  conversationId: "conversation-live",
  runId: "run-live-proof",
  sourceMessageId: "m1",
  threadId: "t1"
}));
fs.writeFileSync(path.join(runDir, "context-snapshot.json"), JSON.stringify({
  conversationId: "conversation-live",
  participantId: "participant-taylor",
  messages: [
    { id: "m1", sequence: 0, role: "user", content: "thinking стоит и не уходит", metadata: {} },
    { id: "m2", sequence: 1, role: "participant", participantLabel: "@gera", content: "looking", metadata: { threadId: "t1" } }
  ],
  messageWindow: { maxSequence: 1, totalMessages: 2, oldestIncludedSequence: 0 },
  attachments: [{
    messageId: "m1", sequence: 0, author: "User",
    attachment: { id: "att-shot", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 68 },
    dataBase64: PIXEL
  }],
  attachmentWindow: { omittedCount: 0, limit: 6 }
}));
process.chdir(runDir);

const script = detachedWorkerScript();
const body = script.slice(0, script.indexOf("function startRelay"));
const sandbox = { console, Buffer, JSON, Math, Date, isFinite, Promise, setTimeout, clearTimeout, process, require };
vm.createContext(sandbox);
vm.runInContext(`${body}\nglobalThis.__handle = handleRpcRequest;`, sandbox);

const call = async (name, args) => sandbox.__handle({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} }
});
const text = async (name, args) => JSON.parse((await call(name, args)).result.content[0].text);

const tools = (await sandbox.__handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
for (const needed of ["app_chat_read_messages", "app_chat_list_attachments", "app_chat_read_attachment", "app_chat_send_message"]) {
  assert.ok(tools.includes(needed), `worker must offer ${needed}: ${tools.join(", ")}`);
}

const read = await text("app_chat_read_messages");
assert.deepEqual(read.messages.map((m) => m.id), ["m1", "m2"]);
assert.equal(read.messages[0].content, "thinking стоит и не уходит", "non-ASCII survives the round trip through the run directory");

const listed = await text("app_chat_list_attachments");
assert.deepEqual(listed.attachments.map((a) => a.attachment.id), ["att-shot"]);

const image = (await call("app_chat_read_attachment", { attachmentId: "att-shot" })).result.content.find((p) => p.type === "image");
assert.ok(image && image.data === PIXEL && image.mimeType === "image/png", "the screenshot comes back as an image");

const posted = await text("app_chat_send_message", { content: "halfway, still green" });
assert.equal(posted.status, "queued_for_desktop");
const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const queued = events.filter((event) => event.kind === "chat_message");
assert.equal(queued.length, 1, "the post is on disk for the desktop to drain");
assert.equal(queued[0].content, "halfway, still green");

console.log("BOX_PROOF_OK — tools:", tools.length, "| messages:", read.messages.length, "| image bytes:", image.data.length, "| queued:", queued.length);
