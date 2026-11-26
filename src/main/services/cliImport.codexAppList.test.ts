import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexThreads } from "./cliImport/codexThreads";
import type { CliThreadFound } from "./cliImport/types";

// Codex's threads are listed as the Codex app lists them (decided
// 2026-11-26): its projects from `project/list`, its sidebar from
// `.codex-global-state.json` in CODEX_HOME. Only the app-server is faked: it
// serves `thread/list` and `project/list` records shaped as Codex 0.170's.

const REPO = "/work/rename-app";
const OTHER = "/work/probe";
const PROJECTS = [
  { id: "01a05e33-1ce1-7ff3-8494-17d4f8b7df61", name: "rename-app", roots: [{ path: REPO }], metadata: {}, position: 0, createdAt: 1791046391, updatedAt: 1791046391, recencyAt: null },
  { id: "01a04efe-5486-7093-9116-209d843b1b90", name: "Probe", roots: [{ path: OTHER }], metadata: {}, position: 1, createdAt: 1791046391, updatedAt: 1791046391, recencyAt: null }
];
const LOCAL_PROJECT = "local-334c5c53d2836a9c52f44b97b4d017b4";
const LEGACY_PROJECT = "d6060be3-b835-45a3-a192-b90f97131d6a";

interface Row {
  name: string;
  thread: { cwd: string; name?: string; preview: string; originator?: string; archived?: boolean };
  /** What the app keeps of it: the project the User put it in, a chat outside every project, pinned. */
  app?: { assignedTo?: string; projectless?: true; pinned?: true };
  listed?: Omit<CliThreadFound, "kind" | "sessionId" | "updatedAt">;
}

const rows: Row[] = [
  { name: "in a project's folder: by its name", thread: { cwd: REPO, name: "Fix the build", preview: "Fix it" }, listed: { folder: REPO, title: "Fix the build" } },
  { name: "in a project's subfolder: under the project's root, by its preview", thread: { cwd: `${REPO}/packages/web`, preview: "Check the page" }, listed: { folder: `${REPO}/packages/web`, project: REPO, title: "Check the page" } },
  {
    name: "a Codex worktree she put in a project of the time before the app-server: under that project",
    thread: { cwd: "/Users/me/.codex/worktrees/d334/rename-app", preview: "Ship it" },
    app: { assignedTo: LOCAL_PROJECT },
    listed: { folder: "/Users/me/.codex/worktrees/d334/rename-app", project: REPO, title: "Ship it" }
  },
  {
    name: "put in a project by its old id: under the project that id became",
    thread: { cwd: "/Users/me/Documents/Codex/2026-08-18/g", preview: "Trace it" },
    app: { assignedTo: LEGACY_PROJECT },
    listed: { folder: "/Users/me/Documents/Codex/2026-08-18/g", project: OTHER, title: "Trace it" }
  },
  { name: "a chat outside every project: on its own", thread: { cwd: "/Users/me/Documents/Codex/2026-09-05/plan", preview: "Plan a trip" }, app: { projectless: true }, listed: { folder: "/Users/me/Documents/Codex/2026-09-05/plan", title: "Plan a trip" } },
  { name: "pinned outside every project: on its own", thread: { cwd: "/Users/me/notes", preview: "Notes" }, app: { pinned: true }, listed: { folder: "/Users/me/notes", title: "Notes" } },
  { name: "outside every project: not listed", thread: { cwd: "/Users/me/scratch", preview: "Try this" } },
  { name: "a folder that only starts like a project's: not listed", thread: { cwd: `${REPO}-old`, preview: "Old copy" } },
  { name: "AccordAgents' own thread in a project: not listed", thread: { cwd: REPO, preview: "Reply with: ok", originator: "accordagents" } },
  { name: "archived in a project: not listed", thread: { cwd: REPO, preview: "Done", archived: true } }
];

