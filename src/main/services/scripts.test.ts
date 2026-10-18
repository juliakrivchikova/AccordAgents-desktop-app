import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { AppMcpService } from "./appMcp";
import { ScriptService, type ScriptChatGateway } from "./scripts";
import { ScriptSecretStore, ScriptStore } from "./scriptStore";
import type { ChatScriptChangeRequest } from "../../shared/scripts";

interface Posted {
  conversationId: string;
  scriptName: string;
  content: string;
  participantIds: string[];
}

const plainCipher = {
  isEncryptionAvailable: () => false,
  encryptString: (plain: string) => Buffer.from(plain, "utf8"),
  decryptString: (cipher: Buffer) => cipher.toString("utf8")
};

async function harness(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "accord-scripts-"));
  const appMcp = new AppMcpService();
  await appMcp.start();
  const posted: Posted[] = [];
  const chat: ScriptChatGateway = {
    describeChat: async (chatId) => chatId === "chat-1"
      ? { id: "chat-1", title: "Alerts", archived: false, participants: [{ id: "p-taylor", handle: "taylor" }, { id: "p-drew", handle: "drew" }] }
      : undefined,
    postScriptMessage: async (input) => {
      posted.push({ conversationId: input.conversationId, scriptName: input.scriptName, content: input.content, participantIds: input.participantIds });
      return { messageId: `m-${posted.length}` };
    }
  };
  const store = new ScriptStore(path.join(root, "scripts"));
  const secrets = new ScriptSecretStore(path.join(root, "script-secrets.json"), plainCipher);
  const service = new ScriptService({
    store,
    secrets,
    hostId: "desktop",
    hostLabel: "This Mac",
    hostPhrase: "this Mac",
    tokens: appMcp,
    chat,
    node: { command: process.execPath, env: {} },
    tickMs: 60_000
  });
  appMcp.setScriptApiHandler((context, _route, body) => service.postFromScript(context, body));
  t.after(async () => {
    await service.stop();
    await appMcp.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, appMcp, posted, store, secrets, service };
}

const POSTER = `
const res = await fetch(process.env.ACCORD_API_URL + "/messages", {
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ chatId: "chat-1", text: "@taylor alert " + (process.env.ALERT_KEY ?? "none"), mentions: ["@taylor"], idempotencyKey: process.env.IDEMPOTENCY ?? undefined })
});
const body = await res.json();
console.log("status", body.status ?? body.error);
console.log("env", Object.keys(process.env).sort().join(","));
console.log("secret is", process.env.ALERT_KEY);
console.log("key length", (process.env.ALERT_KEY ?? "").length);
if (!body.ok) process.exit(3);
`;

