import assert from "node:assert/strict";
import test from "node:test";
import { spawn as spawnPty } from "node-pty";
import {
  TERMINAL_FLOW_HIGH_WATERMARK,
  TERMINAL_FLOW_LOW_WATERMARK,
  type TerminalHostToWindowMessage,
  type TerminalWindowToHostMessage
} from "../../shared/terminal";
import { readForegroundGroup } from "./foregroundGroup";
import { ensureSpawnHelperExecutable } from "./spawnHelper";
import { TerminalHostCore, type ForegroundGroup, type HostPty, type HostSpawnOptions, type TerminalHostToMainMessage } from "./terminalHostCore";

let nextPid = 1000;

class FakePty implements HostPty {
  readonly pid = nextPid++;
  process = "zsh";
  paused = false;
  killed = false;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((item) => item !== listener); } };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((item) => item !== listener); } };
  }
  emit(data: string): void { for (const listener of this.dataListeners) listener(data); }
  exit(exitCode = 0): void { for (const listener of this.exitListeners) listener({ exitCode }); }
  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  kill(): void { this.killed = true; this.exit(129); }
}

function harness(foregroundGroup?: ForegroundGroup) {
  const ptys: FakePty[] = [];
  const spawned: HostSpawnOptions[] = [];
  const toMain: TerminalHostToMainMessage[] = [];
  const core = new TerminalHostCore((options) => {
    spawned.push(options);
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  }, (message) => toMain.push(message), foregroundGroup);
  const posted: TerminalHostToWindowMessage[] = [];
  let closed = false;
  const port = { post: (message: TerminalHostToWindowMessage) => posted.push(message), close: () => { closed = true; } };
  const create = (terminalId = "t1", notice?: string) => core.handleMain({
    type: "create", terminalId, shell: "/bin/zsh", args: ["-l"], cwd: "/tmp", env: {}, cols: 80, rows: 24, ...(notice ? { notice } : {})
  });
  const connect = (windowKey = "w1") => core.handleMain({ type: "connect", windowKey }, port);
  const snapshots = () => posted.filter((message): message is Extract<TerminalHostToWindowMessage, { type: "snapshot" }> => message.type === "snapshot");
  const dataText = () => posted.map((message) => message.type === "data" ? message.data : "").join("");
  return { core, ptys, spawned, toMain, posted, port, create, connect, snapshots, dataText, isClosed: () => closed };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls instead of sleeping a fixed time, so a loaded machine cannot fail it. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(5);
  }
}

async function attach(h: ReturnType<typeof harness>, terminalId = "t1", cols = 100, rows = 30): Promise<void> {
  const before = h.snapshots().length;
  h.core.handleWindow("w1", { type: "attach", terminalId, cols, rows });
  await waitFor(() => h.snapshots().length > before, "snapshot");
}

test("a window that attaches gets the screen so far, then live output", async () => {
  const h = harness();
  h.create();
  assert.deepEqual(h.toMain, [{ type: "created", terminalId: "t1" }]);
  h.ptys[0]!.emit("before-attach\r\n");
  h.connect();
  await attach(h);
  const snapshot = h.snapshots()[0]!;
  assert.match(snapshot.serialized, /before-attach/);
  assert.deepEqual([snapshot.cols, snapshot.rows], [100, 30]);
  assert.deepEqual(h.ptys[0]!.sizes.at(-1), [100, 30]);
  h.ptys[0]!.emit("after-attach");
  await waitFor(() => h.dataText() === "after-attach", "live output");
});

test("output that arrives while the snapshot is taken comes after it, once", async () => {
  const h = harness();
  h.create();
  h.connect();
  h.ptys[0]!.emit("one ");
  h.core.handleWindow("w1", { type: "attach", terminalId: "t1", cols: 80, rows: 24 });
  h.ptys[0]!.emit("two ");
  await waitFor(() => h.snapshots().length === 1, "snapshot");
  h.ptys[0]!.emit("three");
  await waitFor(() => h.dataText() === "two three", "output after the snapshot");
  assert.match(h.snapshots()[0]!.serialized, /one/);
  assert.doesNotMatch(h.snapshots()[0]!.serialized, /two/);
  assert.equal(h.posted.findIndex((message) => message.type === "snapshot"), 0);
});

test("a shell is held back while the window is behind, and let go only once it has caught up", async () => {
  const h = harness();
  h.create();
  h.connect();
  await attach(h, "t1", 80, 24);
  const chunk = "x".repeat(TERMINAL_FLOW_HIGH_WATERMARK + 10);
  h.ptys[0]!.emit(chunk);
  await waitFor(() => h.ptys[0]!.paused, "pause");
  await waitFor(() => h.dataText().length === chunk.length, "delivery", 20_000);
  // Partly caught up, still above the low watermark: still held.
  h.core.handleWindow("w1", { type: "ack", terminalId: "t1", chars: chunk.length - TERMINAL_FLOW_LOW_WATERMARK });
  assert.equal(h.ptys[0]!.paused, true);
  h.core.handleWindow("w1", { type: "ack", terminalId: "t1", chars: 1 });
  await waitFor(() => !h.ptys[0]!.paused, "resume");
});

