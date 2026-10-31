import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MessagePortMain } from "electron";
import {
  TERMINAL_HOST_STATE_CHANNEL,
  TERMINAL_PORT_CHANNEL,
  TERMINAL_PORT_WINDOW_MESSAGE,
  terminalTitleForCwd,
  terminalWorkspaceMatches
} from "../../shared/terminal";
import { ensureSpawnHelperExecutable } from "./spawnHelper";
import type { MainToTerminalHostMessage, TerminalHostToMainMessage } from "./terminalHostCore";
import {
  TERMINAL_RESTARTED_NOTICE,
  TerminalService,
  missingProjectNotice,
  terminalEnvironment,
  type TerminalHostProcess,
  type TerminalWindow
} from "./terminalService";

class FakeHost implements TerminalHostProcess {
  received: MainToTerminalHostMessage[] = [];
  killed = false;
  running = false;
  answerQueries = true;
  private messageListeners: Array<(message: TerminalHostToMainMessage) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];
  postMessage(message: MainToTerminalHostMessage): void {
    this.received.push(message);
    queueMicrotask(() => {
      if (message.type === "create") this.send({ type: "created", terminalId: message.terminalId });
      if (message.type === "running-query" && this.answerQueries) this.send({ type: "running", requestId: message.requestId, commands: this.running ? ["npm"] : [] });
      if (message.type === "kill") this.send({ type: "exit", terminalId: message.terminalId, exitCode: 0 });
    });
  }
  on(event: "message" | "exit", listener: ((message: TerminalHostToMainMessage) => void) | ((code: number) => void)): void {
    if (event === "message") this.messageListeners.push(listener as (message: TerminalHostToMainMessage) => void);
    else this.exitListeners.push(listener as (code: number) => void);
  }
  kill(): boolean { this.killed = true; return true; }
  send(message: TerminalHostToMainMessage): void { for (const listener of this.messageListeners) listener(message); }
  crash(code = 1): void { for (const listener of this.exitListeners) listener(code); }
}

class FakeWindow implements TerminalWindow {
  sent: Array<{ channel: string; payload: unknown }> = [];
  ports = 0;
  destroyed = false;
  private destroyedListeners: Array<() => void> = [];
  constructor(readonly id: number) {}
  isDestroyed(): boolean { return this.destroyed; }
  send(channel: string, payload: unknown): void { this.sent.push({ channel, payload }); }
  postMessage(): void { this.ports += 1; }
  once(_event: "destroyed", listener: () => void): void { this.destroyedListeners.push(listener); }
  destroy(): void { this.destroyed = true; for (const listener of this.destroyedListeners) listener(); }
}

