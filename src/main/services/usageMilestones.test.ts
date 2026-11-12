import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentHealth, ChatMessage, Conversation } from "../../shared/types";
import type { UsageSignalAttributes, UsageSignalName } from "../../shared/usageSignals";
import { USAGE_MILESTONES_FILE, UsageMilestones, chatUsageFacts, usageHistoryFrom, usageProfileUsedBefore, type UsageHistory, type UsageMilestonesOptions } from "./usageMilestones";

interface Sent {
  name: UsageSignalName;
  attributes: UsageSignalAttributes;
}

const FACTS = { os: "mac" as const, appVersion: "1.11.9", locale: "zh-CN" };
const NO_HISTORY: UsageHistory = { hasChat: false, families: [], mixedFamilies: false, accordStarted: false, accordSigned: false, hasMachine: false };

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accord-usage-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function harness(dir: string, overrides: Partial<UsageMilestonesOptions> & { reportsOn?: () => boolean } = {}) {
  const sent: Sent[] = [];
  const reportsOn = overrides.reportsOn ?? (() => true);
  const milestones = new UsageMilestones({
    userDataDir: dir,
    profileUsedBefore: false,
    send: (name, attributes) => {
      if (!reportsOn()) return false;
      sent.push({ name, attributes });
      return true;
    },
    installFacts: () => FACTS,
    readHistory: async () => NO_HISTORY,
    readDocuments: async () => ({ started: false, signed: false }),
    now: () => NOW,
    ...overrides
  });
  return { milestones, sent };
}

const NOW = new Date("2026-11-12T10:00:00.000Z");
const LATER = "2026-11-12T10:05:00.000Z";
const BEFORE_INSTALL = "2026-10-01T09:00:00.000Z";

function chat(participants: Array<Record<string, unknown>>, createdAt = LATER): Pick<Conversation, "kind" | "metadata" | "createdAt"> {
  return { kind: "chat", createdAt, metadata: { participants } as unknown as Conversation["metadata"] };
}

function message(fields: Partial<ChatMessage>): ChatMessage {
  return { id: `m-${Math.random()}`, role: "participant", content: "Done.", createdAt: LATER, status: "done", ...fields };
}

const ASSISTANT = { id: "assistant-id", kind: "codex-cli", handle: "assistant", roleConfigId: "administrator" };
const CLAUDE = { kind: "claude-code", handle: "taylor", roleConfigId: "engineer" };
const CODEX = { kind: "codex-cli", handle: "drew", roleConfigId: "engineer" };
const MY_ENDPOINT = { kind: "claude-code", handle: "secret-bot", hostId: "host-1", hostLabel: "Acme internal gateway", hostVendor: "custom", model: "acme-llm-7b" };

function base(name: string, cohort: "new" | "existing" = "new"): UsageSignalAttributes {
  return { milestone: name, install_cohort: cohort, os: "mac", app_version: "1.11.9", locale: "zh-CN" };
}

async function flushDocuments(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a new installation sends first_launch once, with only the allowed fields", async () => {
  await withDir(async (dir) => {
    const first = harness(dir);
    await first.milestones.start();
    assert.deepEqual(first.sent, [{ name: "first_launch", attributes: base("first_launch") }]);

    // Restart: the same profile, a new launch.
    const second = harness(dir);
    await second.milestones.start();
    assert.deepEqual(second.sent, []);
  });
});

test("every step is sent exactly once, also across a restart and redelivered updates", async () => {
  await withDir(async (dir) => {
    const run = async () => {
      const { milestones, sent } = harness(dir);
      await milestones.start();
      const agents: AgentHealth[] = [
        { kind: "claude-code", label: "Claude Code", installed: true },
        { kind: "codex-cli", label: "Codex", installed: false },
        { kind: "gemini-cli", label: "Antigravity", installed: false }
      ];
      for (let i = 0; i < 2; i += 1) {
        milestones.observeAgents(agents);
        milestones.observeConversation(chat([CLAUDE]), [message({ role: "user", content: "hello" })]);
        milestones.observeConversation(chat([CLAUDE]), [message({})]);
        milestones.observeConversation(chat([CLAUDE, CODEX]), [message({ metadata: { participantRequest: { id: "r1" } as never } })]);
        milestones.observeConversation(chat([CLAUDE, CODEX]), [message({ role: "user", content: "@taylor /accord\nShip it?", metadata: {} })]);
        milestones.reach("first_cloud_machine");
      }
      return sent;
    };
    const firstLaunch = await run();
    assert.deepEqual(firstLaunch, [
      { name: "first_launch", attributes: base("first_launch") },
      { name: "cli_ready", attributes: { ...base("cli_ready"), claude_code_ready: true, codex_ready: false, antigravity_ready: false } },
      { name: "provider_first_used", attributes: { ...base("provider_first_used"), provider_family: "claude-code" } },
      { name: "first_chat", attributes: base("first_chat") },
      { name: "first_reply", attributes: base("first_reply") },
      { name: "provider_first_used", attributes: { ...base("provider_first_used"), provider_family: "codex" } },
      { name: "second_model", attributes: base("second_model") },
      { name: "first_member_request", attributes: base("first_member_request") },
      { name: "first_accord_started", attributes: base("first_accord_started") },
      { name: "first_cloud_machine", attributes: base("first_cloud_machine") }
    ]);
    assert.deepEqual(await run(), [], "nothing is sent again after a restart");
  });
});