test("a runaway shell nobody watches is paced by the mirror and never floods the host", async () => {
  const h = harness();
  h.create();
  h.ptys[0]!.emit("y\r\n".repeat(TERMINAL_FLOW_HIGH_WATERMARK));
  assert.equal(h.ptys[0]!.paused, true, "held while the mirror is behind");
  await waitFor(() => !h.ptys[0]!.paused, "the mirror catching up", 20_000);
});

test("output held during an attach counts toward holding the shell back", async () => {
  const h = harness();
  h.create();
  h.connect();
  h.core.handleWindow("w1", { type: "attach", terminalId: "t1", cols: 80, rows: 24 });
  h.ptys[0]!.emit("z".repeat(TERMINAL_FLOW_HIGH_WATERMARK + 10));
  await waitFor(() => h.snapshots().length === 1, "snapshot", 20_000);
  await waitFor(() => h.dataText().length === TERMINAL_FLOW_HIGH_WATERMARK + 10, "held output");
  assert.equal(h.ptys[0]!.paused, true, "the window has not confirmed the held output yet");
});

test("a window that goes away, attaches again or hides the terminal lets a held shell go", async () => {
  const h = harness();
  h.create();
  h.connect();
  await attach(h);
  const heavy = "z".repeat(TERMINAL_FLOW_HIGH_WATERMARK + 1);
  const holdBack = async (): Promise<void> => {
    const before = h.dataText().length;
    h.ptys[0]!.emit(heavy);
    await waitFor(() => h.ptys[0]!.paused, "pause");
    await waitFor(() => h.dataText().length === before + heavy.length, "delivery", 20_000);
  };
  await holdBack();
  await attach(h);
  await waitFor(() => !h.ptys[0]!.paused, "resume on attach");
  await holdBack();
  h.core.handleWindow("w1", { type: "detach", terminalId: "t1" });
  await waitFor(() => !h.ptys[0]!.paused, "resume on detach");
  const sent = h.posted.length;
  h.ptys[0]!.emit("not shown");
  await wait(30);
  assert.equal(h.posted.length, sent, "a hidden terminal's output goes only to the mirror");
  await attach(h);
  await holdBack();
  h.core.portClosed("w1");
  await waitFor(() => !h.ptys[0]!.paused, "resume on close");
  h.connect("w2");
  h.core.handleMain({ type: "window-gone", windowKey: "w2" });
  assert.equal(h.isClosed(), true);
});

test("a shell that ends is reported to every window, shown or not, and to main", async () => {
  const h = harness();
  h.create();
  h.connect();
  h.ptys[0]!.exit(0);
  assert.deepEqual(h.posted.at(-1), { type: "exit", terminalId: "t1", exitCode: 0, signal: undefined });
  assert.deepEqual(h.toMain.at(-1), { type: "exit", terminalId: "t1", exitCode: 0, signal: undefined });
  assert.equal(h.core.sessionCount(), 0);
});

test("attaching to a shell that already ended closes the window's tab", () => {
  const h = harness();
  h.create();
  h.ptys[0]!.exit(0);
  h.connect();
  h.core.handleWindow("w1", { type: "attach", terminalId: "t1", cols: 80, rows: 24 });
  assert.deepEqual(h.posted, [{ type: "exit", terminalId: "t1", exitCode: -1 }]);
});

test("a shell ending while its snapshot is taken sends the exit and nothing after it", async () => {
  const h = harness();
  h.create();
  h.connect();
  h.ptys[0]!.emit("some output");
  h.core.handleWindow("w1", { type: "attach", terminalId: "t1", cols: 80, rows: 24 });
  h.ptys[0]!.exit(0);
  await wait(50);
  assert.deepEqual(h.posted, [{ type: "exit", terminalId: "t1", exitCode: 0, signal: undefined }]);
});

test("a command is running when something other than the shell leads its terminal", async () => {
  let group: number | undefined;
  const h = harness(async () => group);
  h.create();
  const shell = h.ptys[0]!;
  group = shell.pid;
  shell.process = "bash"; // macOS /bin/sh names itself bash at its prompt
  assert.equal((await h.core.runningCommands()).length > 0, false);
  group = shell.pid + 7;
  assert.equal((await h.core.runningCommands()).length > 0, true);
  h.core.handleMain({ type: "running-query", requestId: "q1" });
  await waitFor(() => h.toMain.at(-1)?.type === "running", "answer");
  assert.deepEqual(h.toMain.at(-1), { type: "running", requestId: "q1", commands: ["bash"] });
  shell.process = "npm";
  assert.deepEqual(await h.core.runningCommands(), ["npm"]);
  shell.process = "zsh";
  assert.deepEqual(await h.core.runningCommands(), [null], "running, but under the shell's own name");
});

