import assert from "node:assert/strict";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";
import { cliParts } from "./cliAgents/test/cliParts";
import { warmAgentKey } from "./cliAgents/warm/warmKeys";

// Settings → Environment changed while members' processes live: each one
// started with other values is replaced once it has held no work for a
// moment (WarmEnvironment); background tasks are waited for.

type Entry = Record<string, any>;

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(settleMs = 0): {
  runner: any; closed: string[]; env: { version?: string; fail?: boolean; delay?: number };
  add: (name: string, agentEnvKey: string | undefined, extra?: Entry) => Entry;
} {
  const env: { version?: string; fail?: boolean; delay?: number } = { version: "v1" };
  const runner = new CliAgentRunner(undefined, async () => {
    const version = env.version;
    if (env.delay) await tick(env.delay);
    if (env.fail) throw new Error("secret store unavailable");
    return { env: {}, version };
  }) as any;
  cliParts(runner).warmAgents.environment.settleMs = settleMs;
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: Entry, reason: string) => {
    entry.closed = true;
    if (cliParts(runner).warmAgents.entries.get(entry.key) === entry) cliParts(runner).warmAgents.entries.delete(entry.key);
    closed.push(`${entry.name}:${reason}`);
  };
  const add = (name: string, agentEnvKey: string | undefined, extra: Entry = {}): Entry => {
    const key = JSON.stringify({ conversationId: "c1", participantId: name, ...(agentEnvKey === undefined ? {} : { agentEnvKey }) });
    const entry = {
      name, key, scopeKey: `c1:${name}`, closed: false, queue: Promise.resolve(),
      environmentGeneration: cliParts(runner).warmAgents.environment.currentGeneration(), ...extra
    };
    cliParts(runner).warmAgents.entries.set(key, entry);
    return entry;
  };
  return { runner, closed, env, add };
}

/** A Claude process: the app sees its background work. */
const claude = (state: { replying?: boolean; tasks?: number } = {}): Entry => ({
  isIdle: () => !state.replying && !state.tasks,
  isReplyIdle: () => !state.replying,
  hasLiveBackgroundWork: () => (state.tasks ?? 0) > 0
});

const live = (runner: any): string[] => [...cliParts(runner).warmAgents.entries.values()].map((entry: Entry) => entry.name).sort();

test("a changed environment replaces idle member processes, and busy ones once their turn is over", async () => {
  const { runner, closed, env, add } = setup();
  add("idle-claude", "v1", claude());
  const answering = { replying: true };
  const busy = add("answering-claude", "v1", claude(answering));
  add("idle-codex", "v1");
  const codex = add("running-codex", "v1");
  let finish!: () => void;
  const turn = cliParts(runner).warmAgents.enqueueWarmRun(codex, () => new Promise<void>((resolve) => { finish = resolve; }));

  env.version = "v2";
  await runner.environmentChanged();
  await tick();
  assert.deepEqual(closed.sort(), ["idle-claude:environment-changed", "idle-codex:environment-changed"]);
  assert.deepEqual(live(runner), ["answering-claude", "running-codex"], "a reply in progress and a running turn keep their process");
  assert.equal(cliParts(runner).warmAgents.warmShutdown, undefined, "new turns are not refused meanwhile");

  // A Claude process says when it may have gone idle.
  answering.replying = false;
  cliParts(runner).warmAgents.environment.mayBeFree(busy);
  await tick();
  assert.ok(closed.includes("answering-claude:environment-changed"), "its reply is over: replaced, not on the next message");

  // What a Codex process left running the app cannot see: it is not cut
  // after its turn; its next turn replaces it, as before.
  finish();
  await turn;
  await tick();
  assert.equal(codex.activeRuns, 0);
  assert.deepEqual(live(runner), ["running-codex"]);
});

test("only processes started before the change with other values are replaced", async () => {
  const { runner, closed, env, add } = setup();
  add("same", "v2", claude());
  add("added-provider-same", "v2|host-a", claude());
  add("added-provider-old", "v1|host-a", claude());
  add("no-version", undefined, claude());
  add("empty-version", "", claude());
  env.version = "v2";
  await runner.environmentChanged();
  await tick();
  assert.deepEqual(closed, ["added-provider-old:environment-changed"]);
  assert.deepEqual(live(runner), ["added-provider-same", "empty-version", "no-version", "same"]);

  // A save that changes nothing restarts nobody.
  await runner.environmentChanged();
  await tick();
  assert.equal(closed.length, 1);

  // A process started after the change is judged by its own next turn only:
  // a stale reading can never make every turn restart.
  const late = add("late", "v1", claude());
  await cliParts(runner).warmAgents.trackWarmRun(late, async () => "done");
  await tick();
  assert.ok(!closed.includes("late:environment-changed"));
  await runner.environmentChanged();
  await tick();
  assert.ok(closed.includes("late:environment-changed"), "a later change finds it");
});