test("with reports off nothing is sent, kept or counted, and it is sent once they are on", async () => {
  await withDir(async (dir) => {
    let on = false;
    const { milestones, sent } = harness(dir, { reportsOn: () => on });
    await milestones.start();
    milestones.observeConversation(chat([CLAUDE]), [message({})]);
    assert.deepEqual(sent, []);
    assert.equal(await stat(path.join(dir, USAGE_MILESTONES_FILE)).then(() => true, () => false), false, "no record is written while off");

    // Reports turned on later: that launch finds the profile used (the app
    // made its chat database meanwhile), so it is an existing installation.
    on = true;
    const next = harness(dir, { profileUsedBefore: true, readHistory: async () => ({ ...NO_HISTORY, hasChat: true, families: ["claude-code"] }) });
    await next.milestones.start();
    next.milestones.observeConversation(chat([CLAUDE]), [message({})]);
    assert.deepEqual(next.sent, [{ name: "existing_install", attributes: base("existing_install", "existing") }]);
  });
});

test("turned off mid-launch, a step is not counted as sent and goes once reports are back", async () => {
  await withDir(async (dir) => {
    let on = true;
    const { milestones, sent } = harness(dir, { reportsOn: () => on });
    await milestones.start();
    on = false;
    milestones.reach("first_chat");
    on = true;
    milestones.reach("first_chat");
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "first_chat"]);
  });
});

test("a custom endpoint is only `custom`: no name, address or model leaves", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    milestones.observeConversation(chat([MY_ENDPOINT]), []);
    const provider = sent.find((signal) => signal.name === "provider_first_used");
    assert.deepEqual(provider, { name: "provider_first_used", attributes: { ...base("provider_first_used"), provider_family: "custom" } });
    const everything = JSON.stringify(sent);
    for (const secret of ["secret-bot", "Acme", "acme-llm-7b", "host-1", "taylor"]) {
      assert.equal(everything.includes(secret), false, `${secret} must not be sent`);
    }
  });
});

test("an existing installation sends existing_install, and what it had done counts as sent", async () => {
  await withDir(async (dir) => {
    let releaseHistory: () => void = () => undefined;
    const history: UsageHistory = { hasChat: true, families: ["claude-code"], mixedFamilies: false, accordStarted: false, accordSigned: false, hasMachine: false };
    const { milestones, sent } = harness(dir, {
      profileUsedBefore: true,
      readHistory: () => new Promise((resolve) => {
        releaseHistory = () => resolve(history);
      })
    });
    const starting = milestones.start();
    // Seen while the history is read: an old chat's update, and a first
    // member request made right after the update.
    milestones.observeConversation(chat([CLAUDE]), [message({})]);
    milestones.observeConversation(chat([CLAUDE, CODEX]), [message({ metadata: { participantRequest: { id: "r1" } as never } })]);
    assert.deepEqual(sent.map((signal) => signal.name), ["existing_install"]);
    releaseHistory();
    await starting;
    assert.deepEqual(sent, [
      { name: "existing_install", attributes: base("existing_install", "existing") },
      { name: "provider_first_used", attributes: { ...base("provider_first_used", "existing"), provider_family: "codex" } },
      { name: "second_model", attributes: base("second_model", "existing") },
      { name: "first_member_request", attributes: base("first_member_request", "existing") }
    ]);

    const restarted = harness(dir, { profileUsedBefore: true, readHistory: async () => assert.fail("history is read once") });
    await restarted.milestones.start();
    restarted.milestones.observeConversation(chat([CLAUDE, CODEX]), [message({})]);
    assert.deepEqual(restarted.sent, []);
  });
});