test("without a process group the foreground name decides", async () => {
  const h = harness();
  h.create();
  const shell = h.ptys[0]!;
  for (const [name, running] of [["zsh", false], ["-zsh", false], ["", false], ["vim", true]] as const) {
    shell.process = name;
    assert.equal((await h.core.runningCommands()).length > 0, running, name);
  }
  Object.defineProperty(shell, "process", { get: () => { throw new Error("gone"); } });
  assert.equal((await h.core.runningCommands()).length > 0, false);
});

test("the notice is the first line on the screen", async () => {
  const h = harness();
  h.create("t1", "Project folder /gone was not found on this computer.");
  h.connect();
  await attach(h);
  assert.match(h.snapshots()[0]!.serialized, /Project folder \/gone was not found on this computer\./);
});

test("input and resize reach the shell; malformed window messages change nothing", async () => {
  const h = harness();
  h.create();
  h.connect();
  await attach(h, "t1", 100, 30);
  const shell = h.ptys[0]!;
  h.core.handleWindow("w1", { type: "input", terminalId: "t1", data: "ls\r" });
  h.core.handleWindow("w1", { type: "resize", terminalId: "t1", cols: 120, rows: 40 });
  assert.deepEqual(shell.written, ["ls\r"]);
  assert.deepEqual(shell.sizes.at(-1), [120, 40]);
  const malformed = [
    { type: "input", terminalId: "t1", data: "" },
    { type: "input", terminalId: "t1", data: 42 },
    { type: "resize", terminalId: "t1", cols: Number.NaN, rows: -3 },
    { type: "resize", terminalId: "t1", cols: 0, rows: 0 },
    { type: "ack", terminalId: "t1", chars: Number.NaN },
    { type: "ack", terminalId: "t1", chars: -5 },
    { type: "input", terminalId: "nope", data: "rm -rf /\r" },
    { type: "input", terminalId: 7, data: "x" },
    null
  ] as unknown as TerminalWindowToHostMessage[];
  for (const message of malformed) h.core.handleWindow("w1", message);
  h.core.handleWindow("other-window", { type: "input", terminalId: "t1", data: "x" });
  h.core.handleWindow("w1", { type: "resize", terminalId: "t1", cols: 5000, rows: 2 });
  assert.deepEqual(shell.written, ["ls\r"]);
  assert.deepEqual(shell.sizes.at(-1), [1000, 2]);
  assert.equal(shell.paused, false);
});

test("a failed or duplicate start is reported", () => {
  const h = harness();
  h.create();
  h.create();
  assert.deepEqual(h.toMain.at(-1), { type: "create-failed", terminalId: "t1", error: "A terminal with this id already exists." });
  const failing = new TerminalHostCore(() => { throw new Error("posix_spawnp failed."); }, (message) => h.toMain.push(message));
  failing.handleMain({ type: "create", terminalId: "bad", shell: "/bin/zsh", args: [], cwd: "/", env: {}, cols: 80, rows: 24 });
  assert.deepEqual(h.toMain.at(-1), { type: "create-failed", terminalId: "bad", error: "posix_spawnp failed." });
});

for (const [shell, args] of [["/bin/sh", []], ["/bin/zsh", ["-l"]]] as const) {
  test(`a real ${shell} through node-pty: output, size, idle versus running, hangup`, { skip: process.platform === "win32" }, async () => {
    ensureSpawnHelperExecutable();
    const toMain: TerminalHostToMainMessage[] = [];
    const core = new TerminalHostCore((options) => spawnPty(options.shell, options.args, {
      name: "xterm-256color",
      cwd: options.cwd,
      env: options.env as { [key: string]: string },
      cols: options.cols,
      rows: options.rows
    }), (message) => toMain.push(message), readForegroundGroup);
    const posted: TerminalHostToWindowMessage[] = [];
    core.handleMain({
      type: "create", terminalId: "real", shell, args: [...args], cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color", PS1: "$ " }, cols: 80, rows: 24
    });
    assert.deepEqual(toMain[0], { type: "created", terminalId: "real" });
    core.handleMain({ type: "connect", windowKey: "w" }, { post: (message) => posted.push(message), close: () => undefined });
    core.handleWindow("w", { type: "attach", terminalId: "real", cols: 90, rows: 20 });
    const text = () => posted.map((message) => message.type === "data" ? message.data : "").join("");
    core.handleWindow("w", { type: "input", terminalId: "real", data: "stty size; echo marker-$((40+2))\r" });
    await waitFor(() => /marker-42/.test(text()), "marker", 10_000);
    await waitFor(() => /20 90/.test(text()), "size", 10_000);
    assert.equal((await core.runningCommands()).length > 0, false, "a shell at its prompt is not running a command");
    core.handleWindow("w", { type: "input", terminalId: "real", data: "sleep 5\r" });
    let running = false;
    for (let attempt = 0; attempt < 60 && !running; attempt += 1) {
      await wait(50);
      running = (await core.runningCommands()).length > 0;
    }
    assert.equal(running, true);
    core.handleMain({ type: "kill", terminalId: "real" });
    await waitFor(() => core.sessionCount() === 0, "hangup", 10_000);
    assert.equal(toMain.at(-1)?.type, "exit");
  });
}
