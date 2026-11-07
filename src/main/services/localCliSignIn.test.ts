import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CliSignInState } from "../../shared/types";
import { CommandError } from "./command";
import { LocalCliSignInService, findSignInPage, lastMeaningfulLine } from "./localCliSignIn";

const CLAUDE_PAGE = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=STATE123";
const CODEX_PAGE = "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=xyz";

/** A stand-in CLI: a node script that prints what the real one prints. */
async function fakeCli(t: test.TestContext, body: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "aa-cli-sign-in-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-cli");
  await writeFile(file, `#!${process.execPath}\nconst fs = require("node:fs");\nconst dir = ${JSON.stringify(dir)};\n${body}\n`);
  await chmod(file, 0o755);
  return { dir, path: file };
}

function service(cliPath: string | undefined, options: { timeoutMs?: number; manualEnv?: NodeJS.ProcessEnv } = {}) {
  const states: CliSignInState[] = [];
  const events: string[] = [];
  const signIns = new LocalCliSignInService((state) => { states.push(state); events.push(state.status); }, {
    refreshEnvironment: async () => ({ ok: true, env: { ...process.env } }),
    manualEnvironment: async () => options.manualEnv ?? {},
    lookup: async () => cliPath ? { status: "found", path: cliPath } : { status: "not-found" },
    timeoutMs: options.timeoutMs ?? 10_000,
    onSignedIn: (kind) => { events.push(`signed-in:${kind}`); }
  });
  return { signIns, states, events };
}

async function until(states: CliSignInState[], predicate: (state: CliSignInState) => boolean, timeoutMs = 5_000): Promise<CliSignInState> {
  const started = Date.now();
  for (;;) {
    const found = states.find(predicate);
    if (found) return found;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no matching state; saw ${states.map((state) => state.status).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a sign-in that completes in the browser ends as succeeded and shows the CLI's fallback page", async (t) => {
  const cli = await fakeCli(t, `
fs.writeFileSync(dir + "/argv", JSON.stringify(process.argv.slice(2)));
// Like the real codex, its sign-in text goes to stderr.
process.stderr.write("Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\n${CODEX_PAGE}\\n");
setTimeout(() => { process.stderr.write("Successfully logged in\\n"); process.exit(0); }, 300);
`);
  const { signIns, states, events } = service(cli.path);
  const started = signIns.start("codex-cli");
  assert.equal(started.status, "starting");
  const withPage = await until(states, (state) => Boolean(state.pageUrl));
  assert.equal(withPage.pageUrl, CODEX_PAGE);
  assert.equal(withPage.pageGivesCode, false);
  const done = await until(states, (state) => state.status === "succeeded");
  assert.equal(done.requestId, started.requestId);
  assert.deepEqual(JSON.parse(await readFile(path.join(cli.dir, "argv"), "utf8")), ["login"]);
  assert.ok(states.some((state) => state.status === "waiting"), "waiting is reported once the CLI runs");
  assert.deepEqual(events.slice(-2), ["signed-in:codex-cli", "succeeded"], "readiness is reset before success is reported");
  assert.throws(() => signIns.submitCode(started.requestId, "a#b"), /has ended/);
  const revisions = states.map((state) => state.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), "revisions only grow");
});

test("Claude's pasted code reaches the CLI once, only for this sign-in, and success follows", async (t) => {
  const cli = await fakeCli(t, `
fs.writeFileSync(dir + "/argv", JSON.stringify(process.argv.slice(2)));
process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: ${CLAUDE_PAGE}\\nPaste code here if prompted > ");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  fs.writeFileSync(dir + "/code", input);
  if (input.trim() === "good#STATE123") { process.stdout.write("Login successful.\\n"); process.exit(0); }
  process.stdout.write("Login failed: Request failed with status code 400\\n"); process.exit(1);
});
`);
  const { signIns, states } = service(cli.path);
  const { requestId } = signIns.start("claude-code");
  const page = await until(states, (state) => Boolean(state.pageUrl));
  assert.equal(page.pageGivesCode, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(cli.dir, "argv"), "utf8")), ["auth", "login"]);

  assert.throws(() => signIns.submitCode(requestId, "good#OTHER"), /another sign-in/);
  assert.throws(() => signIns.submitCode(requestId, "not a code"), /complete code/);
  assert.throws(() => signIns.submitCode("someone-else", "good#STATE123"), /has ended/);
  signIns.submitCode(requestId, "  good#STATE123 ");
  signIns.submitCode(requestId, "good#STATE123");
  await until(states, (state) => state.status === "checking-code");
  await until(states, (state) => state.status === "succeeded");
  assert.equal(await readFile(path.join(cli.dir, "code"), "utf8"), "good#STATE123\n", "the same code is written once");
});

