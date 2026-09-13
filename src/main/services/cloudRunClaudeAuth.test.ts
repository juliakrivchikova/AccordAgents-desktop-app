import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CloudRunClaudeAuth, claudeAuthCommand } from "./cloudRunClaudeAuth";
import type { CloudRunSshExecRequest } from "./cloudRunDoctor";
import { runCommand } from "./command";
import { PassThrough } from "node:stream";

const worker = { host: "worker", profileHome: "/home/one" };
// Native 2.1.232 on the real AWS worker uses claude.com/cai, not claude.ai.
const url = "https://claude.com/cai/oauth/authorize?state=state_one&code_challenge=challenge";
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function pendingExec() {
  let request!: CloudRunSshExecRequest;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const service = new CloudRunClaudeAuth(value => {
    request = value;
    return new Promise<string>((resolve, reject) => {
      finish = () => resolve(""); fail = reject;
      value.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  return { service, get request() { return request; }, finish: () => finish(), fail: () => fail(new Error("secret raw output")) };
}

test("split native URL produces one scoped challenge; replies use stdin and repeated delivery is idempotent", async () => {
  const f = pendingExec(); const ids: string[] = [];
  const run = f.service.run(worker, p => { if (p.authRequestId) ids.push(p.authRequestId); });
  await tick();
  f.request.onStdout?.(`Opening browser\n${url.slice(0, 46)}`);
  await tick(); assert.equal(ids.length, 0);
  f.request.onStdout?.(`${url.slice(46)}\nPaste code here if prompted > `);
  await tick(); assert.equal(ids.length, 1);
  const input: string[] = [];
  f.request.inputStream?.on("data", chunk => input.push(String(chunk)));
  assert.throws(() => f.service.submit(ids[0], "code#other_state"), /another sign-in/);
  assert.throws(() => f.service.submit(ids[0], "code#state_one\nINJECT"), /complete sign-in code/);
  f.service.submit(ids[0], "  code#state_one  ");
  f.service.submit(ids[0], "code#state_one");
  assert.throws(() => f.service.submit(ids[0], "other#state_one"), /already checking/);
  assert.deepEqual(input, ["code#state_one\n"]);
  assert.equal(f.request.command.includes("code#state_one"), false);
  assert.equal(f.request.retryAttempts, 1);
  f.finish(); await run;
  assert.equal(f.service.isActive(ids[0]), false);
  assert.throws(() => f.service.submit(ids[0], "code#state_one"), /expired or was interrupted/);
});

test("cancel releases the worker, invalidates the challenge, and a new attempt gets a new id", async () => {
  const f = pendingExec(); const ids: string[] = [];
  const run = f.service.run(worker, p => { if (p.authRequestId) ids.push(p.authRequestId); });
  await tick(); f.request.onStdout?.(`${url}\n`); await tick();
  await assert.rejects(f.service.run(worker, () => undefined), /already running/);
  const rejected = assert.rejects(run, /cancelled/);
  f.service.cancel(ids[0]); await rejected;
  assert.equal(f.service.isActive(ids[0]), false);
  const retry = f.service.run(worker, p => { if (p.authRequestId) ids.push(p.authRequestId); });
  await tick(); f.request.onStdout?.(`${url}\n`); await tick();
  assert.notEqual(ids[0], ids[1]); f.finish(); await retry;
});

test("failed publication aborts native login before opening the browser", async () => {
  let opened = false;
  const auth = new CloudRunClaudeAuth(request => new Promise((resolve, reject) => {
    request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    request.onStdout?.(`${url}\n`);
  }), () => { opened = true; });
  await assert.rejects(auth.run(worker, async p => { if (p.authRequestId) throw new Error("save failed"); }), /could not save/);
  assert.equal(opened, false);
});

test("untrusted URLs never open; native failure output does not expose secrets", async () => {
  for (const output of ["https://attacker.invalid/oauth/authorize?state=state_one\n", "https://claude.ai:444/oauth/authorize?state=state_one\n"]) {
    let opened = false;
    const auth = new CloudRunClaudeAuth(request => new Promise((resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new Error("secret")), { once: true });
      request.onStdout?.(output);
    }), () => { opened = true; });
    await assert.rejects(auth.run(worker, () => undefined), /unsupported sign-in page/); assert.equal(opened, false);
  }
  const f = pendingExec();
  const rejected = assert.rejects(f.service.run(worker, () => undefined), error => error instanceof Error && !error.message.includes("secret"));
  await tick(); f.fail(); await rejected;
});

test("the remote wrapper passes interactive input and terminates its login on EOF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-auth-command-"));
  const executable = path.join(dir, "fake-claude");
  try {
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("waiting\\n"); process.stdin.on("data", x => { process.stdout.write("received:" + x); process.exit(0); }); setInterval(() => {}, 1000);', { mode: 0o700 });
    const input = new PassThrough();
    const result = await runCommand("bash", ["-c", claudeAuthCommand(executable)], {
      inputStream: input, timeoutMs: 5000, primeLoginShellEnv: false,
      onStdout: text => { if (text.includes("waiting")) input.write("test#state\n"); }
    });
    input.destroy(); assert.match(result.stdout, /received:test#state/);
    const eof = new PassThrough();
    await assert.rejects(runCommand("bash", ["-c", claudeAuthCommand(executable)], {
      inputStream: eof, timeoutMs: 5000, primeLoginShellEnv: false,
      onStdout: text => { if (text.includes("waiting")) eof.end(); }
    }), error => error instanceof Error && /exited with code 1/.test(error.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
