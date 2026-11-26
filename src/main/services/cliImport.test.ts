import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { CliImportListResult } from "../../shared/types";
import { withCodexAppServerOneOff } from "./cliAgents/codex/appServerOneOff";
import { CliImportService } from "./cliImport";
import { commandEnvironment, ensureLoginShellEnvPrimed, resolveCommandPath } from "./command";
import { claudeForkCut, readClaudeTranscriptRows } from "./forkCut";
import { claudeProjectFolderName, claudeProjectsDir, findClaudeTranscript } from "./memberSessionFiles";

// Real threads, made here by the installed CLIs (two turns each) in a
// throwaway folder, read the way the import reads the User's own; each is
// removed afterwards. A CLI that is not installed skips its tests.

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 180_000;

interface Made {
  executable: string;
  folder: string;
  sessionId: string;
}

type Cli = "claude" | "codex" | "agy";
/** Each CLI's thread, or why it could not be made (none: not installed). */
const made: Partial<Record<Cli, Made | Error>> = {};
let service: CliImportService;
let interactive: CliImportListResult;
let everything: CliImportListResult;

async function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = commandEnvironment()): Promise<string> {
  const running = execFileAsync(executable, args, { cwd, env, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  // `codex exec` waits for more of the prompt on an open stdin.
  running.child.stdin?.end();
  return (await running).stdout;
}

async function installed(name: string): Promise<string | undefined> {
  return resolveCommandPath(name, commandEnvironment()).catch(() => undefined);
}

/** Where the CLIs run, removed with all in it afterwards. */
let scratch: string;

async function throwawayFolder(name: string): Promise<string> {
  const folder = path.join(scratch, name);
  await mkdir(folder);
  return folder;
}

async function makeClaudeSession(executable: string): Promise<Made> {
  const folder = await throwawayFolder("claude");
  // `claude -p` as the SDK runs it: its sessions are the automated ones.
  const env = commandEnvironment();
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const first = JSON.parse(await run(executable, ["-p", "--model", "haiku", "--output-format", "json", "Reply with: ok"], folder, env)) as { session_id: string };
  await run(executable, ["-p", "--model", "haiku", "--resume", first.session_id, "--output-format", "json", "Reply with: two"], folder, env);
  await run(executable, ["-p", "--resume", first.session_id, "--output-format", "json", "/rename Import probe"], folder, env);
  return { executable, folder, sessionId: first.session_id };
}

async function makeCodexThread(executable: string): Promise<Made> {
  const folder = await throwawayFolder("codex");
  const options = ["exec", "--skip-git-repo-check", "--json", "-c", "model_reasoning_effort=low"];
  const events = (await run(executable, [...options, "Reply with: ok"], folder)).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; thread_id?: string });
  const sessionId = events.find((event) => event.type === "thread.started")?.thread_id;
  assert.ok(sessionId, "codex exec names its thread");
  await run(executable, [...options, "resume", sessionId, "Reply with: two"], folder);
  return { executable, folder, sessionId };
}

async function makeAgyConversation(executable: string): Promise<Made> {
  const folder = await throwawayFolder("agy");
  const first = JSON.parse(await run(executable, ["--output-format", "json", "--effort", "low", "--print=Reply with: ok"], folder)) as { conversation_id: string };
  await run(executable, ["--output-format", "json", "--effort", "low", "--conversation", first.conversation_id, "--print=Reply with: two"], folder);
  return { executable, folder, sessionId: first.conversation_id };
}

/** Codex's own turn ids for a thread, oldest first. */
async function codexTurnIds(executable: string, threadId: string): Promise<string[]> {
  return withCodexAppServerOneOff({ executable, env: commandEnvironment(), purpose: "test", timeoutMs: 60_000 }, async ({ request }) => {
    const page = await request("thread/turns/list", { threadId, sortDirection: "asc", itemsView: "notLoaded", limit: 100 }) as { data: Array<{ id: string }> };
    return page.data.map((turn) => turn.id);
  });
}

