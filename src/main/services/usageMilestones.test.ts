import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentHealth, ChatMessage, Conversation } from "../../shared/types";
import { USAGE_ASSISTANT_ROLE_ID, USAGE_BUILTIN_ROLE_IDS, USAGE_DEFAULT_MEMBER_ROLE_ID, type UsageSignalAttributes, type UsageSignalName, type UsageWeeklySnapshot } from "../../shared/usageSignals";
import { BUILTIN_CHAT_ROLE_IDS, DEFAULT_MEMBER_ROLE_ID } from "./settings";
import { USAGE_MILESTONES_FILE, UsageMilestones, chatUsageFacts, usageFeatureHistoryFrom, usageHistoryFrom, usageProfileUsedBefore, type UsageFeatureHistory, type UsageHistory, type UsageMilestonesOptions } from "./usageMilestones";

interface Sent {
  name: UsageSignalName;
  attributes: UsageSignalAttributes;
}

const FACTS = { os: "mac" as const, appVersion: "1.11.9", locale: "zh-CN", teamDevice: false };
const NO_FEATURES: UsageFeatureHistory = {
  customRole: false, memberRoleChanged: false, multiRoleChat: false, behaviorRule: false, document: false,
  scheduledTask: false, memoryNote: false, phonePaired: false, urgentAlerts: false
};
const EMPTY_SNAPSHOT: UsageWeeklySnapshot = {
  week: "", members_total: "0", max_members_in_chat: "0", chats_with_2plus_members: "0",
  distinct_roles_in_use: 0, custom_roles_count: 0, builtin_roles_in_use: "none"
};
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
  // Weekly snapshots are kept apart: the step tests read `sent` alone.
  const snapshots: Sent[] = [];
  const reportsOn = overrides.reportsOn ?? (() => true);
  const milestones = new UsageMilestones({
    userDataDir: dir,
    profileUsedBefore: false,
    send: (name, attributes) => {
      if (!reportsOn()) return false;
      (name === "weekly_snapshot" ? snapshots : sent).push({ name, attributes });
      return true;
    },
    installFacts: () => FACTS,
    readHistory: async () => NO_HISTORY,
    readDocuments: async () => ({ started: false, signed: false, plain: false }),
    readFeatureHistory: async () => NO_FEATURES,
    readWeeklySnapshot: async (week) => ({ ...EMPTY_SNAPSHOT, week }),
    now: () => NOW,
    ...overrides
  });
  return { milestones, sent, snapshots };
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
const CLAUDE = { kind: "claude-code", handle: "taylor", roleConfigId: "generic-participant" };
const CODEX = { kind: "codex-cli", handle: "drew", roleConfigId: "generic-participant" };
const MY_ENDPOINT = { kind: "claude-code", handle: "secret-bot", hostId: "host-1", hostLabel: "Acme internal gateway", hostVendor: "custom", model: "acme-llm-7b" };

function base(name: string, cohort: "new" | "existing" = "new"): UsageSignalAttributes {
  return { milestone: name, install_cohort: cohort, os: "mac", app_version: "1.11.9", locale: "zh-CN", team_device: false };
}

/** A history read that answers only once released, whenever it is asked. */
function heldHistory(history: UsageHistory): { readHistory: () => Promise<UsageHistory>; release: () => void } {
  let released = false;
  let answer: (() => void) | undefined;
  return {
    readHistory: () => new Promise((resolve) => {
      answer = () => resolve(history);
      if (released) answer();
    }),
    release: () => {
      released = true;
      answer?.();
    }
  };
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

test("one of the team's own installations says so on every step and on the weekly numbers", async () => {
  await withDir(async (dir) => {
    const { milestones, sent, snapshots } = harness(dir, { installFacts: () => ({ ...FACTS, teamDevice: true }) });
    await milestones.start();
    milestones.reach("first_chat");
    await milestones.sendWeeklySnapshotIfDue();
    assert.deepEqual(sent.map((signal) => [signal.name, signal.attributes.team_device]), [["first_launch", true], ["first_chat", true]]);
    assert.deepEqual(snapshots.map((signal) => [signal.name, signal.attributes.team_device]), [["weekly_snapshot", true]]);
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
    const held = heldHistory({ hasChat: true, families: ["claude-code"], mixedFamilies: false, accordStarted: false, accordSigned: false, hasMachine: false });
    const releaseHistory = held.release;
    const { milestones, sent } = harness(dir, { profileUsedBefore: true, readHistory: held.readHistory });
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
    let documents: { started: boolean; signed: boolean; plain: boolean } = { started: true, signed: false, plain: false };
    let reads = 0;
    const { milestones, sent } = harness(dir, { readDocuments: async () => { reads += 1; return documents; } });
    await milestones.start();
    milestones.observeDocuments();
    await flushDocuments();
    documents = { started: true, signed: true, plain: true };
    milestones.observeDocuments();
    milestones.observeDocuments();
    await flushDocuments();
    milestones.observeDocuments();
    await flushDocuments();
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "first_accord_started", "first_accord_signed", "document_created"]);
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
  assert.deepEqual(facts, { chat: true, newChat: true, families: ["claude-code"], addedFamilies: ["claude-code"], reply: false, memberRequest: false, accordStarted: false, multiRole: false, roleChosen: false, skill: false, newChatForFeatures: true });
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
    const answers: Array<(value: { started: boolean; signed: boolean; plain: boolean }) => void> = [];
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
    answers.shift()?.({ started: true, signed: false, plain: false });
    await flushDocuments();
    answers.shift()?.({ started: true, signed: true, plain: false });
    await flushDocuments();
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "first_accord_started", "first_accord_signed"]);
  });
});