test("nothing is replaced before a change, and a failed reading judges nothing outdated", async () => {
  const { runner, closed, env, add } = setup();
  const entry = add("idle", "v1", claude());
  cliParts(runner).warmAgents.environment.mayBeFree(entry);
  await cliParts(runner).warmAgents.trackWarmRun(entry, async () => undefined);
  await tick();
  assert.deepEqual(closed, []);

  env.version = "v2";
  env.fail = true;
  await runner.environmentChanged();
  await tick();
  assert.deepEqual(closed, [], "the reading failed: nothing is restarted on a guess");
  assert.equal(cliParts(runner).warmAgents.environment.pending(entry), false);
});

test("of two changes told at once, the later reading wins", async () => {
  const { runner, closed, env, add } = setup();
  add("a", "v1", claude());
  add("b", "v3", claude());
  env.version = "v2";
  env.delay = 30;
  const first = runner.environmentChanged();
  await tick(2);
  env.version = "v3";
  env.delay = 0;
  const second = runner.environmentChanged();
  await Promise.all([first, second]);
  await tick();
  assert.deepEqual(closed, ["a:environment-changed"], "v3 stands; the slower v2 reading is not applied");
});

test("background tasks are waited for; meanwhile the member says new values are waiting", async () => {
  const { runner, closed, env, add } = setup();
  const state = { tasks: 1, replying: false };
  let reports = 0;
  const entry = add("claude", "v1", { ...claude(state), refreshBackgroundReport: () => { reports++; } });
  env.version = "v2";
  await runner.environmentChanged();
  await tick();
  assert.deepEqual(closed, [], "its background task keeps it");
  assert.equal(cliParts(runner).warmAgents.environment.pending(entry), true);
  assert.equal(reports, 1, "it is told to report again, the waiting values included");

  // A turn on it ends while the task still runs: kept.
  state.replying = true;
  await cliParts(runner).warmAgents.trackWarmRun(entry, async () => { state.replying = false; });
  await tick();
  assert.deepEqual(closed, []);

  // The values are put back: nothing waits any more.
  env.version = "v1";
  await runner.environmentChanged();
  assert.equal(cliParts(runner).warmAgents.environment.pending(entry), false);
  env.version = "v2";
  await runner.environmentChanged();
  assert.equal(cliParts(runner).warmAgents.environment.pending(entry), true);

  // The task finishes (the process calls back): replaced.
  state.tasks = 0;
  cliParts(runner).warmAgents.environment.mayBeFree(entry);
  await tick();
  assert.deepEqual(closed, ["claude:environment-changed"]);
  assert.equal(cliParts(runner).warmAgents.environment.pending(entry), false);
});

test("a process is replaced only after it has stayed free a while: every sign of life moves that on", async () => {
  const { runner, closed, env, add } = setup(60);
  const state = { replying: false };
  const entry = add("claude", "v1", claude(state));
  const otherState = { replying: false };
  const other = add("other", "v1", claude(otherState));
  env.version = "v2";
  await runner.environmentChanged();
  // The other one starts work on its own before its moment comes.
  otherState.replying = true;
  await tick(35);
  cliParts(runner).warmAgents.environment.mayBeFree(entry);
  await tick(35);
  assert.deepEqual(closed, [], "a line it printed (a late notification, a suggestion) moved the moment on");
  await tick(45);
  assert.deepEqual(closed, ["claude:environment-changed"]);
  assert.deepEqual(live(runner), ["other"], "busy when its moment came: kept until it is free again");
  otherState.replying = false;
  cliParts(runner).warmAgents.environment.mayBeFree(other);
  await tick(80);
  assert.deepEqual(closed.sort(), ["claude:environment-changed", "other:environment-changed"]);
});