before(async () => {
  // Real paths: each CLI records the folder it runs in as the system gives it.
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "aa-cli-import-")));
  await ensureLoginShellEnvPrimed();
  const [claude, codex, agy] = await Promise.all([installed("claude"), installed("codex"), installed("agy")]);
  const attempt = (executable: string | undefined, make: (executable: string) => Promise<Made>) =>
    executable ? make(executable).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))) : undefined;
  [made.claude, made.codex, made.agy] = await Promise.all([attempt(claude, makeClaudeSession), attempt(codex, makeCodexThread), attempt(agy, makeAgyConversation)]);
  service = new CliImportService({ codexExecutable: async () => codex ?? "codex", sqliteExecutable: "sqlite3" });
  interactive = await service.list({});
  everything = await service.list({ includeAutomated: true });
});

after(async () => {
  const claude = made.claude instanceof Error ? undefined : made.claude;
  if (claude) {
    const transcript = await findClaudeTranscript(claudeProjectsDir(commandEnvironment()), claude.sessionId);
    // Only the project folder of the throwaway folder.
    if (transcript && path.basename(path.dirname(transcript)) === claudeProjectFolderName(claude.folder)) {
      await rm(path.dirname(transcript), { recursive: true, force: true });
    }
  }
  const codex = made.codex instanceof Error ? undefined : made.codex;
  if (codex) {
    await withCodexAppServerOneOff({ executable: codex.executable, env: commandEnvironment(), purpose: "test cleanup", timeoutMs: 60_000 }, ({ request }) => request("thread/delete", { threadId: codex.sessionId }));
  }
  const agy = made.agy instanceof Error ? undefined : made.agy;
  if (agy) {
    const agyFolder = path.join(homedir(), ".gemini", "antigravity-cli");
    await rm(path.join(agyFolder, "conversations", `${agy.sessionId}.db`), { force: true });
    await rm(path.join(agyFolder, "brain", agy.sessionId), { recursive: true, force: true });
  }
  await rm(scratch, { recursive: true, force: true });
});

const listed = (result: CliImportListResult, sessionId: string) => result.threads.find((thread) => thread.sessionId === sessionId);

/** The CLI's thread for a test; undefined (the test skips) when the CLI is
 *  not installed. One it could not make fails the test. */
function madeBy(cli: Cli, context: TestContext): Made | undefined {
  const session = made[cli];
  if (session instanceof Error) throw session;
  if (!session) context.skip(`${cli} is not installed`);
  return session;
}


test("Claude Code: an SDK session is listed only with automated runs, by the title /rename gave it, in the folder it ran in", (t) => {
  const claude = madeBy("claude", t);
  if (!claude) return;
  assert.equal(listed(interactive, claude.sessionId), undefined, "claude -p is not one she ran");
  const thread = listed(everything, claude.sessionId);
  assert.ok(thread, "listed with automated runs");
  assert.deepEqual(
    { kind: thread.kind, folder: thread.folder, folderExists: thread.folderExists, title: thread.title, automated: thread.automated },
    { kind: "claude-code", folder: claude.folder, folderExists: true, title: "Import probe", automated: true }
  );
});

test("Claude Code: the history is her prompts and its replies in order, her command as typed, each turn's last reply at a uuid Fork can cut at", async (t) => {
  const claude = madeBy("claude", t);
  if (!claude) return;
  const history = await service.readHistory({ kind: "claude-code", sessionId: claude.sessionId });
  assert.deepEqual({ folder: history.folder, title: history.title }, { folder: claude.folder, title: "Import probe" });
  assert.match(history.model ?? "", /haiku/);
  assert.deepEqual(history.entries.map((entry) => [entry.role, entry.role === "user" ? entry.text : "reply"]), [
    ["user", "Reply with: ok"], ["assistant", "reply"], ["user", "Reply with: two"], ["assistant", "reply"], ["user", "/rename Import probe"]
  ]);
  const replies = history.entries.filter((entry) => entry.role === "assistant");
  assert.ok(replies.every((reply) => reply.text && reply.cut), "both replies ended a turn");
  const transcript = await findClaudeTranscript(claudeProjectsDir(commandEnvironment()), claude.sessionId);
  const rows = await readClaudeTranscriptRows(transcript!);
  for (const reply of replies) assert.deepEqual(claudeForkCut(rows, { at: reply.cut }), { kind: "cut", at: reply.cut });
});

test("Codex: an exec thread is listed only with automated runs, by its preview, in the folder it ran in", (t) => {
  const codex = madeBy("codex", t);
  if (!codex) return;
  assert.equal(listed(interactive, codex.sessionId), undefined, "codex exec is not one she ran");
  const thread = listed(everything, codex.sessionId);
  assert.ok(thread, "listed with automated runs");
  assert.deepEqual(
    { kind: thread.kind, folder: thread.folder, folderExists: thread.folderExists, title: thread.title, automated: thread.automated },
    { kind: "codex-cli", folder: codex.folder, folderExists: true, title: "Reply with: ok", automated: true }
  );
});