test("an existing installation whose history cannot be read sends nothing new until it can", async () => {
  await withDir(async (dir) => {
    const failing = harness(dir, { profileUsedBefore: true, readHistory: async () => { throw new Error("database is locked"); } });
    await failing.milestones.start();
    failing.milestones.observeConversation(chat([CLAUDE]), [message({})]);
    assert.deepEqual(failing.sent.map((signal) => signal.name), ["existing_install"]);

    const next = harness(dir, { profileUsedBefore: true, readHistory: async () => ({ ...NO_HISTORY, hasChat: true, families: ["claude-code"] }) });
    await next.milestones.start();
    next.milestones.observeConversation(chat([CLAUDE]), [message({})]);
    assert.deepEqual(next.sent, [], "existing_install is not sent again and old steps stay unsent");
  });
});

test("a damaged record is read as an existing installation, never as a new one", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), "{not json");
    const { milestones, sent } = harness(dir, { readHistory: async () => ({ ...NO_HISTORY, hasChat: true }) });
    await milestones.start();
    milestones.observeConversation(chat([CLAUDE]), [message({})]);
    assert.deepEqual(sent.map((signal) => [signal.name, signal.attributes.install_cohort]), [["provider_first_used", "existing"]]);
    const stored = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { cohort: string; historyChecked: boolean };
    assert.equal(stored.cohort, "existing");
    assert.equal(stored.historyChecked, true);
  });
});

test("cli_ready waits for a ready CLI and says which are ready", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    milestones.observeAgents([{ kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "required" }]);
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch"], "a CLI that needs sign-in is not ready");
    milestones.observeAgents([
      { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
      { kind: "gemini-cli", label: "Antigravity", installed: true, detection: "detected", runnable: "ready", authentication: "ready" }
    ]);
    assert.deepEqual(sent[1], { name: "cli_ready", attributes: { ...base("cli_ready"), claude_code_ready: false, codex_ready: true, antigravity_ready: true } });
  });
});

test("an Accord's document is reported started and then signed, each once", async () => {
  await withDir(async (dir) => {
    let documents = { started: true, signed: false };
    let reads = 0;
    const { milestones, sent } = harness(dir, { readDocuments: async () => { reads += 1; return documents; } });
    await milestones.start();
    milestones.observeDocuments();
    await flushDocuments();
    documents = { started: true, signed: true };
    milestones.observeDocuments();
    milestones.observeDocuments();
    await flushDocuments();
    milestones.observeDocuments();
    await flushDocuments();
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "first_accord_started", "first_accord_signed"]);
    assert.equal(reads, 2, "documents are read one at a time and not after both are sent");
  });
});

test("chat facts: replies that ended badly and /accord inside code do not count", () => {
  const facts = chatUsageFacts(chat([CLAUDE]), [
    message({ status: "error" }),
    message({ status: "done", metadata: { terminalReason: "user-stopped" } }),
    message({ status: "done", content: "   " }),
    message({ status: "pending" }),
    message({ role: "user", content: "Type `/accord` to start one, or:\n```\n@taylor /accord\n```" })
  ]);
  assert.deepEqual(facts, { chat: true, newChat: true, families: ["claude-code"], addedFamilies: ["claude-code"], reply: false, memberRequest: false, accordStarted: false });
  assert.equal(chatUsageFacts(chat([CLAUDE]), [message({ role: "user", content: "x", metadata: { skillMentions: [{ frontmatterName: "accord" } as never] } })]).accordStarted, true);
  assert.equal(chatUsageFacts({ kind: "code-review", createdAt: LATER, metadata: {} as Conversation["metadata"] }, [message({})]).chat, false);
});

test("history: families across chats, two families in one chat, documents and machines", () => {
  assert.deepEqual(
    usageHistoryFrom([[CLAUDE], [CLAUDE, MY_ENDPOINT], []], { started: true, signed: false }, 0),
    { hasChat: true, families: ["claude-code", "custom"], mixedFamilies: true, accordStarted: true, accordSigned: false, hasMachine: false }
  );
  assert.deepEqual(usageHistoryFrom([], { started: false, signed: false }, 2), { ...NO_HISTORY, hasMachine: true });
});