async function approvedScript(
  h: Awaited<ReturnType<typeof harness>>,
  overrides: Record<string, unknown> = {},
  secrets: Record<string, string> = { ALERT_KEY: "sekret-value-123" }
): Promise<ChatScriptChangeRequest> {
  const proposal = await h.service.proposeChange({
    conversationId: "chat-1",
    requesterParticipantId: "p-taylor",
    requesterLabel: "@taylor",
    request: {
      op: "create",
      name: "Alert watcher",
      description: "Posts alerts.",
      runtime: "node",
      files: [{ path: "watch.mjs", content: POSTER }],
      schedule: { kind: "interval", everySeconds: 3600 },
      secretNames: Object.keys(secrets),
      members: ["@taylor"],
      ...overrides
    }
  });
  assert.equal(proposal.kind, "approval");
  if (proposal.kind !== "approval") throw new Error("unreachable");
  for (const [name, value] of Object.entries(secrets)) {
    await h.service.setSecret(proposal.request.scriptId, name, value);
  }
  await h.service.applyApproved(proposal.request);
  return proposal.request;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function finishedRuns(h: Awaited<ReturnType<typeof harness>>, scriptId: string, count = 1) {
  return waitFor(async () => {
    const runs = await h.service.runs(scriptId);
    const done = runs.filter((row) => row.status !== "skipped" && row.status !== "missed");
    const total = done.reduce((sum, row) => sum + row.count, 0);
    return total >= count && !(await h.service.summary(scriptId)).running ? runs : undefined;
  });
}

test("a proposal cannot be approved until its keys are saved, and the agent never gets the values", async (t) => {
  const h = await harness(t);
  const proposal = await h.service.proposeChange({
    conversationId: "chat-1",
    requesterParticipantId: "p-taylor",
    requesterLabel: "@taylor",
    request: {
      op: "create",
      name: "Watcher",
      description: "d",
      runtime: "node",
      files: [{ path: "w.mjs", content: "console.log(1)" }],
      schedule: { kind: "interval", everySeconds: 60 },
      secretNames: ["SLACK_BOT_TOKEN"],
      members: ["@taylor"]
    }
  });
  assert.equal(proposal.kind, "approval");
  if (proposal.kind !== "approval") return;
  assert.deepEqual(proposal.missingSecretNames, ["SLACK_BOT_TOKEN"]);
  assert.equal(JSON.stringify(proposal.request).includes("console.log"), false, "the approval record carries no code");
  await assert.rejects(h.service.assertApprovable(proposal.request), /Enter the key SLACK_BOT_TOKEN/);
  await h.service.setSecret(proposal.request.scriptId, "SLACK_BOT_TOKEN", "xoxb-secret");
  await h.service.assertApprovable(proposal.request);
  const listed = JSON.stringify(await h.service.listForAgent("chat-1"));
  assert.equal(listed.includes("xoxb-secret"), false);
  assert.match(listed, /"saved":true/);
  const settingsLike = await readFile(path.join(h.root, "script-secrets.json"), "utf8");
  assert.equal(settingsLike.includes("xoxb-secret"), false, "stored encoded, never as plain text");
});

test("an approved script runs with only its own environment, posts through the script API and wakes the named member", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h);
  await h.service.tick();
  const runs = await finishedRuns(h, request.scriptId);
  assert.equal(runs[0]!.status, "ok", runs[0]!.outputTail);
  assert.equal(h.posted.length, 1);
  assert.deepEqual(h.posted[0]!.participantIds, ["p-taylor"]);
  assert.equal(h.posted[0]!.scriptName, "Alert watcher");
  assert.equal(runs[0]!.messagesSent, 1);
  const tail = runs[0]!.outputTail ?? "";
  const envLine = tail.split("\n").find((line) => line.startsWith("env ")) ?? "";
  const keys = envLine.slice(4).split(",");
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
  for (const key of keys.filter((item) => item !== "__CF_USER_TEXT_ENCODING")) {
    assert.ok(
      ["ACCORD_API_URL", "ACCORD_RUN_ID", "ACCORD_SCRIPT_ID", "ACCORD_SCRIPT_TOKEN", "ACCORD_STATE_DIR", "ALERT_KEY", "HOME", "LANG", "PATH", "TZ"].includes(key),
      `unexpected variable ${key}`
    );
  }
  assert.match(tail, /secret is •••/);
  assert.equal(tail.includes("sekret-value-123"), false, "key values are redacted from history");
  assert.match(tail, /key length 16/, "the script itself has the key");
  assert.equal(h.posted[0]!.content.includes("sekret-value-123"), false, "a key value never reaches the chat");
  assert.match(h.posted[0]!.content, /alert •••/);
});

test("a run's token stops working when the run ends", async (t) => {
  const h = await harness(t);
  const token = h.appMcp.issueScriptToken({ scriptId: "script-00000000-0000", runId: "r1" });
  const url = `${h.appMcp.scriptApiUrl()}/messages`;
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(response.status, 403);
  h.appMcp.revokeScriptToken(token);
  const after = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(after.status, 401);
  const agentPath = await fetch(url.replace("/script-api/messages", "/mcp"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(agentPath.status, 401, "a script token never opens the agent API");
});

test("the script may not post elsewhere or mention members it was not given", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    files: [{ path: "watch.mjs", content: `
      const post = (body) => fetch(process.env.ACCORD_API_URL + "/messages", { method: "POST", headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN }, body: JSON.stringify(body) }).then(async (r) => r.status + " " + (await r.json()).error);
      console.log(await post({ chatId: "chat-2", text: "x" }));
      console.log(await post({ chatId: "chat-1", text: "x", mentions: ["@drew"] }));
      console.log(await post({ chatId: "chat-1", text: "x", mentions: ["@nobody"] }));
    ` }]
  }, {});
  await h.service.tick();
  const runs = await finishedRuns(h, request.scriptId);
  const tail = runs[0]!.outputTail ?? "";
  assert.match(tail, /403 This script may not post to that chat/);
  assert.match(tail, /403 This script may not mention @drew/);
  assert.match(tail, /403 @nobody is not a member/);
  assert.equal(h.posted.length, 0);
});