test("a code Claude refuses ends the sign-in as failed in Claude's own words", async (t) => {
  const cli = await fakeCli(t, `
process.stdout.write("If the browser didn't open, visit: ${CLAUDE_PAGE}\\nPaste code here if prompted > ");
process.stdin.on("data", () => { process.stdout.write("Login failed: Request failed with status code 400\\n"); process.exit(1); });
`);
  const { signIns, states } = service(cli.path);
  const { requestId } = signIns.start("claude-code");
  await until(states, (state) => Boolean(state.pageUrl));
  signIns.submitCode(requestId, "wrong#STATE123");
  const failed = await until(states, (state) => state.status === "failed");
  assert.equal(failed.message, "Login failed: Request failed with status code 400", "the card names the CLI; its words stay as they are");
  assert.throws(() => signIns.submitCode(requestId, "good#STATE123"), /has ended/);
});

test("Cancel stops the CLI and its children; a second Sign in starts a new one", async (t) => {
  const cli = await fakeCli(t, `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(dir + "/pids", JSON.stringify([process.pid, child.pid]));
process.stdout.write("If your browser did not open, navigate to this URL to authenticate:\\n${CODEX_PAGE}\\n");
setInterval(() => {}, 1000);
`);
  const { signIns, states } = service(cli.path);
  const first = signIns.start("codex-cli");
  assert.equal(signIns.start("codex-cli").requestId, first.requestId, "a second press while it runs is the same sign-in");
  await until(states, (state) => Boolean(state.pageUrl));
  const pids = JSON.parse(await readFile(path.join(cli.dir, "pids"), "utf8")) as number[];
  signIns.cancel(first.requestId);
  await until(states, (state) => state.status === "cancelled");
  for (const pid of pids) {
    await gone(pid);
  }
  const second = signIns.start("codex-cli");
  assert.notEqual(second.requestId, first.requestId);
  signIns.shutdown();
  await until(states, (state) => state.requestId === second.requestId && state.status === "cancelled");
});

