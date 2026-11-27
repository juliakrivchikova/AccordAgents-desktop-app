import assert from "node:assert/strict";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import { warmAgentKey } from "./cliAgents/warm/warmKeys";
import { makeRunner } from "./cliAgents/test/runnerFixtures";

// Settings → Environment changed while members' processes live: each one
// started with other values is replaced as soon as it holds no work.

type Entry = Record<string, any>;

function setup(): { runner: any; closed: string[]; add: (name: string, agentEnvKey: string | undefined, extra?: Entry) => Entry } {
  const runner = makeRunner() as any;
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: Entry, reason: string) => {
    entry.closed = true;
    if (cliParts(runner).warmAgents.entries.get(entry.key) === entry) cliParts(runner).warmAgents.entries.delete(entry.key);
    closed.push(`${entry.name}:${reason}`);
  };
  const add = (name: string, agentEnvKey: string | undefined, extra: Entry = {}): Entry => {
    const key = JSON.stringify({ conversationId: "c1", participantId: name, ...(agentEnvKey === undefined ? {} : { agentEnvKey }) });
    const entry = { name, key, scopeKey: `c1:${name}`, closed: false, queue: Promise.resolve(), ...extra };
    cliParts(runner).warmAgents.entries.set(key, entry);
    return entry;
  };
  return { runner, closed, add };
}

const live = (runner: any): string[] => [...cliParts(runner).warmAgents.entries.values()].map((entry: Entry) => entry.name).sort();

test("a changed environment closes idle member processes now and busy ones the moment their turn ends", async () => {
  const { runner, closed, add } = setup();
  add("idle-claude", "v1", { isIdle: () => true, isReplyIdle: () => true });
  let answering = true;
  const claude = add("answering-claude", "v1", { isIdle: () => !answering, isReplyIdle: () => !answering });
  add("idle-codex", "v1");
  const codex = add("running-codex", "v1");
  let finish!: () => void;
  const turn = cliParts(runner).warmAgents.enqueueWarmRun(codex, () => new Promise<void>((resolve) => { finish = resolve; }));

  await runner.environmentChanged("v2");
  assert.deepEqual(closed.sort(), ["idle-claude:environment-changed", "idle-codex:environment-changed"]);
  assert.deepEqual(live(runner), ["answering-claude", "running-codex"], "a reply in progress and a running turn keep their process");
  assert.equal(cliParts(runner).warmAgents.warmShutdown, undefined, "new turns are not refused meanwhile");

  finish();
  await turn;
  assert.equal(codex.activeRuns, 0);
  assert.ok(closed.includes("running-codex:environment-changed"), "its turn ended: replaced then, not on the next message");

  // The Claude process tells the runner each time it may have gone idle.
  cliParts(runner).warmAgents.retireIfEnvironmentOutdated(claude);
  assert.deepEqual(live(runner), ["answering-claude"], "still answering: kept");
  answering = false;
  cliParts(runner).warmAgents.retireIfEnvironmentOutdated(claude);
  assert.deepEqual(live(runner), [], "its reply is over: replaced");
});

test("only processes started with other values are replaced", async () => {
  const { runner, closed, add } = setup();
  add("same", "v2", { isIdle: () => true });
  add("added-provider-same", "v2|host-a", { isIdle: () => true });
  add("added-provider-old", "v1|host-a", { isIdle: () => true });
  add("no-version", undefined, { isIdle: () => true });
  add("empty-version", "", { isIdle: () => true });
  await runner.environmentChanged("v2");
  assert.deepEqual(closed, ["added-provider-old:environment-changed"]);
  assert.deepEqual(live(runner), ["added-provider-same", "empty-version", "no-version", "same"]);

  // A save that changes nothing (the same values again) restarts nobody.
  await runner.environmentChanged("v2");
  assert.equal(closed.length, 1);

  // A process started after the change with the values read before it (its
  // turn read them first) is outdated too, and goes once its turn is over.
  const late = add("late", "v1");
  const run = cliParts(runner).warmAgents.enqueueWarmRun(late, async () => "done");
  assert.deepEqual(live(runner).includes("late"), true, "kept while its run is admitted");
  await run;
  assert.ok(closed.includes("late:environment-changed"));
});

test("nothing is replaced before the environment is known to have changed", async () => {
  const { runner, closed, add } = setup();
  const entry = add("idle", "v1", { isIdle: () => true });
  cliParts(runner).warmAgents.retireIfEnvironmentOutdated(entry);
  await cliParts(runner).warmAgents.enqueueWarmRun(entry, async () => undefined);
  assert.deepEqual(closed, []);
  assert.deepEqual(live(runner), ["idle"]);
});

test("background tasks: 'wait' replaces the process once they finish, 'stop' right after the turn", async () => {
  for (const policy of ["wait", "stop"] as const) {
    const { runner, closed, add } = setup();
    cliParts(runner).warmAgents.environmentReplacementWithBackgroundTasks = policy;
    let tasks = 1;
    let replying = false;
    const entry = add("claude", "v1", {
      isReplyIdle: () => !replying,
      isIdle: () => !replying && tasks === 0,
      hasLiveBackgroundWork: () => tasks > 0
    });
    await runner.environmentChanged("v2");
    if (policy === "stop") {
      assert.deepEqual(closed, ["claude:environment-changed"], "stop: not in a turn, only its tasks keep it, so it goes now");
      continue;
    }
    assert.deepEqual(closed, [], "wait: its background task keeps it");
    // A turn on it ends while the task still runs: kept.
    replying = true;
    await cliParts(runner).warmAgents.trackWarmRun(entry, async () => { replying = false; });
    assert.deepEqual(closed, []);
    // The task finishes (the CLI reports it; the process calls back).
    tasks = 0;
    cliParts(runner).warmAgents.retireIfEnvironmentOutdated(entry);
    assert.deepEqual(closed, ["claude:environment-changed"]);
  }

  // 'stop' while answering: replaced once the reply is over, its tasks with it.
  const { runner, closed, add } = setup();
  cliParts(runner).warmAgents.environmentReplacementWithBackgroundTasks = "stop";
  let replying = true;
  const entry = add("claude", "v1", { isReplyIdle: () => !replying, isIdle: () => false, hasLiveBackgroundWork: () => true });
  await runner.environmentChanged("v2");
  assert.deepEqual(closed, []);
  replying = false;
  cliParts(runner).warmAgents.retireIfEnvironmentOutdated(entry);
  assert.deepEqual(closed, ["claude:environment-changed"]);
});