test("over the hourly wake-up budget, messages are held and the User is told once", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    maxWakeupsPerHour: 1,
    files: [{ path: "watch.mjs", content: `
      for (const n of [1, 2, 3]) {
        const r = await fetch(process.env.ACCORD_API_URL + "/messages", { method: "POST", headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN }, body: JSON.stringify({ chatId: "chat-1", text: "@taylor " + n, mentions: ["@taylor"] }) });
        console.log((await r.json()).status);
      }
    ` }]
  }, {});
  await h.service.tick();
  const runs = await finishedRuns(h, request.scriptId);
  assert.match(runs[0]!.outputTail ?? "", /posted\nheld\nheld/);
  const wakeups = h.posted.filter((item) => item.participantIds.length > 0);
  const notices = h.posted.filter((item) => item.participantIds.length === 0);
  assert.equal(wakeups.length, 1);
  assert.equal(notices.length, 1, "one notice for the held episode");
  assert.match(notices[0]!.content, /Holding messages/);
  assert.equal((await h.service.summary(request.scriptId)).heldMessageCount, 2);
  await h.service.releaseHeld(request.scriptId);
  assert.equal(h.posted.filter((item) => item.participantIds.length > 0).length, 3);
  assert.equal((await h.service.summary(request.scriptId)).heldMessageCount, 0);
});

test("the same idempotency key posts once", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    files: [{ path: "watch.mjs", content: `
      for (const n of [1, 2]) {
        const r = await fetch(process.env.ACCORD_API_URL + "/messages", { method: "POST", headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN }, body: JSON.stringify({ chatId: "chat-1", text: "@taylor same", mentions: ["@taylor"], idempotencyKey: "k-1" }) });
        console.log((await r.json()).status);
      }
    ` }]
  }, {});
  await h.service.tick();
  const runs = await finishedRuns(h, request.scriptId);
  assert.match(runs[0]!.outputTail ?? "", /posted\nduplicate/);
  assert.equal(h.posted.length, 1);
});

test("failing and recovering each notify once; repeated failures share one history row", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    files: [{ path: "watch.mjs", content: `
      import { existsSync } from "node:fs";
      if (!existsSync(process.env.ACCORD_STATE_DIR + "/ok")) { console.error("Slack said invalid_auth"); process.exit(1); }
      console.log("fine");
    ` }]
  }, {});
  await h.service.runNow(request.scriptId);
  await finishedRuns(h, request.scriptId, 1);
  await h.service.runNow(request.scriptId);
  let runs = await finishedRuns(h, request.scriptId, 2);
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[0]!.count, 2, "two identical failures share a row");
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0]!.content, /Failing: Slack said invalid_auth/);
  assert.equal((await h.service.summary(request.scriptId)).health, "failing");
  await writeFile(path.join(h.store.stateDir(request.scriptId), "ok"), "");
  await h.service.runNow(request.scriptId);
  runs = await finishedRuns(h, request.scriptId, 3);
  assert.equal(runs[0]!.status, "ok");
  assert.equal(h.posted.length, 2);
  assert.match(h.posted[1]!.content, /Working again/);
  assert.equal((await h.service.summary(request.scriptId)).health, "ok");
});

test("files edited after approval block the script until a new version is approved", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h);
  await writeFile(path.join(h.store.filesDir(request.scriptId), "watch.mjs"), "console.log('tampered')");
  await h.service.runNow(request.scriptId);
  const runs = await waitFor(async () => {
    const rows = await h.service.runs(request.scriptId);
    return rows.length > 0 ? rows : undefined;
  });
  assert.equal(runs[0]!.status, "blocked");
  assert.equal((await h.service.summary(request.scriptId)).health, "blocked");
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0]!.content, /Blocked: Its files changed/);
});