function service(environment: NodeJS.ProcessEnv = { SHELL: "/bin/sh", PATH: "/usr/bin" }, homeDir = os.tmpdir()) {
  const hosts: FakeHost[] = [];
  const terminalService = new TerminalService({
    forkHost: () => {
      const host = new FakeHost();
      hosts.push(host);
      return host;
    },
    createChannel: () => ({ hostEnd: {} as MessagePortMain, windowEnd: {} as MessagePortMain }),
    environment: async () => environment,
    homeDir,
    platform: "darwin",
    runningQueryTimeoutMs: 50,
    settledPollMs: 20
  });
  const created = () => hosts.flatMap((host) => host.received).filter((message): message is Extract<MainToTerminalHostMessage, { type: "create" }> => message.type === "create");
  return { terminalService, hosts, created };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a terminal opens in the chat's project, by its real path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-project-"));
  const link = `${dir}-link`;
  await symlink(dir, link);
  try {
    const { terminalService, created } = service();
    const terminal = await terminalService.create({ repoPath: link });
    const real = await realpath(dir);
    assert.equal(terminal.cwd, real);
    assert.equal(terminal.workspaceRoot, real);
    assert.equal(terminal.title, path.basename(real));
    assert.equal(created()[0]!.cwd, real);
    assert.equal(created()[0]!.notice, undefined);
    assert.equal(await terminalService.workspaceRoot(link), real);
  } finally {
    await rm(link, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing project opens at home with a notice, still belonging to that project", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "terminal-home-"));
  try {
    const { terminalService, created } = service(undefined, home);
    const gone = path.join(home, "deleted-project");
    const terminal = await terminalService.create({ repoPath: gone });
    assert.equal(terminal.cwd, home);
    assert.equal(terminal.workspaceRoot, gone);
    assert.equal(created()[0]!.notice, missingProjectNotice(gone));
    assert.equal(terminalWorkspaceMatches(terminal.workspaceRoot, await terminalService.workspaceRoot(gone)), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a chat without a project opens at home and belongs to no project", async () => {
  const { terminalService } = service();
  const terminal = await terminalService.create({});
  assert.equal(terminal.cwd, os.tmpdir());
  assert.equal(terminal.workspaceRoot, null);
  assert.equal(await terminalService.workspaceRoot(undefined), null);
  assert.equal(await terminalService.workspaceRoot("  "), null);
});

test("the shell gets the members' environment without the app's own variables", async () => {
  const { terminalService, created } = service({
    SHELL: "/bin/sh",
    PATH: "/usr/bin",
    GH_TOKEN: "from-settings",
    ELECTRON_RUN_AS_NODE: "1",
    ACCORDAGENTS_USER_DATA_DIR: "/x",
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
  });
  await terminalService.create({});
  const message = created()[0]!;
  assert.equal(message.env.GH_TOKEN, "from-settings");
  assert.equal(message.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(message.env.ACCORDAGENTS_USER_DATA_DIR, undefined);
  assert.equal(message.env.VITE_DEV_SERVER_URL, undefined);
  assert.equal(message.env.TERM, "xterm-256color");
  assert.equal(message.env.LANG, "en_US.UTF-8");
  assert.equal(message.shell, "/bin/sh");
  assert.deepEqual(message.args, ["-l"]);
  assert.equal(terminalEnvironment({ LANG: "de_DE.ISO8859-1" }).LANG, "de_DE.ISO8859-1");
});

test("a host that dies keeps the tabs as lost; Restart brings them back in their folders", async () => {
  const { terminalService, hosts, created } = service();
  const window = new FakeWindow(7);
  const first = await terminalService.create({});
  terminalService.watchWindow(window);
  assert.equal(terminalService.connect(window), true);
  hosts[0]!.crash(9);
  const crashed = terminalService.list();
  assert.equal(crashed.hostState, "crashed");
  assert.deepEqual(crashed.terminals.map((terminal) => terminal.lost), [true]);
  assert.equal(window.sent.at(-1)?.channel, TERMINAL_HOST_STATE_CHANNEL);
  assert.equal(terminalService.connect(window), false);
  assert.equal(await terminalService.hasRunningCommand(), false);

  const restarted = await terminalService.restartLost();
  assert.equal(hosts.length, 2);
  assert.equal(restarted.hostState, "running");
  assert.deepEqual(restarted.terminals.map((terminal) => [terminal.terminalId, terminal.lost]), [[first.terminalId, undefined]]);
  const again = created().at(-1)!;
  assert.equal(again.terminalId, first.terminalId);
  assert.equal(again.notice, TERMINAL_RESTARTED_NOTICE);
  assert.equal(terminalService.connect(window), true);
});

test("a host that dies during a start leaves no tab for the shell that never ran", async () => {
  const { terminalService, hosts } = service();
  const window = new FakeWindow(4);
  terminalService.watchWindow(window);
  await terminalService.create({});
  const host = hosts[0]!;
  host.postMessage = (message) => { host.received.push(message); };
  const pending = terminalService.create({});
  await wait(5);
  host.crash(9);
  await assert.rejects(pending, /stopped before it started/);
  const listed = terminalService.list().terminals;
  assert.equal(listed.length, 1, "only the terminal that was running");
  assert.equal(listed[0]!.lost, true);
});

test("a host that dies with no terminals tells the windows, and a new host makes them reconnect", async () => {
  const { terminalService, hosts } = service();
  const window = new FakeWindow(5);
  terminalService.watchWindow(window);
  const terminal = await terminalService.create({});
  terminalService.kill(terminal.terminalId);
  await wait(5);
  hosts[0]!.crash(9);
  assert.deepEqual(window.sent.at(-1), { channel: TERMINAL_HOST_STATE_CHANNEL, payload: { hostState: "stopped", terminals: [] } });
  await terminalService.create({});
  await wait(5);
  assert.equal(hosts.length, 2);
  assert.equal((window.sent.at(-1)?.payload as { hostState: string }).hostState, "running");
});

test("a start that comes after its caller gave up is killed, not left running unseen", async () => {
  const hosts: FakeHost[] = [];
  const terminalService = new TerminalService({
    forkHost: () => {
      const host = new FakeHost();
      host.postMessage = (message) => { host.received.push(message); };
      hosts.push(host);
      return host;
    },
    createChannel: () => ({ hostEnd: {} as MessagePortMain, windowEnd: {} as MessagePortMain }),
    environment: async () => ({ SHELL: "/bin/sh" }),
    platform: "darwin",
    createTimeoutMs: 20
  });
  await assert.rejects(terminalService.create({}), /did not start in time/);
  const created = hosts[0]!.received.find((message) => message.type === "create");
  assert.ok(created && created.type === "create");
  hosts[0]!.send({ type: "created", terminalId: created.terminalId });
  assert.deepEqual(hosts[0]!.received.at(-1), { type: "kill", terminalId: created.terminalId });
  assert.deepEqual(terminalService.list().terminals, []);
});

test("a terminal that cannot start again stays lost", async () => {
  const hosts: FakeHost[] = [];
  let failNextStart = false;
  const terminalService = new TerminalService({
    forkHost: () => {
      const host = new FakeHost();
      const answer = host.postMessage.bind(host);
      host.postMessage = (message) => {
        if (message.type === "create" && failNextStart) {
          failNextStart = false;
          host.received.push(message);
          queueMicrotask(() => host.send({ type: "create-failed", terminalId: message.terminalId, error: "no" }));
          return;
        }
        answer(message);
      };
      hosts.push(host);
      return host;
    },
    createChannel: () => ({ hostEnd: {} as MessagePortMain, windowEnd: {} as MessagePortMain }),
    environment: async () => ({ SHELL: "/bin/sh" }),
    platform: "darwin"
  });
  const first = await terminalService.create({});
  const second = await terminalService.create({});
  hosts[0]!.crash(9);
  failNextStart = true;
  const result = await terminalService.restartLost();
  const lost = Object.fromEntries(result.terminals.map((terminal) => [terminal.terminalId, Boolean(terminal.lost)]));
  assert.deepEqual(lost, { [first.terminalId]: true, [second.terminalId]: false });
});

test("the preload repeats the terminal channel names exactly", async () => {
  const preload = await readFile(path.join(process.cwd(), "src", "preload", "index.ts"), "utf8");
  for (const name of [TERMINAL_PORT_CHANNEL, TERMINAL_HOST_STATE_CHANNEL, TERMINAL_PORT_WINDOW_MESSAGE]) {
    assert.ok(preload.includes(`"${name}"`), `${name} in src/preload/index.ts`);
  }
});

test("closing a lost tab forgets it without a host", async () => {
  const { terminalService, hosts } = service();
  const terminal = await terminalService.create({});
  hosts[0]!.crash();
  terminalService.kill(terminal.terminalId);
  assert.deepEqual(terminalService.list().terminals, []);
});

test("a quit stops the host as expected: no lost tabs, no alarm", async () => {
  const { terminalService, hosts } = service();
  const window = new FakeWindow(1);
  terminalService.watchWindow(window);
  await terminalService.create({});
  await wait(5);
  const told = window.sent.length;
  terminalService.shutdown();
  assert.deepEqual(hosts[0]!.received.at(-1), { type: "shutdown" });
  hosts[0]!.crash(0);
  assert.equal(terminalService.list().hostState, "stopped");
  assert.deepEqual(terminalService.list().terminals, []);
  assert.equal(window.sent.length, told, "no alarm for a quit");
});

test("the update restart waits for a running command and hears when it ends", async () => {
  const { terminalService, hosts } = service();
  assert.equal(await terminalService.hasRunningCommand(), false);
  await terminalService.create({});
  assert.equal(await terminalService.hasRunningCommand(), false);
  hosts[0]!.running = true;
  assert.equal(await terminalService.hasRunningCommand(), true);
  let settled = 0;
  const off = terminalService.onCommandsSettled(() => { settled += 1; });
  await wait(60);
  hosts[0]!.running = false;
  await wait(80);
  off();
  assert.equal(settled, 1);
  // Like the update gate's other checks, an answer it cannot get is "busy".
  hosts[0]!.answerQueries = false;
  assert.equal(await terminalService.hasRunningCommand(), true);
});

test("a shell that ends is forgotten; a window that closes is told to the host", async () => {
  const { terminalService, hosts } = service();
  const window = new FakeWindow(3);
  const terminal = await terminalService.create({});
  terminalService.connect(window);
  terminalService.kill(terminal.terminalId);
  await wait(5);
  assert.deepEqual(terminalService.list().terminals, []);
  window.destroy();
  assert.deepEqual(hosts[0]!.received.at(-1), { type: "window-gone", windowKey: "3" });
});

test("a shell that cannot start is reported, not listed", async () => {
  const hosts: FakeHost[] = [];
  const terminalService = new TerminalService({
    forkHost: () => {
      const host = new FakeHost();
      host.postMessage = (message) => {
        host.received.push(message);
        if (message.type === "create") queueMicrotask(() => host.send({ type: "create-failed", terminalId: message.terminalId, error: "posix_spawnp failed." }));
      };
      hosts.push(host);
      return host;
    },
    createChannel: () => ({ hostEnd: {} as MessagePortMain, windowEnd: {} as MessagePortMain }),
    environment: async () => ({ SHELL: "/bin/sh" }),
    platform: "darwin"
  });
  await assert.rejects(terminalService.create({}), /The terminal could not start: posix_spawnp failed\./);
  assert.deepEqual(terminalService.list().terminals, []);
});

test("node-pty's spawn-helper gets its execute bit back", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-pty-"));
  try {
    const dir = path.join(root, "prebuilds", `${process.platform}-${process.arch}`);
    await mkdir(dir, { recursive: true });
    const helper = path.join(dir, "spawn-helper");
    await writeFile(helper, "#!/bin/sh\n", { mode: 0o644 });
    assert.equal(ensureSpawnHelperExecutable(() => root), helper);
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
    assert.equal(ensureSpawnHelperExecutable(() => path.join(root, "missing")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex's rule for whether a terminal belongs to the open chat", () => {
  assert.equal(terminalWorkspaceMatches(null, null), true);
  assert.equal(terminalWorkspaceMatches(null, "/a"), false);
  assert.equal(terminalWorkspaceMatches("/a", null), false);
  assert.equal(terminalWorkspaceMatches("/a/", "/a"), true);
  assert.equal(terminalWorkspaceMatches("/a", "/b"), false);
  assert.equal(terminalTitleForCwd("/Users/me/mctb-all"), "mctb-all");
  assert.equal(terminalTitleForCwd("/"), "/");
});

test("a shell that ends before its start is confirmed is not listed", async () => {
  const terminalService = new TerminalService({
    forkHost: () => {
      const host = new FakeHost();
      host.postMessage = (message) => {
        host.received.push(message);
        if (message.type === "create") {
          host.send({ type: "exit", terminalId: message.terminalId, exitCode: 1 });
          queueMicrotask(() => host.send({ type: "created", terminalId: message.terminalId }));
        }
      };
      return host;
    },
    createChannel: () => ({ hostEnd: {} as MessagePortMain, windowEnd: {} as MessagePortMain }),
    environment: async () => ({ SHELL: "/bin/sh" }),
    platform: "darwin"
  });
  await assert.rejects(terminalService.create({}), /ended as soon as it started/);
  assert.deepEqual(terminalService.list().terminals, []);
});

test("Restart clicked twice starts each lost terminal once", async () => {
  const { terminalService, hosts, created } = service();
  await terminalService.create({});
  hosts[0]!.crash(9);
  const [first, second] = await Promise.all([terminalService.restartLost(), terminalService.restartLost()]);
  assert.deepEqual(first, second);
  assert.equal(created().length, 2, "one original start, one restart");
  assert.equal(first.terminals[0]!.lost, undefined);
});

test("a lost tab closed while Restart brings it back is killed, not left running unseen", async () => {
  const { terminalService, hosts } = service();
  const terminal = await terminalService.create({});
  hosts[0]!.crash(9);
  const restarting = terminalService.restartLost();
  terminalService.kill(terminal.terminalId);
  const result = await restarting;
  assert.deepEqual(result.terminals, []);
  assert.deepEqual(hosts[1]!.received.at(-1), { type: "kill", terminalId: terminal.terminalId });
});

test("a shell that ends is told to every window, also one without a port", async () => {
  const { terminalService, hosts } = service();
  const window = new FakeWindow(6);
  terminalService.watchWindow(window);
  const terminal = await terminalService.create({});
  hosts[0]!.send({ type: "exit", terminalId: terminal.terminalId, exitCode: 0 });
  assert.deepEqual(window.sent.at(-1), { channel: TERMINAL_HOST_STATE_CHANNEL, payload: { hostState: "running", terminals: [] } });
});

test("a command that ends before the first look still settles the update wait", async () => {
  const { terminalService } = service();
  await terminalService.create({});
  let settled = 0;
  const off = terminalService.onCommandsSettled(() => { settled += 1; });
  for (let attempt = 0; attempt < 100 && settled === 0; attempt += 1) await wait(10);
  off();
  assert.equal(settled, 1);
});

test("the quit check hears which commands run, nothing without terminals, and 'unknown' when the host is silent", async () => {
  const { terminalService, hosts } = service();
  assert.equal(terminalService.hasLiveTerminals(), false);
  assert.deepEqual(await terminalService.runningCommands(), []);
  await terminalService.create({});
  assert.equal(terminalService.hasLiveTerminals(), true);
  assert.deepEqual(await terminalService.runningCommands(), []);
  hosts[0]!.running = true;
  assert.deepEqual(await terminalService.runningCommands(), ["npm"]);
  hosts[0]!.answerQueries = false;
  assert.equal(await terminalService.runningCommands(), undefined);
  hosts[0]!.crash(9);
  assert.equal(terminalService.hasLiveTerminals(), false, "lost tabs have nothing left to stop");
});