test("reports turned off while an existing installation's history is read: nothing is sent or recorded", async () => {
  await withDir(async (dir) => {
    let on = true;
    const held = heldHistory(NO_HISTORY);
    const release = held.release;
    const { milestones, sent } = harness(dir, { profileUsedBefore: true, reportsOn: () => on, readHistory: held.readHistory });
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
    const second = harness(dir, { now: () => backOn, readDocuments: async (since) => { documentsSince = since; return { started: false, signed: false, plain: false }; } });
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
    milestones.observeConversation(chat([ASSISTANT, CLAUDE, { kind: "gemini-cli", handle: "gemini", roleConfigId: "generic-participant" }]), []);
    assert.deepEqual(sent.slice(4).map((signal) => signal.name), ["first_reply", "provider_first_used", "second_model"]);
  });
});

test("history: a chat is mixed only by members a person added", () => {
  assert.equal(usageHistoryFrom([[ASSISTANT, CLAUDE]], { started: false, signed: false }, 0).mixedFamilies, false);
  assert.deepEqual(usageHistoryFrom([[ASSISTANT, CLAUDE]], { started: false, signed: false }, 0).families, ["codex", "claude-code"]);
  assert.equal(usageHistoryFrom([[ASSISTANT, CLAUDE, CODEX]], { started: false, signed: false }, 0).mixedFamilies, true);
});

test("the role ids a weekly snapshot may name are exactly the app's built-in roles", () => {
  assert.deepEqual([...USAGE_BUILTIN_ROLE_IDS].sort(), [...BUILTIN_CHAT_ROLE_IDS].sort());
  assert.equal(USAGE_DEFAULT_MEMBER_ROLE_ID, DEFAULT_MEMBER_ROLE_ID);
  assert.ok(BUILTIN_CHAT_ROLE_IDS.includes(USAGE_ASSISTANT_ROLE_ID));
});

const ENGINEER = { kind: "claude-code", handle: "drew", roleConfigId: "software-engineer" };
const DESIGNER = { kind: "gemini-cli", handle: "leo", roleConfigId: "product-designer" };

test("roles in chats: a role someone chose, members with different roles, skills; old copied chats do not count", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    // A chat from before this installation, copied from the server.
    milestones.observeConversation(chat([ASSISTANT, ENGINEER, DESIGNER], BEFORE_INSTALL), [
      message({ role: "user", content: "/review", createdAt: BEFORE_INSTALL, metadata: { skillMentions: [{ frontmatterName: "review" } as never] } })
    ]);
    const names = () => sent.map((signal) => signal.name).filter((name) => name !== "provider_first_used");
    assert.deepEqual(names(), ["first_launch"]);

    milestones.observeConversation(chat([ASSISTANT, ENGINEER]), []);
    assert.deepEqual(names().slice(1), ["first_chat", "member_role_changed"], "one member: no multi-role chat yet");
    milestones.observeConversation(chat([ASSISTANT, ENGINEER, DESIGNER]), [
      message({ role: "user", content: "/review this", metadata: { skillMentions: [{ frontmatterName: "review" } as never] } })
    ]);
    assert.deepEqual(names().slice(3), ["second_model", "multi_role_chat", "skill_invoked"]);
  });
});