test("a run missed by more than the grace period is recorded, not run, and the schedule stays on its grid", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h);
  const runtime = await h.store.readRuntime(request.scriptId);
  const due = Date.now() - 5 * 3600_000 - 1000;
  runtime.nextDueAt = new Date(due).toISOString();
  await h.store.writeRuntime(request.scriptId, runtime);
  await h.service.tick();
  const runs = await h.service.runs(request.scriptId);
  assert.equal(runs[0]!.status, "missed");
  assert.equal(h.posted.length, 0);
  const next = Date.parse((await h.store.readRuntime(request.scriptId)).nextDueAt!);
  assert.ok(next > Date.now());
  assert.equal((next - due) % 3600_000, 0, "anchored to the original schedule");
});

test("a due run while the previous one is still going is skipped", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    schedule: { kind: "interval", everySeconds: 60 },
    files: [{ path: "watch.mjs", content: "await new Promise((r) => setTimeout(r, 2000)); console.log('done');" }]
  }, {});
  await h.service.runNow(request.scriptId);
  await waitFor(async () => ((await h.service.summary(request.scriptId)).running ? true : undefined));
  const runtime = await h.store.readRuntime(request.scriptId);
  runtime.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await h.store.writeRuntime(request.scriptId, runtime);
  await h.service.tick();
  const runs = await finishedRuns(h, request.scriptId, 1);
  const statuses = runs.map((row) => row.status);
  assert.ok(statuses.includes("skipped"), statuses.join(","));
  assert.ok(statuses.includes("ok"), statuses.join(","));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("switching a script off stops the whole process group, grandchildren included", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    files: [{ path: "watch.mjs", content: `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      writeFileSync(process.env.ACCORD_STATE_DIR + "/child.pid", String(child.pid));
      await new Promise((r) => setTimeout(r, 30000));
    ` }]
  }, {});
  await h.service.runNow(request.scriptId);
  const pidFile = path.join(h.store.stateDir(request.scriptId), "child.pid");
  const childPid = await waitFor(async () => Number(await readFile(pidFile, "utf8").catch(() => "")) || undefined);
  assert.equal(alive(childPid), true);
  await h.service.setEnabled(request.scriptId, false);
  const runs = await finishedRuns(h, request.scriptId, 1);
  assert.equal(runs[0]!.status, "stopped");
  await waitFor(async () => (alive(childPid) ? undefined : true), 5000);
});

test("after a crash, a leftover run's process group is killed and recorded before anything else runs", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h);
  const runtime = await h.store.readRuntime(request.scriptId);
  runtime.nextDueAt = new Date(Date.now() + 3600_000).toISOString();
  await h.store.writeRuntime(request.scriptId, runtime);
  const leftover = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  leftover.unref();
  await h.store.writePid(request.scriptId, { pid: leftover.pid!, runId: "old", bootAt: Date.now() - uptime() * 1000, startedAt: new Date().toISOString() });
  await h.service.start();
  await waitFor(async () => (alive(leftover.pid!) ? undefined : true), 5000);
  const runs = await waitFor(async () => {
    const rows = await h.service.runs(request.scriptId);
    return rows.some((row) => row.status === "interrupted") ? rows : undefined;
  });
  assert.ok(runs.some((row) => row.status === "interrupted"));
  assert.equal(await h.store.readPid(request.scriptId), undefined);
});

test("declining a never-approved script removes it with its keys", async (t) => {
  const h = await harness(t);
  const proposal = await h.service.proposeChange({
    conversationId: "chat-1",
    requesterParticipantId: "p-taylor",
    requesterLabel: "@taylor",
    request: { op: "create", name: "W", description: "d", runtime: "bash", files: [{ path: "w.sh", content: "echo hi" }], schedule: { kind: "interval", everySeconds: 60 }, secretNames: ["TOKEN"] }
  });
  if (proposal.kind !== "approval") throw new Error("expected approval");
  await h.service.setSecret(proposal.request.scriptId, "TOKEN", "value-1234");
  await h.service.rejectPending(proposal.request);
  assert.deepEqual(await h.service.list(), []);
  assert.deepEqual(await h.secrets.savedNames(proposal.request.scriptId), []);
});