test("Codex: the history pairs each prompt with its reply, and each reply carries its turn's id", async (t) => {
  const codex = madeBy("codex", t);
  if (!codex) return;
  const history = await service.readHistory({ kind: "codex-cli", sessionId: codex.sessionId });
  assert.deepEqual({ folder: history.folder, title: history.title, reasoningEffort: history.reasoningEffort }, { folder: codex.folder, title: "Reply with: ok", reasoningEffort: "low" });
  assert.deepEqual(history.entries.map((entry) => [entry.role, entry.role === "user" ? entry.text : "reply"]), [
    ["user", "Reply with: ok"], ["assistant", "reply"], ["user", "Reply with: two"], ["assistant", "reply"]
  ]);
  const cuts = history.entries.filter((entry) => entry.role === "assistant").map((entry) => entry.cut);
  assert.deepEqual(cuts, await codexTurnIds(codex.executable, codex.sessionId));
});

test("Antigravity: a conversation is listed by its preview where it ran; its history is her requests without agy's wrapper", async (t) => {
  const agy = madeBy("agy", t);
  if (!agy) return;
  const thread = listed(interactive, agy.sessionId);
  assert.ok(thread, "agy says nothing that marks a run as automated");
  assert.deepEqual(
    { kind: thread.kind, folder: thread.folder, folderExists: thread.folderExists, title: thread.title, automated: thread.automated },
    { kind: "gemini-cli", folder: agy.folder, folderExists: true, title: "Reply with: ok", automated: false }
  );
  const history = await service.readHistory({ kind: "gemini-cli", sessionId: agy.sessionId });
  assert.ok(history.model, "the model of its responses");
  assert.deepEqual(history.entries.map((entry) => [entry.role, entry.role === "user" ? entry.text : "reply", entry.cut]), [
    ["user", "Reply with: ok", undefined], ["assistant", "reply", undefined], ["user", "Reply with: two", undefined], ["assistant", "reply", undefined]
  ]);
});

test("CLIs whose store is not here are said and the others listed; agy's list is read after agy removed its WAL", async () => {
  // agy keeps its summaries in WAL mode and removes the WAL when it closes
  // them; `sqlite3 -readonly` cannot open the file then. Claude Code and
  // Codex have nothing here.
  const home = await mkdtemp(path.join(tmpdir(), "aa-cli-import-agy-home-"));
  const agyFolder = path.join(home, ".gemini", "antigravity-cli");
  const database = path.join(agyFolder, "conversation_summaries.db");
  const id = "0b7c5a52-5b0e-4f69-9a7e-0c4c2b1d7e10";
  try {
    await mkdir(path.join(agyFolder, "conversations"), { recursive: true });
    await writeFile(path.join(agyFolder, "conversations", `${id}.db`), "");
    await execFileAsync("sqlite3", [database, [
      "pragma journal_mode=wal;",
      "create table conversation_summaries (conversation_id text, title text, preview text, last_modified_time datetime, workspace_uris text);",
      `insert into conversation_summaries values ('${id}', '', 'Reply with: ok', '2026-11-26 16:05:21.5+00:00', '["file:///tmp"]');`,
      "pragma wal_checkpoint(truncate);"
    ].join(" ")]);
    await rm(`${database}-wal`, { force: true });
    await rm(`${database}-shm`, { force: true });
    const agyOnly = new CliImportService({
      codexExecutable: async () => { throw new Error("not here"); },
      sqliteExecutable: "sqlite3",
      env: () => ({ ...commandEnvironment(), CLAUDE_CONFIG_DIR: home }),
      homeDir: home
    });
    const { threads, unavailable } = await agyOnly.list({});
    assert.deepEqual(threads.map((thread) => [thread.kind, thread.sessionId, thread.title, thread.folder, thread.updatedAt]), [
      ["gemini-cli", id, "Reply with: ok", "/tmp", "2026-11-26T16:05:21.500Z"]
    ]);
    assert.deepEqual(unavailable.map((entry) => [entry.kind, Boolean(entry.reason)]), [["claude-code", true], ["codex-cli", true]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
