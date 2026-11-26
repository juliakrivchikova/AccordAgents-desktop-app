import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeThreads } from "./cliImport/claudeThreads";
import type { CliThreadFound } from "./cliImport/types";

// Claude Code's sessions are listed as the Claude app's sidebar lists them,
// from the app's record of each (decided 2026-11-26); the transcript says
// where the session runs.

const REPO = "/work/repo";
const WORKTREE = "/work/repo/.claude/worktrees/side";

interface Row {
  name: string;
  record: Record<string, unknown>;
  /** The folder its transcript records; no transcript without one. */
  cwd?: string;
  /** A copy of the transcript in another project folder, older (a hard
   *  link the app left when it moved the session). */
  olderCopyCwd?: string;
  /** What the list says of it; left out when undefined. */
  listed?: Omit<CliThreadFound, "kind" | "sessionId">;
}

const sessionId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const localId = (n: number) => `local_10000000-0000-4000-8000-00000000000${n}`;
const at = (hour: number) => Date.parse(`2026-11-26T${String(hour).padStart(2, "0")}:00:00.000Z`);
const record = (n: number, fields: Record<string, unknown>) => ({
  sessionId: localId(n), cliSessionId: sessionId(n), cwd: REPO, originCwd: REPO, isArchived: false, createdAt: at(1), lastActivityAt: at(n + 1), ...fields
});

const rows: Row[] = [
  { name: "a session: the app's title, the folder its transcript records, its last activity", record: record(1, { title: "Build fix" }), cwd: REPO, listed: { folder: REPO, title: "Build fix", updatedAt: "2026-11-26T02:00:00.000Z" } },
  { name: "an archived session is left out", record: record(2, { title: "Old work", isArchived: true }), cwd: REPO },
  {
    name: "a session in a worktree: listed under the repository the app files it under, from its newest transcript",
    record: record(3, { title: "Side work", cwd: WORKTREE }),
    cwd: WORKTREE,
    olderCopyCwd: "/work/old-place",
    listed: { folder: WORKTREE, project: REPO, title: "Side work", updatedAt: "2026-11-26T04:00:00.000Z" }
  },
  {
    name: "a side session: under the session it was started from",
    record: record(4, { title: "Check the tests", spawnedFrom: { sessionId: localId(1), taskId: "task_1", title: "Check the tests" } }),
    cwd: REPO,
    listed: { folder: REPO, title: "Check the tests", updatedAt: "2026-11-26T05:00:00.000Z", parentSessionId: sessionId(1) }
  },
  {
    name: "a side session of an archived one: no parent",
    record: record(5, { title: "Follow-up", spawnedFrom: { sessionId: localId(2), taskId: "task_2", title: "Follow-up" } }),
    cwd: REPO,
    listed: { folder: REPO, title: "Follow-up", updatedAt: "2026-11-26T06:00:00.000Z" }
  },
  { name: "a session whose transcript is gone is left out", record: record(6, { title: "Lost" }) }
];

/** A transcript's head as Claude Code 2.1.329 writes it in the Claude app. */
function transcript(id: string, cwd: string): string {
  return [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-11-26T01:00:00.000Z", sessionId: id },
    { parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "Fix the build" }, uuid: randomUUID(), timestamp: "2026-11-26T01:00:00.020Z", userType: "external", entrypoint: "claude-desktop", cwd, sessionId: id, version: "2.1.329", gitBranch: "beta" }
  ].map((line) => `${JSON.stringify(line)}\n`).join("");
}

async function writeTranscript(configDir: string, id: string, cwd: string): Promise<string> {
  const folder = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  await writeFile(file, transcript(id, cwd));
  return file;
}

test("Claude Code: the sessions the Claude app lists, mapped from its records", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aa-claude-app-list-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const configDir = path.join(scratch, "claude");
  const appDataDir = path.join(scratch, "app-data");
  const records = path.join(appDataDir, "Claude", "claude-code-sessions", randomUUID(), randomUUID());
  await mkdir(records, { recursive: true });
  await writeFile(path.join(records, "account-plugins-sent.json"), "{}");
  for (const row of rows) {
    await writeFile(path.join(records, `${String(row.record.sessionId)}.json`), JSON.stringify(row.record));
    const id = String(row.record.cliSessionId);
    if (row.cwd) await writeTranscript(configDir, id, row.cwd);
    if (row.olderCopyCwd) {
      const older = await writeTranscript(configDir, id, row.olderCopyCwd);
      await utimes(older, new Date(at(0)), new Date(at(0)));
    }
  }
  const threads = await new ClaudeThreads(() => ({ CLAUDE_CONFIG_DIR: configDir }), appDataDir).list();
  const byId = new Map(threads.map((thread) => [thread.sessionId, thread]));
  for (const row of rows) {
    const expected = row.listed ? { kind: "claude-code", sessionId: row.record.cliSessionId, ...row.listed } : undefined;
    assert.deepEqual(byId.get(String(row.record.cliSessionId)), expected, row.name);
  }
  assert.equal(threads.length, rows.filter((row) => row.listed).length);
});

test("Claude Code: a session the app moved is listed and imported in the app's folder, by the app's title", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aa-claude-app-moved-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const configDir = path.join(scratch, "claude");
  const appDataDir = path.join(scratch, "app-data");
  const records = path.join(appDataDir, "Claude", "claude-code-sessions", randomUUID(), randomUUID());
  await mkdir(records, { recursive: true });
  const moved = "/work/new-place";
  await writeFile(path.join(records, `${localId(7)}.json`), JSON.stringify(record(7, { title: "Moved work", cwd: moved, originCwd: moved })));
  // The app links the transcript into the new folder's project; its lines
  // still name the folder it started in.
  const folder = path.join(configDir, "projects", moved.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${sessionId(7)}.jsonl`), transcript(sessionId(7), "/work/old-place"));
  const reader = new ClaudeThreads(() => ({ CLAUDE_CONFIG_DIR: configDir }), appDataDir);
  const [listed] = await reader.list();
  assert.deepEqual({ folder: listed?.folder, title: listed?.title }, { folder: moved, title: "Moved work" });
  const history = await reader.readHistory(sessionId(7));
  assert.deepEqual({ folder: history.folder, title: history.title }, { folder: moved, title: "Moved work" }, "the chat goes on where the app runs it");
});