test("proposals are validated before anything is stored", async (t) => {
  const h = await harness(t);
  const base = { op: "create", name: "W", description: "d", runtime: "node", files: [{ path: "w.mjs", content: "1" }], schedule: { kind: "interval", everySeconds: 60 } };
  const propose = (request: Record<string, unknown>) => h.service.proposeChange({ conversationId: "chat-1", requesterParticipantId: "p-taylor", requesterLabel: "@taylor", request });
  await assert.rejects(propose({ ...base, files: [{ path: "../escape.mjs", content: "1" }] }), /may not leave/);
  await assert.rejects(propose({ ...base, schedule: { kind: "interval", everySeconds: 5 } }), /60/);
  await assert.rejects(propose({ ...base, chatIds: ["chat-404"] }), /only into existing chats/);
  await assert.rejects(propose({ ...base, members: ["@ghost"] }), /not a member/);
  await assert.rejects(propose({ ...base, secretNames: ["lowercase"] }), /UPPER_SNAKE_CASE/);
  await assert.rejects(propose({ ...base, files: [{ path: "w.mjs", content: "x".repeat(70 * 1024) }] }), /64 KB/);
  assert.deepEqual(await h.service.list(), []);
});

test("two starts at once run the script once", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, { files: [{ path: "w.mjs", content: "await new Promise((r) => setTimeout(r, 400)); console.log('one');" }] }, {});
  const results = await Promise.allSettled([h.service.runNow(request.scriptId), h.service.runNow(request.scriptId), h.service.tick()]);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1, "the second Run now is refused");
  const runs = await finishedRuns(h, request.scriptId, 1);
  const executed = runs.filter((row) => row.status === "ok").reduce((sum, row) => sum + row.count, 0);
  assert.equal(executed, 1);
});

test("a schedule that can never fire is refused before anything is stored", async (t) => {
  const h = await harness(t);
  await assert.rejects(
    h.service.proposeChange({ conversationId: "chat-1", requesterParticipantId: "p-taylor", requesterLabel: "@taylor", request: {
      op: "create", name: "W", description: "d", runtime: "bash", files: [{ path: "w.sh", content: "true" }],
      schedule: { kind: "cron", expression: "0 9 30 2 *", timeZone: "Europe/Berlin" }
    } }),
    /never fires/
  );
  assert.deepEqual(await h.service.list(), []);
});

test("a key value cut by the output limit leaves no fragment in the history", async (t) => {
  const h = await harness(t);
  const key = "KEYVALUE-abcdefghijklmnopqrstuvwxyz-0123456789";
  const request = await approvedScript(h, {
    files: [{ path: "w.mjs", content: "process.stdout.write(process.env.ALERT_KEY + 'x'.repeat(4076));" }]
  }, { ALERT_KEY: key });
  await h.service.runNow(request.scriptId);
  const runs = await finishedRuns(h, request.scriptId);
  const tail = runs[0]!.outputTail ?? "";
  for (let length = 6; length < key.length; length += 1) {
    assert.equal(tail.includes(key.slice(-length)), false, `fragment of ${length} chars survived`);
  }
  assert.ok(tail.length <= 4096 + 3);
});

test("what a script left running in the background is killed when it exits, and the run is still ok", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    runtime: "bash",
    entry: "w.sh",
    files: [{ path: "w.sh", content: "sleep 300 &\necho $! > \"$ACCORD_STATE_DIR/bg.pid\"\necho done\n" }],
    timeoutSeconds: 20
  }, {});
  await h.service.runNow(request.scriptId);
  const runs = await finishedRuns(h, request.scriptId);
  assert.equal(runs[0]!.status, "ok", runs[0]!.detail);
  const pid = Number(await readFile(path.join(h.store.stateDir(request.scriptId), "bg.pid"), "utf8"));
  await waitFor(async () => (alive(pid) ? undefined : true), 5000);
});