test("features used through the app are sent once each, with nothing but their name and the usual fields", async () => {
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    const features = ["custom_role_created", "behavior_rule_attached", "scheduled_task_created", "memory_note_written", "phone_paired",
      "terminal_opened", "dictation_used", "file_preview_opened", "connector_signed_in"] as const;
    for (let i = 0; i < 2; i += 1) for (const feature of features) milestones.reach(feature);
    assert.deepEqual(sent.slice(1), features.map((feature) => ({ name: feature, attributes: base(feature) })));
  });
});

test("an installation that reported before feature signals existed: features it had used are recorded, not sent", async () => {
  await withDir(async (dir) => {
    // The record a 1.11.9 beta wrote: steps checked, features never looked up.
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), JSON.stringify({
      version: 1, cohort: "new", historyChecked: true, reached: { first_launch: "2026-11-15T00:00:00.000Z", first_chat: "2026-11-15T00:01:00.000Z" }, families: {}
    }));
    let featureReads = 0;
    const { milestones, sent } = harness(dir, {
      readFeatureHistory: async () => {
        featureReads += 1;
        return { ...NO_FEATURES, customRole: true, multiRoleChat: true, phonePaired: true };
      }
    });
    await milestones.start();
    for (const feature of ["custom_role_created", "multi_role_chat", "phone_paired", "terminal_opened"] as const) milestones.reach(feature);
    assert.deepEqual(sent, [{ name: "terminal_opened", attributes: base("terminal_opened") }], "only the feature first used now goes, with its own cohort");
    let rereads = 0;
    const restarted = harness(dir, { readFeatureHistory: async () => { rereads += 1; return NO_FEATURES; } });
    await restarted.milestones.start();
    assert.equal(featureReads, 1);
    assert.equal(rereads, 0, "features are looked up once");
    restarted.milestones.reach("dictation_used");
    assert.deepEqual(restarted.sent.map((signal) => signal.name), ["dictation_used"], "the restarted installation still sends what is new");
  });
});

test("the weekly snapshot goes once a week, also from an existing installation, and never while reports are off", async () => {
  await withDir(async (dir) => {
    let now = new Date("2026-11-19T10:00:00.000Z");
    let on = true;
    const snapshot: UsageWeeklySnapshot = {
      week: "", members_total: "3-5", max_members_in_chat: "2", chats_with_2plus_members: "1",
      distinct_roles_in_use: 2, custom_roles_count: 1, builtin_roles_in_use: "software-engineer"
    };
    const first = harness(dir, { profileUsedBefore: true, now: () => now, reportsOn: () => on, readWeeklySnapshot: async (week) => ({ ...snapshot, week }) });
    await first.milestones.start();
    assert.deepEqual(first.snapshots, [{
      name: "weekly_snapshot",
      attributes: { ...base("weekly_snapshot", "existing"), ...snapshot, week: "2026-W47" }
    }], "the first launch describes the installation as it is now");
    await first.milestones.sendWeeklySnapshotIfDue();
    now = new Date("2026-11-22T23:00:00.000Z");
    await first.milestones.sendWeeklySnapshotIfDue();
    assert.equal(first.snapshots.length, 1, "once per ISO week");

    now = new Date("2026-11-23T08:00:00.000Z");
    on = false;
    await first.milestones.sendWeeklySnapshotIfDue();
    assert.equal(first.snapshots.length, 1, "reports off: nothing sent, the week stays due");
    on = true;
    await first.milestones.sendWeeklySnapshotIfDue();
    assert.deepEqual(first.snapshots.map((signal) => signal.attributes.week), ["2026-W47", "2026-W48"]);

    first.milestones.pause();
    now = new Date("2026-12-01T08:00:00.000Z");
    await first.milestones.sendWeeklySnapshotIfDue();
    assert.equal(first.snapshots.length, 2, "turned off in Settings: no snapshot this launch");
  });
});