test("Cancel before the CLI starts ends it as cancelled without running it", async (t) => {
  const cli = await fakeCli(t, `fs.writeFileSync(dir + "/ran", "yes");`);
  const states: CliSignInState[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const signIns = new LocalCliSignInService((state) => states.push(state), {
    refreshEnvironment: async () => { await gate; return { ok: true, env: { ...process.env } }; },
    lookup: async () => ({ status: "found", path: cli.path })
  });
  const { requestId } = signIns.start("claude-code");
  signIns.cancel(requestId);
  release();
  await until(states, (state) => state.status === "cancelled");
  await assert.rejects(readFile(path.join(cli.dir, "ran"), "utf8"));
});

test("a sign-in nobody finishes is stopped at the time limit, and its CLI with it", async (t) => {
  const cli = await fakeCli(t, `fs.writeFileSync(dir + "/pid", String(process.pid)); setInterval(() => {}, 1000);`);
  const { signIns, states } = service(cli.path, { timeoutMs: 1_500 });
  signIns.start("claude-code");
  const failed = await until(states, (state) => state.status === "failed");
  assert.match(failed.message ?? "", /within 1 minute and was stopped/);
  await gone(Number(await readFile(path.join(cli.dir, "pid"), "utf8")));
});

test("a code is refused where the CLI reads none, and while another is being checked", async (t) => {
  const codex = await fakeCli(t, `process.stderr.write("navigate to this URL to authenticate:\\n${CODEX_PAGE}\\n"); setInterval(() => {}, 1000);`);
  const codexRun = service(codex.path);
  const codexSignIn = codexRun.signIns.start("codex-cli");
  await until(codexRun.states, (state) => Boolean(state.pageUrl));
  assert.throws(() => codexRun.signIns.submitCode(codexSignIn.requestId, "a#b"), /does not take a code/);
  codexRun.signIns.shutdown();

  const claude = await fakeCli(t, `
process.stdout.write("Opening browser to sign in…\\n");
setTimeout(() => process.stdout.write("If the browser didn't open, visit: ${CLAUDE_PAGE}\\nPaste code here if prompted > "), 400);
process.stdin.on("data", (chunk) => fs.appendFileSync(dir + "/codes", chunk));
setInterval(() => {}, 1000);
`);
  const claudeRun = service(claude.path);
  const { requestId } = claudeRun.signIns.start("claude-code");
  await until(claudeRun.states, (state) => state.status === "waiting");
  assert.throws(() => claudeRun.signIns.submitCode(requestId, "good#STATE123"), /does not take a code/, "not before the CLI printed its page");
  await until(claudeRun.states, (state) => Boolean(state.pageUrl));
  claudeRun.signIns.submitCode(requestId, "good#STATE123");
  assert.throws(() => claudeRun.signIns.submitCode(requestId, "other#STATE123"), /already checking/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await readFile(path.join(claude.dir, "codes"), "utf8"), "good#STATE123\n");
  claudeRun.signIns.shutdown();
  await until(claudeRun.states, (state) => state.status === "cancelled");
});

test("a CLI that exits without a word fails with a plain message", async (t) => {
  const cli = await fakeCli(t, `process.exit(1);`);
  const { signIns, states } = service(cli.path);
  signIns.start("codex-cli");
  assert.equal((await until(states, (state) => state.status === "failed")).message, "Codex sign-in did not finish. Try again.");
});

test("a Cancel that lands after the CLI already signed in still reports success", async () => {
  const states: CliSignInState[] = [];
  let signedIn = 0;
  const signIns = new LocalCliSignInService((state) => states.push(state), {
    refreshEnvironment: async () => ({ ok: true, env: {} }),
    lookup: async () => ({ status: "found", path: "/bin/claude" }),
    onSignedIn: () => { signedIn += 1; },
    run: async (command, args, options) => {
      assert.deepEqual(args, ["auth", "login"], "the arguments come from the Terminal command shown");
      assert.deepEqual(options?.envOptions?.dropProcessEnvKeysAbsentFromLoginShell, ["ANTHROPIC_API_KEY"]);
      options?.onSpawn?.(1);
      throw new CommandError(`${command} was cancelled`, { command, args, stdout: "", stderr: "", exitCode: 0, timedOut: false });
    },
    envOptions: { "claude-code": { dropProcessEnvKeysAbsentFromLoginShell: ["ANTHROPIC_API_KEY"] } }
  });
  signIns.start("claude-code");
  await until(states, (state) => state.status === "succeeded");
  assert.equal(signedIn, 1);
});

test("the CLI runs with the variables members get, so the credentials land where they look", async (t) => {
  const cli = await fakeCli(t, `fs.writeFileSync(dir + "/env", process.env.CLAUDE_CONFIG_DIR || ""); process.exit(0);`);
  const { signIns, states } = service(cli.path, { manualEnv: { CLAUDE_CONFIG_DIR: "/tmp/members-claude" } });
  signIns.start("claude-code");
  await until(states, (state) => state.status === "succeeded");
  assert.equal(await readFile(path.join(cli.dir, "env"), "utf8"), "/tmp/members-claude");
});

test("a missing CLI, an unreadable environment and an unknown provider fail plainly", async () => {
  const missing = service(undefined);
  missing.signIns.start("codex-cli");
  assert.equal((await until(missing.states, (state) => state.status === "failed")).message, "Codex was not found on this computer.");

  const unknownStates: CliSignInState[] = [];
  new LocalCliSignInService((state) => unknownStates.push(state), {
    refreshEnvironment: async () => ({ ok: true, env: {} }),
    lookup: async () => ({ status: "unknown", timedOut: true })
  }).start("claude-code");
  assert.match((await until(unknownStates, (state) => state.status === "failed")).message ?? "", /just now/, "a lookup that timed out is not called missing");

  const states: CliSignInState[] = [];
  const noEnv = new LocalCliSignInService((state) => states.push(state), {
    refreshEnvironment: async () => ({ ok: false, env: {} })
  });
  noEnv.start("claude-code");
  assert.match((await until(states, (state) => state.status === "failed")).message ?? "", /environment/);

  assert.throws(() => missing.signIns.start("gemini-cli"), /no sign-in/);
  assert.throws(() => missing.signIns.start("../../bin/sh"), /no sign-in/);
});

test("list() gives a reopened window the current sign-ins", async (t) => {
  const cli = await fakeCli(t, `setInterval(() => {}, 1000);`);
  const { signIns, states } = service(cli.path);
  const { requestId } = signIns.start("codex-cli");
  await until(states, (state) => state.status === "waiting");
  assert.deepEqual(signIns.list().map((state) => [state.kind, state.requestId, state.status]), [["codex-cli", requestId, "waiting"]]);
  signIns.shutdown();
  await until(states, (state) => state.status === "cancelled");
});

test("only a whole sign-in URL on the provider's hosts is shown", () => {
  assert.equal(findSignInPage("claude-code", `visit: ${CLAUDE_PAGE.slice(0, 60)}`), undefined, "a URL still arriving is not used");
  assert.equal(findSignInPage("claude-code", `visit: ${CLAUDE_PAGE}\n`)?.givesCode, true);
  assert.equal(findSignInPage("claude-code", "visit: https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5%2Fcallback&state=s\n")?.givesCode, false);
  assert.equal(findSignInPage("claude-code", "visit: https://evil.example/oauth/authorize?state=s\n"), undefined);
  assert.equal(findSignInPage("claude-code", `visit: ${CODEX_PAGE}\n`), undefined, "another provider's host is not this one's page");
  assert.equal(findSignInPage("codex-cli", "Starting local login server on http://localhost:1455.\n"), undefined);
  assert.equal(findSignInPage("codex-cli", `\u001b[32m${CODEX_PAGE}\u001b[0m\n`)?.url.href, CODEX_PAGE);
  for (const page of [
    "https://user@claude.ai/oauth/authorize?state=s",
    "https://claude.ai:8443/oauth/authorize?state=s",
    "https://claude.ai/login?state=s",
    "https://claude.ai.evil.example/oauth/authorize?state=s"
  ]) {
    assert.equal(findSignInPage("claude-code", `visit: ${page}\n`), undefined, page);
  }
});

test("the failure line skips URLs, prompts and progress", () => {
  assert.equal(
    lastMeaningfulLine(`Opening browser to sign in…\nIf the browser didn't open, visit: ${CLAUDE_PAGE}\nPaste code here if prompted > Login failed: boom\n`),
    "Login failed: boom"
  );
  assert.equal(lastMeaningfulLine("If your browser did not open, navigate to this URL to authenticate:\n"), undefined);
  assert.equal(
    lastMeaningfulLine(`Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${CODEX_PAGE}\n\nOn a remote or headless machine? Use \`codex login --device-auth\` instead.\nError logging in: Token exchange failed: error sending request for url (https://auth.openai.com/oauth/token)\n`),
    "Error logging in: Token exchange failed: error sending request for url (https://auth.openai.com/oauth/token)",
    "an error that names a URL is the reason, not the banner before it"
  );
  assert.equal(lastMeaningfulLine(`On a remote or headless machine? Use \`codex login --device-auth\` instead.\n`), undefined);
});

async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (isAlive(pid)) {
    assert.ok(Date.now() < deadline, `process ${pid} is gone`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
