import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AgyThreads } from "./cliImport/agyThreads";
import type { CliThreadFound } from "./cliImport/types";

// agy's conversations are listed as the Antigravity app lists them (decided
// 2026-11-26): the app's summaries say which, agy's own say where and when.
// Both databases are real SQLite files, left as agy 1.5.18 and the app leave
// them when they close (WAL mode, no WAL file).

const execFileAsync = promisify(execFile);
const COLUMNS = "conversation_id text, title text not null default '', preview text not null default '', last_modified_time datetime not null, workspace_uris text not null, source text not null default ''";

interface Row {
  name: string;
  /** agy's row and whether its conversation file is there. */
  agy?: { preview: string; file: boolean };
  /** The app's row (`source` as the app writes it). */
  app?: { title?: string; source: string };
  listed?: Omit<CliThreadFound, "kind" | "sessionId">;
}

const CLI_SOURCE = "CORTEX_TRAJECTORY_SOURCE_CLI";
const FOLDER = "/work/repo";

const rows: Row[] = [
  { name: "agy's, listed by the app: by its preview, where it ran", agy: { preview: "Review the diff", file: true }, app: { source: CLI_SOURCE }, listed: { folder: FOLDER, title: "Review the diff", updatedAt: "2026-11-19T17:56:27.535Z" } },
  { name: "listed by the app with a title: by the app's title", agy: { preview: "Plan it", file: true }, app: { title: "Release plan", source: CLI_SOURCE }, listed: { folder: FOLDER, title: "Release plan", updatedAt: "2026-11-19T17:56:27.535Z" } },
  { name: "agy's, the app does not list it: not listed", agy: { preview: "Reply with: ok", file: true } },
  { name: "listed by the app, agy's conversation is gone: not listed", agy: { preview: "Old one", file: false }, app: { source: CLI_SOURCE } },
  { name: "made in the app, agy cannot go on with it: not listed", app: { title: "App work", source: "" } }
];

const conversationId = (index: number) => `0b7c5a52-5b0e-4f69-9a7e-0c4c2b1d7e${String(index).padStart(2, "0")}`;
const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

async function summariesDatabase(file: string, values: string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await execFileAsync("sqlite3", [file, [
    "pragma journal_mode=wal;",
    `create table conversation_summaries (${COLUMNS});`,
    ...values.map((value) => `insert into conversation_summaries values (${value});`),
    "pragma wal_checkpoint(truncate);"
  ].join(" ")]);
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
}

const summary = (index: number, title: string, preview: string, source: string) =>
  [conversationId(index), title, preview, "2026-11-19 17:56:27.535874+00:00", `["file://${FOLDER}"]`, source].map(quoted).join(", ");

test("Antigravity: agy's conversations the Antigravity app lists, by the app's title when it has one", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "aa-agy-app-list-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agyFolder = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(path.join(agyFolder, "conversations"), { recursive: true });
  for (const [index, row] of rows.entries()) {
    if (row.agy?.file) await writeFile(path.join(agyFolder, "conversations", `${conversationId(index)}.db`), "");
  }
  await summariesDatabase(path.join(agyFolder, "conversation_summaries.db"),
    rows.flatMap((row, index) => row.agy ? [summary(index, "", row.agy.preview, "")] : []));
  const reader = new AgyThreads({ sqliteExecutable: "sqlite3", homeDir: home });
  await assert.rejects(reader.list(), { message: "The Antigravity app keeps no conversations on this computer" });

  await summariesDatabase(path.join(home, ".gemini", "antigravity", "conversation_summaries.db"),
    rows.flatMap((row, index) => row.app ? [summary(index, row.app.title ?? "", row.agy?.preview ?? "", row.app.source)] : []));
  const threads = await reader.list();
  const byId = new Map(threads.map((thread) => [thread.sessionId, thread]));
  rows.forEach((row, index) => {
    const expected = row.listed ? { kind: "gemini-cli", sessionId: conversationId(index), ...row.listed } : undefined;
    assert.deepEqual(byId.get(conversationId(index)), expected, row.name);
  });
  assert.equal(threads.length, rows.filter((row) => row.listed).length);
});