test("releasing held messages keeps the ones that could not be posted", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    maxWakeupsPerHour: 1,
    files: [{ path: "w.mjs", content: `
      for (const n of [1, 2, 3]) {
        await fetch(process.env.ACCORD_API_URL + "/messages", { method: "POST", headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN }, body: JSON.stringify({ chatId: "chat-1", text: "@taylor " + n, mentions: ["@taylor"] }) });
      }
    ` }]
  }, {});
  await h.service.runNow(request.scriptId);
  await finishedRuns(h, request.scriptId);
  assert.equal((await h.service.summary(request.scriptId)).heldMessageCount, 2);
  const original = (h.service as any).options.chat.postScriptMessage;
  (h.service as any).options.chat.postScriptMessage = async () => {
    throw new Error("A member the script mentions is no longer in this chat.");
  };
  await assert.rejects(h.service.releaseHeld(request.scriptId), /no longer in this chat/);
  assert.equal((await h.service.summary(request.scriptId)).heldMessageCount, 2, "nothing is lost");
  (h.service as any).options.chat.postScriptMessage = original;
  await h.service.releaseHeld(request.scriptId);
  assert.equal((await h.service.summary(request.scriptId)).heldMessageCount, 0);
});

test("a run may post at most 20 messages, and a key value never reaches the chat", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    files: [{ path: "w.mjs", content: `
      const statuses = [];
      for (let n = 0; n < 22; n += 1) {
        const r = await fetch(process.env.ACCORD_API_URL + "/messages", { method: "POST", headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN }, body: JSON.stringify({ chatId: "chat-1", text: "note " + n + " " + process.env.ALERT_KEY }) });
        statuses.push(r.status);
      }
      console.log(statuses.join(","));
    ` }]
  });
  await h.service.runNow(request.scriptId);
  const runs = await finishedRuns(h, request.scriptId);
  assert.match(runs[0]!.outputTail ?? "", /(200,){19}200,429,429/);
  assert.equal(h.posted.length, 20);
  assert.equal(h.posted.some((item) => item.content.includes("sekret-value-123")), false);
});

test("an interval script must fail twice before the User is told; a cron script once", async (t) => {
  const h = await harness(t);
  const failing = [{ path: "w.mjs", content: "console.error('boom'); process.exit(1);" }];
  const interval = await approvedScript(h, { files: failing }, {});
  await h.service.runNow(interval.scriptId);
  await finishedRuns(h, interval.scriptId, 1);
  assert.equal(h.posted.length, 0, "one failure of an interval script is not announced");
  await h.service.runNow(interval.scriptId);
  await finishedRuns(h, interval.scriptId, 2);
  assert.equal(h.posted.length, 1);
  const cron = await approvedScript(h, { name: "Daily", files: failing, schedule: { kind: "cron", expression: "0 17 * * 1-5", timeZone: "Europe/Berlin" } }, {});
  await h.service.runNow(cron.scriptId);
  await finishedRuns(h, cron.scriptId, 1);
  assert.equal(h.posted.length, 2);
  assert.match(h.posted[1]!.content, /Failing: boom/);
});

test("key names that change how the script starts are refused", async (t) => {
  const h = await harness(t);
  for (const name of ["NODE_OPTIONS", "BASH_ENV", "PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "ACCORD_SCRIPT_TOKEN"]) {
    await assert.rejects(
      h.service.proposeChange({ conversationId: "chat-1", requesterParticipantId: "p-taylor", requesterLabel: "@taylor", request: {
        op: "create", name: "W", description: "d", runtime: "node", files: [{ path: "w.mjs", content: "1" }],
        schedule: { kind: "interval", everySeconds: 60 }, secretNames: [name]
      } }),
      /reserved/,
      name
    );
  }
});

test("an agent sees and acts on only the scripts of its own chat", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {}, {});
  assert.equal((await h.service.listForAgent("chat-1")).length, 1);
  assert.deepEqual(await h.service.listForAgent("chat-other"), []);
  await assert.rejects(h.service.runs(request.scriptId, "chat-other"), /does not belong to this chat/);
  await assert.rejects(
    h.service.proposeChange({ conversationId: "chat-other", requesterParticipantId: "p-x", requesterLabel: "@x", request: { op: "run_now", scriptId: request.scriptId } }),
    /does not belong to this chat/
  );
  await assert.rejects(
    h.service.proposeChange({ conversationId: "chat-other", requesterParticipantId: "p-x", requesterLabel: "@x", request: { op: "delete", scriptId: request.scriptId } }),
    /does not belong to this chat/
  );
});