test("chats and replies copied from the server that predate the installation are not first steps", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    // A second computer joins the User's server and receives her old chats.
    milestones.observeConversation(chat([CLAUDE, CODEX], BEFORE_INSTALL), [
      message({ createdAt: BEFORE_INSTALL }),
      message({ createdAt: BEFORE_INSTALL, metadata: { participantRequest: { id: "r1" } as never } }),
      message({ role: "user", content: "@taylor /accord", createdAt: BEFORE_INSTALL })
    ]);
    assert.deepEqual(sent.map((signal) => [signal.name, signal.attributes.provider_family]), [
      ["first_launch", undefined],
      ["provider_first_used", "claude-code"],
      ["provider_first_used", "codex"]
    ], "only the provider families it uses are sent");

    // A reply in that old chat made now is a first reply; a minute of clock
    // difference between devices still counts.
    milestones.observeConversation(chat([CLAUDE, CODEX], BEFORE_INSTALL), [message({ createdAt: "2026-11-12T09:59:30.000Z" })]);
    milestones.observeConversation(chat([CLAUDE, CODEX]), []);
    assert.deepEqual(sent.slice(3).map((signal) => signal.name), ["first_reply", "first_chat", "second_model"]);
  });
});

test("a document change during a read is looked at again, and a failed read does not stop later ones", async () => {
  await withDir(async (dir) => {
    const answers: Array<(value: { started: boolean; signed: boolean }) => void> = [];
    let fail = true;
    const { milestones, sent } = harness(dir, {
      readDocuments: () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("database is locked"));
        }
        return new Promise((resolve) => answers.push(resolve));
      }
    });
    await milestones.start();
    milestones.observeDocuments();
    await flushDocuments();
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch"]);

    milestones.observeDocuments();
    milestones.observeDocuments(); // signed meanwhile; the first read is stale
    answers.shift()?.({ started: true, signed: false });
    await flushDocuments();
    answers.shift()?.({ started: true, signed: true });
    await flushDocuments();
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "first_accord_started", "first_accord_signed"]);
  });
});

test("reports turned off while an existing installation's history is read: nothing is sent or recorded", async () => {
  await withDir(async (dir) => {
    let on = true;
    let release: () => void = () => undefined;
    const { milestones, sent } = harness(dir, {
      profileUsedBefore: true,
      reportsOn: () => on,
      readHistory: () => new Promise((resolve) => {
        release = () => resolve(NO_HISTORY);
      })
    });
    const starting = milestones.start();
    milestones.observeConversation(chat([CLAUDE]), [message({})]);
    on = false;
    release();
    await starting;
    assert.deepEqual(sent.map((signal) => signal.name), ["existing_install"]);
    const stored = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { reached: Record<string, string>; families: Record<string, string> };
    assert.deepEqual(Object.keys(stored.reached), ["first_launch"]);
    assert.deepEqual(stored.families, {});
  });
});

test("a record from a newer version is read as an existing installation", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), JSON.stringify({ version: 2, cohort: "new", reached: { first_launch: "2026-01-01T00:00:00.000Z" } }));
    let historyRead = false;
    const { milestones, sent } = harness(dir, { readHistory: async () => { historyRead = true; return NO_HISTORY; } });
    await milestones.start();
    assert.equal(historyRead, true);
    assert.equal(sent.length, 0, "neither first_launch nor existing_install is sent again");
    milestones.reach("first_chat");
    assert.deepEqual(sent.map((signal) => signal.attributes.install_cohort), ["existing"]);
  });
});

test("a minute of clock difference counts; more, or an unreadable time, does not", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    milestones.observeConversation(chat([CLAUDE], "2026-11-12T09:58:59.000Z"), [message({ createdAt: "not a time" })]);
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "provider_first_used"]);
    milestones.observeConversation(chat([CLAUDE], "2026-11-12T09:59:00.000Z"), [message({ createdAt: "2026-11-12T09:59:00.000Z" })]);
    assert.deepEqual(sent.slice(2).map((signal) => signal.name), ["first_chat", "first_reply"]);
  });
});

test("a profile counts as used before when its chat database is there", async () => {
  await withDir(async (dir) => {
    assert.equal(usageProfileUsedBefore(dir), false);
    await writeFile(path.join(dir, "accordagents.sqlite3"), "");
    assert.equal(usageProfileUsedBefore(dir), true);
    assert.equal(usageProfileUsedBefore(path.join(dir, "missing")), false);
  });
});