test("feature history from what an installation keeps", () => {
  const history = usageFeatureHistoryFrom({
    chats: [[ASSISTANT, ENGINEER], [ASSISTANT, { ...CLAUDE, behaviorRuleCount: 1 }]],
    roles: [{ id: "software-engineer", builtIn: true }, { id: "acme-closer" }, { id: "old-one", archivedAt: "2026-01-01" }],
    savedMembers: [{ roleConfigId: "generic-participant" }],
    plainDocument: false,
    approvedScheduledTasks: 2,
    memoryNotes: 0,
    phones: 1
  });
  assert.deepEqual(history, {
    customRole: true, memberRoleChanged: true, multiRoleChat: false, behaviorRule: true, document: false,
    scheduledTask: true, memoryNote: false, phonePaired: true, urgentAlerts: true
  }, "alerts that could not be read count as set up");
  assert.equal(usageFeatureHistoryFrom({ chats: [], roles: [{ id: "old-one", archivedAt: "2026-01-01" }], savedMembers: [], plainDocument: true, approvedScheduledTasks: 0, memoryNotes: 3, phones: 0 }).customRole, true,
    "a role made and later deleted was still made");
  assert.deepEqual(usageFeatureHistoryFrom({}), {
    customRole: true, memberRoleChanged: true, multiRoleChat: true, behaviorRule: true, document: true,
    scheduledTask: true, memoryNote: true, phonePaired: true, urgentAlerts: true
  }, "what could not be read counts as used, so nothing old goes as new");
  assert.equal(usageFeatureHistoryFrom({ urgentAlerts: false }).urgentAlerts, false);
});

test("the weekly snapshot stays once a week across restarts, and a failed or interrupted read leaves the week due", async () => {
  await withDir(async (dir) => {
    const week47 = new Date("2026-11-19T10:00:00.000Z");
    const first = harness(dir, { now: () => week47 });
    await first.milestones.start();
    assert.equal(first.snapshots.length, 1);
    const again = harness(dir, { now: () => week47 });
    await again.milestones.start();
    assert.equal(again.snapshots.length, 0, "the same week after a restart: nothing");

    const week48 = new Date("2026-11-24T10:00:00.000Z");
    let fail = true;
    const failing = harness(dir, { now: () => week48, readWeeklySnapshot: async (week) => {
      if (fail) { fail = false; throw new Error("database is locked"); }
      return { ...EMPTY_SNAPSHOT, week };
    } });
    await failing.milestones.start();
    assert.equal(failing.snapshots.length, 0, "a failed read sends nothing");
    await failing.milestones.sendWeeklySnapshotIfDue();
    assert.deepEqual(failing.snapshots.map((signal) => signal.attributes.week), ["2026-W48"], "and is tried again");

    const week49 = new Date("2026-12-01T10:00:00.000Z");
    let answer: (() => void) | undefined;
    const paused = harness(dir, { now: () => week49, readWeeklySnapshot: (week) => new Promise((resolve) => { answer = () => resolve({ ...EMPTY_SNAPSHOT, week }); }) });
    const starting = paused.milestones.start();
    for (let i = 0; i < 5 && !answer; i += 1) await new Promise((resolve) => setImmediate(resolve));
    paused.milestones.pause();
    answer?.();
    await starting;
    assert.equal(paused.snapshots.length, 0, "reports turned off during the read: nothing sent");
    const stored = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { snapshotWeek?: string };
    assert.equal(stored.snapshotWeek, "2026-W48");
  });
});

test("a feature used while an upgraded installation's features are looked up is not sent if it was used before", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), JSON.stringify({
      version: 1, cohort: "existing", historyChecked: true, reached: { first_launch: "2026-11-15T00:00:00.000Z" }, families: {}
    }));
    let release: (() => void) | undefined;
    const { milestones, sent } = harness(dir, {
      readFeatureHistory: () => new Promise((resolve) => { release = () => resolve({ ...NO_FEATURES, customRole: true }); })
    });
    const starting = milestones.start();
    for (let i = 0; i < 5 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
    milestones.reach("custom_role_created");
    milestones.reach("terminal_opened");
    release?.();
    await starting;
    assert.deepEqual(sent.map((signal) => signal.name), ["terminal_opened"]);
  });
});