test("a recorded pid whose process started at another time is never signalled", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h);
  const runtime = await h.store.readRuntime(request.scriptId);
  runtime.nextDueAt = new Date(Date.now() + 3600_000).toISOString();
  await h.store.writeRuntime(request.scriptId, runtime);
  const bystander = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  bystander.unref();
  t.after(() => {
    try { process.kill(-bystander.pid!, "SIGKILL"); } catch { /* gone */ }
  });
  // The pid file says this pid started an hour ago: a reused pid.
  await h.store.writePid(request.scriptId, { pid: bystander.pid!, runId: "old", bootAt: Date.now() - uptime() * 1000, startedAt: new Date(Date.now() - 3600_000).toISOString() });
  await h.service.start();
  const runs = await waitFor(async () => {
    const rows = await h.service.runs(request.scriptId);
    return rows.some((row) => row.status === "interrupted") ? rows : undefined;
  });
  assert.ok(runs.length > 0);
  assert.equal(alive(bystander.pid!), true, "an unrelated process with a reused pid survives");
});

test("approving a proposal that was already applied succeeds, and declining it then removes the new script", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {}, {});
  await h.service.assertApprovable(request);
  assert.match(await h.service.applyApproved(request), /Added the scheduled script/);
  await h.service.rejectPending(request);
  assert.deepEqual(await h.service.list(), []);
});

test("concurrent posts from one run cannot exceed the per-run cap", async (t) => {
  const h = await harness(t);
  const request = await approvedScript(h, {
    files: [{ path: "w.mjs", content: `
      const post = (n) => fetch(process.env.ACCORD_API_URL + "/messages", { method: "POST", headers: { Authorization: "Bearer " + process.env.ACCORD_SCRIPT_TOKEN }, body: JSON.stringify({ chatId: "chat-1", text: "note " + n }) }).then((r) => r.status);
      const statuses = await Promise.all(Array.from({ length: 30 }, (_, n) => post(n)));
      console.log("ok=" + statuses.filter((s) => s === 200).length);
    ` }]
  }, {});
  await h.service.runNow(request.scriptId);
  const runs = await finishedRuns(h, request.scriptId);
  assert.match(runs[0]!.outputTail ?? "", /ok=20/);
  assert.equal(h.posted.length, 20);
});

test("a key cut inside stderr leaves no fragment in history or the failure line", async (t) => {
  const h = await harness(t);
  const key = "KEYVALUE-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const request = await approvedScript(h, {
    files: [{ path: "w.mjs", content: "process.stderr.write(process.env.ALERT_KEY + 'y'.repeat(4096 + 30)); process.exit(1);" }]
  }, { ALERT_KEY: key });
  await h.service.runNow(request.scriptId);
  const runs = await finishedRuns(h, request.scriptId);
  const row = runs[0]!;
  for (let length = 6; length < key.length; length += 1) {
    assert.equal((row.outputTail ?? "").includes(key.slice(-length)), false, `history kept ${length} chars`);
    assert.equal((row.detail ?? "").includes(key.slice(-length)), false, `failure line kept ${length} chars`);
  }
});

test("declining an outdated card never touches the script that is running", async (t) => {
  const h = await harness(t);
  const created = await approvedScript(h, {}, {});
  const propose = (description: string) => h.service.proposeChange({ conversationId: "chat-1", requesterParticipantId: "p-taylor", requesterLabel: "@taylor", request: { op: "update", scriptId: created.scriptId, description } });
  const first = await propose("first");
  const second = await propose("second");
  if (first.kind !== "approval" || second.kind !== "approval") throw new Error("expected approvals");
  await h.service.applyApproved(second.request);
  await h.service.rejectPending(first.request);
  const summary = await h.service.summary(created.scriptId);
  assert.equal(summary.enabled, true);
  assert.equal(summary.description, "second");
  await assert.rejects(h.service.applyApproved(first.request), /replaced by a newer one/);
});