test("an environment change waits for a busy member process instead of the member waiting for it", () => {
  const runner = new CliAgentRunner() as any;
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
  const { runner, closed, env } = setup();
  const member = { id: "p1", kind: "claude-code" };
  const warm = { conversationId: "c1", participantId: "p1", contextKey: "", idleTimeoutMs: 1 };
  const runningKey = warmAgentKey(member as never, "/r", "chat", { warm, agentEnvKey: "v1" });
  const state = { replying: true };
  const entry = { name: "p1", key: runningKey, scopeKey: "c1:p1", closed: false, environmentGeneration: 0, ...claude(state) };
  cliParts(runner).warmAgents.entries.set(runningKey, entry);
  env.version = "v2";
  await runner.environmentChanged();
  const routed = cliParts(runner).warmAgents.withBusyMemberEnvironment(member, "/r", "chat", { warm, agentEnvKey: "v2" });
  assert.equal(routed.options.agentEnvKey, "v1");
  // The running reply ends before the routed message reaches the process.
  state.replying = false;
  cliParts(runner).warmAgents.environment.mayBeFree(entry);
  await tick();
  assert.deepEqual(closed, [], "not replaced under a turn that is on its way to it");
  routed.release();
  await tick();
  assert.deepEqual(closed, ["p1:environment-changed"], "that turn is over: replaced");
  routed.release();
  assert.equal((entry as Entry).environmentHolds, 0, "a second release changes nothing");
  assert.equal(routed.options.agentEnvGeneration, 0, "a process started for it (the busy one gone meanwhile) is judged as that one was");
});

test("a Codex process is not closed after a turn, even one that ends while the change settles", async () => {
  const { runner, closed, env, add } = setup(60);
  const running = add("running-codex", "v1");
  const idle = add("idle-codex", "v1");
  let finish!: () => void;
  const turn = cliParts(runner).warmAgents.enqueueWarmRun(running, () => new Promise<void>((resolve) => { finish = resolve; }));
  env.version = "v2";
  await runner.environmentChanged();
  // Its turn ends well within the settle time; a turn reaches the idle one too.
  await tick(10);
  finish();
  await turn;
  await cliParts(runner).warmAgents.trackWarmRun(idle, async () => "done");
  await tick(120);
  assert.deepEqual(closed, [], "what a Codex turn leaves running the app cannot see: its next turn replaces it");

  const found = add("found-idle-codex", "v2");
  env.version = "v3";
  await runner.environmentChanged();
  await tick(120);
  assert.deepEqual(closed.sort(), ["found-idle-codex:environment-changed", "idle-codex:environment-changed", "running-codex:environment-changed"], "found idle by the change: replaced once it settled");
  assert.ok(found.closed);
});

test("a process is judged by the changes told after its turn read the environment, not after it started", async () => {
  const { runner, closed, env } = setup();
  const readBefore = runner.environmentGeneration();
  // Saved while the turn waited between reading the environment and
  // starting its process: the process has the values read before.
  env.version = "v2";
  await runner.environmentChanged();
  const key = JSON.stringify({ conversationId: "c1", participantId: "p1", agentEnvKey: "v1" });
  const tasks = { tasks: 1 };
  const entry = await cliParts(runner).warmAgents.createTrackedWarmAgent(key, async () => ({
    name: "p1", key, scopeKey: "c1:p1", closed: false, queue: Promise.resolve(), ...claude(tasks)
  }), readBefore);
  assert.equal(entry.environmentGeneration, readBefore);
  assert.equal(cliParts(runner).warmAgents.environment.pending(entry), true, "it says new values are waiting");
  tasks.tasks = 0;
  cliParts(runner).warmAgents.environment.mayBeFree(entry);
  await tick();
  assert.deepEqual(closed, ["p1:environment-changed"], "and is replaced once free");

  // One that read the new values is left alone.
  const fresh = JSON.stringify({ conversationId: "c1", participantId: "p2", agentEnvKey: "v2" });
  const second = await cliParts(runner).warmAgents.createTrackedWarmAgent(fresh, async () => ({
    name: "p2", key: fresh, scopeKey: "c1:p2", closed: false, queue: Promise.resolve(), ...claude()
  }), readBefore);
  assert.equal(cliParts(runner).warmAgents.environment.pending(second), false);
});

test("a new process of the member waits until its replaced one has gone", async () => {
  const runner = new CliAgentRunner() as any;
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => { finishClose = resolve; });
  cliParts(runner).warmAgentClose.closingWarmAgents.set({ key: "old", scopeKey: "c1:p1" }, closing);
  cliParts(runner).warmAgentClose.closingWarmAgents.set({ key: "other", scopeKey: "c1:p2" }, new Promise<void>(() => undefined));
  let ready = false;
  const prepared = cliParts(runner).warmAgents.closeStaleWarmAgents("c1:p1", "new").then(() => { ready = true; });
  await tick();
  assert.equal(ready, false, "the old process still holds the session");
  finishClose();
  await prepared;
  assert.equal(ready, true, "another member's closing process is not waited for");
});