test("an environment change waits for a busy member process instead of the member waiting for it", () => {
  const runner = makeRunner() as any;
  const member = { id: "p1", kind: "claude-code" };
  const warm = { conversationId: "c1", participantId: "p1", contextKey: "", idleTimeoutMs: 1 };
  const runningKey = warmAgentKey(member as never, "/r", "chat", { warm, agentEnvKey: "v1" });
  let idle = false;
  cliParts(runner).warmAgents.entries.set(runningKey, { key: runningKey, scopeKey: "c1:p1", closed: false, isIdle: () => idle });
  const envKey = (runOptions: Record<string, unknown>, kind = "chat") =>
    cliParts(runner).warmAgents.withBusyMemberEnvironment(member, "/r", kind, runOptions).options.agentEnvKey;
  const options = { warm, agentEnvKey: "v2" };
  assert.equal(envKey(options), "v1", "busy (a background task): its messages go into the session already running");
  assert.equal(warmAgentKey(member as never, "/r", "chat", { ...options, agentEnvKey: envKey(options) }), runningKey);
  assert.equal(envKey({ ...options, nativeGoal: { objective: "x" } }), "v2", "a goal runs in its own process: the values as they are now");
  assert.equal(envKey({ ...options, warm: { ...warm, contextKey: "changed" } }), "v2", "other settings changed too: the process is replaced anyway");
  assert.equal(envKey({ ...options, warm: { ...warm, participantId: "p2" } }), "v2", "another member's busy process changes nothing");
  idle = true;
  assert.equal(envKey(options), "v2", "idle: its next turn gets the new values");
});

test("a turn routed into the busy process holds it until the turn is over", async () => {
  const runner = makeRunner() as any;
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: Entry, reason: string) => {
    entry.closed = true;
    cliParts(runner).warmAgents.entries.delete(entry.key);
    closed.push(reason);
  };
  const member = { id: "p1", kind: "claude-code" };
  const warm = { conversationId: "c1", participantId: "p1", contextKey: "", idleTimeoutMs: 1 };
  const runningKey = warmAgentKey(member as never, "/r", "chat", { warm, agentEnvKey: "v1" });
  let idle = false;
  const entry = { key: runningKey, scopeKey: "c1:p1", closed: false, isIdle: () => idle, isReplyIdle: () => idle };
  cliParts(runner).warmAgents.entries.set(runningKey, entry);
  await runner.environmentChanged("v2");
  const routed = cliParts(runner).warmAgents.withBusyMemberEnvironment(member, "/r", "chat", { warm, agentEnvKey: "v2" });
  assert.equal(routed.options.agentEnvKey, "v1");
  // The running reply ends before the routed message reaches the process.
  idle = true;
  cliParts(runner).warmAgents.retireIfEnvironmentOutdated(entry);
  assert.deepEqual(closed, [], "not replaced under a turn that is on its way to it");
  routed.release();
  assert.deepEqual(closed, ["environment-changed"], "that turn is over: replaced");
  routed.release();
  assert.equal((entry as Entry).environmentHolds, 0, "a second release changes nothing");
});

test("'stop': a process kept only by background tasks is replaced when the member's next message comes", () => {
  const runner = makeRunner() as any;
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: Entry, reason: string) => {
    entry.closed = true;
    closed.push(reason);
  };
  cliParts(runner).warmAgents.environmentReplacementWithBackgroundTasks = "stop";
  const member = { id: "p1", kind: "claude-code" };
  const warm = { conversationId: "c1", participantId: "p1", contextKey: "", idleTimeoutMs: 1 };
  const runningKey = warmAgentKey(member as never, "/r", "chat", { warm, agentEnvKey: "v1" });
  cliParts(runner).warmAgents.entries.set(runningKey, {
    key: runningKey, scopeKey: "c1:p1", closed: false, isIdle: () => false, isReplyIdle: () => true, hasLiveBackgroundWork: () => true
  });
  const routed = cliParts(runner).warmAgents.withBusyMemberEnvironment(member, "/r", "chat", { warm, agentEnvKey: "v2" });
  assert.equal(routed.options.agentEnvKey, "v2", "the message starts a process with the new values");
  assert.deepEqual(closed, ["environment-changed"]);
  assert.equal(cliParts(runner).warmAgents.entries.size, 0);
});

test("a new process of the member waits until its replaced one has gone", async () => {
  const runner = makeRunner() as any;
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => { finishClose = resolve; });
  cliParts(runner).warmAgentClose.closingWarmAgents.set({ key: "old", scopeKey: "c1:p1" }, closing);
  cliParts(runner).warmAgentClose.closingWarmAgents.set({ key: "other", scopeKey: "c1:p2" }, new Promise<void>(() => undefined));
  let ready = false;
  const prepared = cliParts(runner).warmAgents.closeStaleWarmAgents("c1:p1", "new").then(() => { ready = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false, "the old process still holds the session");
  finishClose();
  await prepared;
  assert.equal(ready, true, "another member's closing process is not waited for");
});