const threadId = (index: number) => `01a0e78e-37d2-7a70-a89b-b74047015c${String(index).padStart(2, "0")}`;
const UPDATED_AT = 1795000000;

/** A thread as Codex 0.170's `thread/list` returns it. */
function threadRecord(row: Row, index: number): Record<string, unknown> {
  return {
    id: threadId(index), sessionId: threadId(index), forkedFromId: null, parentThreadId: null, preview: row.thread.preview, ephemeral: false, projectId: null,
    modelProvider: "openai", model: "gpt-6.2-astra", reasoningEffort: "high", createdAt: UPDATED_AT - 60, updatedAt: UPDATED_AT, status: { type: "notLoaded" },
    path: `/Users/me/.codex/sessions/${threadId(index)}.jsonl`, cwd: row.thread.cwd, cliVersion: "0.170.0", originator: row.thread.originator ?? "Codex Desktop",
    source: "vscode", name: row.thread.name ?? null, turns: [], archived: row.thread.archived === true
  };
}

/** Codex's app-server for the records given: archived threads unless asked for the others. */
const FAKE_APP_SERVER = `#!${process.execPath}
const fixture = JSON.parse(require("node:fs").readFileSync(process.env.FAKE_CODEX_FIXTURE, "utf8"));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-codex" } });
  else if (message.method === "thread/list") {
    const data = fixture.threads.filter((thread) => message.params.archived !== false || !thread.archived).map(({ archived, ...thread }) => thread);
    send({ id: message.id, result: { data, nextCursor: null } });
  } else if (message.method === "project/list") send({ id: message.id, result: { data: fixture.projects, nextCursor: null } });
  else send({ id: message.id, error: { code: -32601, message: "unknown method " + message.method } });
});
`;

test("Codex: the threads the Codex app lists, under the project it lists each in", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aa-codex-app-list-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, "codex-home");
  await mkdir(home);
  const appState = {
    "thread-project-assignments": Object.fromEntries(rows.flatMap((row, index) => row.app?.assignedTo ? [[threadId(index), { projectKind: "local", projectId: row.app.assignedTo }]] : [])),
    "projectless-thread-ids": rows.flatMap((row, index) => row.app?.projectless ? [threadId(index)] : []),
    "pinned-thread-ids": rows.flatMap((row, index) => row.app?.pinned ? [threadId(index)] : []),
    "local-projects": { [LOCAL_PROJECT]: { id: LOCAL_PROJECT, name: "rename-app", rootPaths: [REPO], createdAt: 1784277762708, updatedAt: 1784277762708 } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { [LEGACY_PROJECT]: PROJECTS[1]!.id } }
  };
  await writeFile(path.join(home, ".codex-global-state.json"), JSON.stringify(appState));
  const fixture = path.join(scratch, "fixture.json");
  await writeFile(fixture, JSON.stringify({ threads: rows.map(threadRecord), projects: PROJECTS }));
  const codex = path.join(scratch, "codex");
  await writeFile(codex, FAKE_APP_SERVER);
  await chmod(codex, 0o755);
  const reader = (env: NodeJS.ProcessEnv) => new CodexThreads({ codexExecutable: async () => codex, env: () => ({ ...process.env, ...env, FAKE_CODEX_FIXTURE: fixture }) });

  const threads = await reader({ CODEX_HOME: home }).list();
  const byId = new Map(threads.map((thread) => [thread.sessionId, thread]));
  rows.forEach((row, index) => {
    const expected = row.listed ? { kind: "codex-cli", sessionId: threadId(index), updatedAt: new Date(UPDATED_AT * 1000).toISOString(), ...row.listed } : undefined;
    assert.deepEqual(byId.get(threadId(index)), expected, row.name);
  });
  assert.equal(threads.length, rows.filter((row) => row.listed).length);

  await assert.rejects(reader({ CODEX_HOME: path.join(scratch, "no-app") }).list(), { message: "The Codex app keeps no threads on this computer" });
});