test("what happens while reports are off is never sent, also after they are back on", async () => {
  await withDir(async (dir) => {
    const first = harness(dir);
    await first.milestones.start();
    first.milestones.pause();
    first.milestones.observeConversation(chat([CLAUDE]), [message({})]);
    first.milestones.reach("first_cloud_machine");
    assert.deepEqual(first.sent.map((signal) => signal.name), ["first_launch"], "nothing after the switch is turned off");
    const paused = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { pausedAt?: string };
    assert.equal(paused.pausedAt, NOW.toISOString());

    // Back on a day later: a chat and a reply made while off stay unsent;
    // what is made from now on counts.
    const backOn = new Date("2026-11-13T10:00:00.000Z");
    let documentsSince = "";
    const second = harness(dir, { now: () => backOn, readDocuments: async (since) => { documentsSince = since; return { started: false, signed: false }; } });
    await second.milestones.start();
    second.milestones.observeConversation(chat([CLAUDE], "2026-11-12T18:00:00.000Z"), [message({ createdAt: "2026-11-12T18:00:00.000Z" })]);
    // A reply made while off, half a minute before they came back on.
    second.milestones.observeConversation(chat([CLAUDE], "2026-11-13T09:59:30.000Z"), [message({ createdAt: "2026-11-13T09:59:30.000Z" })]);
    assert.deepEqual(second.sent.map((signal) => signal.name), ["provider_first_used"]);
    second.milestones.observeConversation(chat([CLAUDE], "2026-11-13T10:01:00.000Z"), [message({ createdAt: "2026-11-13T10:01:00.000Z" })]);
    assert.deepEqual(second.sent.slice(1).map((signal) => signal.name), ["first_chat", "first_reply"]);
    second.milestones.observeDocuments();
    await flushDocuments();
    assert.equal(documentsSince, "2026-11-13T10:00:00.000Z", "documents count from the same moment");
    const resumed = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { pausedAt?: string; countFrom?: string };
    assert.equal(resumed.pausedAt, undefined);
    assert.equal(resumed.countFrom, backOn.toISOString());
  });
});

test("a record that exists but cannot be read sends nothing, rather than starting over", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  await withDir(async (dir) => {
    const file = path.join(dir, USAGE_MILESTONES_FILE);
    await writeFile(file, JSON.stringify({ version: 1, cohort: "new", historyChecked: true, reached: { first_launch: "2026-11-01T00:00:00.000Z" }, families: {} }));
    await chmod(file, 0o000);
    try {
      const { milestones, sent } = harness(dir, { profileUsedBefore: true });
      await milestones.start();
      milestones.observeConversation(chat([CLAUDE]), [message({})]);
      assert.equal(sent.length, 0);
    } finally {
      await chmod(file, 0o600);
    }
  });
});

test("turning reports off is remembered even after a failed history read stopped this launch", async () => {
  await withDir(async (dir) => {
    const { milestones } = harness(dir, { profileUsedBefore: true, readHistory: async () => { throw new Error("database is locked"); } });
    await milestones.start();
    milestones.pause();
    const stored = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { pausedAt?: string; historyChecked: boolean };
    assert.equal(stored.pausedAt, NOW.toISOString());
    assert.equal(stored.historyChecked, false);
  });
});

test("the Assistant does not make a chat mixed, and its reply counts only when it answers a person", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    const question = message({ id: "q1", role: "user", content: "hi" });
    const watch = message({ id: "w1", role: "system", content: "Auto-watch trigger" });
    // Every chat has the Assistant; adding one member of another family is
    // not yet two providers a person chose.
    milestones.observeConversation(chat([ASSISTANT, CLAUDE]), [
      watch,
      message({ participantId: ASSISTANT.id, content: "Noted", metadata: { sourceMessageId: "w1" } })
    ]);
    assert.deepEqual(sent.map((signal) => [signal.name, signal.attributes.provider_family]), [
      ["first_launch", undefined],
      ["provider_first_used", "codex"],
      ["provider_first_used", "claude-code"],
      ["first_chat", undefined]
    ], "no second_model, and the Assistant's own post is not a first reply");

    milestones.observeConversation(chat([ASSISTANT, CLAUDE]), [question, message({ participantId: ASSISTANT.id, metadata: { sourceMessageId: "q1" } })]);
    milestones.observeConversation(chat([ASSISTANT, CLAUDE, { kind: "gemini-cli", handle: "gemini", roleConfigId: "engineer" }]), []);
    assert.deepEqual(sent.slice(4).map((signal) => signal.name), ["first_reply", "provider_first_used", "second_model"]);
  });
});

test("history: a chat is mixed only by members a person added", () => {
  assert.equal(usageHistoryFrom([[ASSISTANT, CLAUDE]], { started: false, signed: false }, 0).mixedFamilies, false);
  assert.deepEqual(usageHistoryFrom([[ASSISTANT, CLAUDE]], { started: false, signed: false }, 0).families, ["codex", "claude-code"]);
  assert.equal(usageHistoryFrom([[ASSISTANT, CLAUDE, CODEX]], { started: false, signed: false }, 0).mixedFamilies, true);
});