test("an upgraded installation: skills, chats and documents from before the upgrade are not first uses; an Accord is not a skill", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), JSON.stringify({
      version: 1, cohort: "new", historyChecked: true, reached: { first_launch: "2026-11-01T00:00:00.000Z" }, families: {}
    }));
    let plainSince = "";
    const { milestones, sent } = harness(dir, { readDocuments: async (_since, plain) => { plainSince = plain; return { started: false, signed: false, plain: false }; } });
    await milestones.start();
    const beforeUpgrade = "2026-11-05T09:00:00.000Z";
    milestones.observeConversation(chat([ASSISTANT, ENGINEER, DESIGNER], beforeUpgrade), [
      message({ role: "user", content: "/review", createdAt: beforeUpgrade, metadata: { skillMentions: [{ frontmatterName: "review" } as never] } })
    ]);
    // First steps still count from the first launch (that chat is a first chat).
    const features = () => sent.map((signal) => signal.name).filter((name) => !["provider_first_used", "first_reply", "first_chat", "second_model"].includes(name));
    assert.deepEqual(features(), [], "used before the upgrade, seen after it: not sent");
    milestones.observeDocuments();
    await flushDocuments();
    assert.equal(plainSince, NOW.toISOString(), "documents count from the upgrade too");

    milestones.observeConversation(chat([ASSISTANT, ENGINEER]), [
      message({ role: "user", content: "@drew /accord ship?", metadata: { skillMentions: [{ frontmatterName: "accord" } as never] } })
    ]);
    assert.equal(features().includes("skill_invoked"), false, "an Accord launch is not a skill use");
    milestones.observeConversation(chat([ASSISTANT, ENGINEER]), [
      message({ role: "user", content: "/review it", metadata: { skillMentions: [{ frontmatterName: "review" } as never] } })
    ]);
    assert.ok(features().includes("skill_invoked"));
  });
});

test("an installation that looked up features before alerts were counted looks again once, and features keep counting from the first look", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), JSON.stringify({
      version: 1, cohort: "new", historyChecked: true, featureHistoryVersion: 1, featuresFrom: "2026-11-10T00:00:00.000Z",
      reached: { first_launch: "2026-11-01T00:00:00.000Z" }, families: {}
    }));
    let reads = 0;
    const { milestones, sent } = harness(dir, { readFeatureHistory: async () => { reads += 1; return { ...NO_FEATURES, urgentAlerts: true }; } });
    await milestones.start();
    milestones.reach("urgent_alert_set_up");
    assert.equal(reads, 1);
    assert.deepEqual(sent, [], "alerts set up before: recorded, not sent");
    const stored = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { featureHistoryVersion: number; featuresFrom: string };
    assert.equal(stored.featureHistoryVersion, 2);
    assert.equal(stored.featuresFrom, "2026-11-10T00:00:00.000Z", "features keep counting from the first look");
  });
});

test("urgent alerts: a phone saved, or Telegram connecting while Settings is open, is the first setup; one made before is not", async () => {
  await withDir(async (dir) => {
    const first = harness(dir);
    await first.milestones.start();
    first.milestones.observeUrgentAlertRequest("settings", { ok: true, value: { telegram: { connected: true } } });
    first.milestones.observeUrgentAlertRequest("settings", { ok: true, value: { telegram: { connected: true } } });
    first.milestones.observeUrgentAlertRequest("phone.save", { ok: false });
    assert.deepEqual(first.sent.map((signal) => signal.name), ["first_launch"], "connected already when first read: not a new setup");
  });
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    milestones.observeUrgentAlertRequest("telegram.connect", { ok: true, value: {} });
    milestones.observeUrgentAlertRequest("settings", { ok: true, value: { telegram: { connected: false, step: "start" } } });
    milestones.observeUrgentAlertRequest("settings", { ok: true, value: { telegram: { connected: true } } });
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "urgent_alert_set_up"]);
  });
  await withDir(async (dir) => {
    const { milestones, sent } = harness(dir);
    await milestones.start();
    milestones.observeUrgentAlertRequest("phone.save", { ok: true, value: {} });
    assert.deepEqual(sent.map((signal) => signal.name), ["first_launch", "urgent_alert_set_up"]);
  });
});

test("a new installation from before alerts were counted keeps counting features from its first launch", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, USAGE_MILESTONES_FILE), JSON.stringify({
      version: 1, cohort: "new", historyChecked: true, featureHistoryVersion: 1,
      reached: { first_launch: "2026-11-01T00:00:00.000Z" }, families: {}
    }));
    const { milestones, sent } = harness(dir);
    await milestones.start();
    // A chat made after its first launch, before the update, gets a second role now.
    milestones.observeConversation(chat([ASSISTANT, ENGINEER, DESIGNER], "2026-11-05T00:00:00.000Z"), []);
    assert.ok(sent.map((signal) => signal.name).includes("multi_role_chat"));
    const stored = JSON.parse(await readFile(path.join(dir, USAGE_MILESTONES_FILE), "utf8")) as { featuresFrom?: string };
    assert.equal(stored.featuresFrom, undefined);
  });
});
