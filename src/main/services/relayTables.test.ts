import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { StorageService } from "./storage";

const run = promisify(execFile);
const tables = async (dbPath: string): Promise<string[]> =>
  (await run("sqlite3", [dbPath, "select name from sqlite_master where type = 'table' order by name;"], { encoding: "utf8" })).stdout.split(/\r?\n/).filter(Boolean);

test("the relay's tables from before are dropped at start, and a second start is fine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-relay-tables-"));
  const dbPath = path.join(dir, "accordagents.sqlite3");
  try {
    // A database as an older desktop or server left it.
    await run("sqlite3", [dbPath, `
      create table hub_relay_mailboxes (mailbox_id text primary key);
      create table hub_relay_events (mailbox_id text, arrival_seq integer);
      create index hub_relay_events_arrival on hub_relay_events(mailbox_id, arrival_seq);
      create table hub_relay_claims (claim_id text primary key);
      create table device_event_mailbox_cursors (channel_id text, reader_id text, epoch text, arrival_seq integer, primary key(channel_id, reader_id));
      insert into hub_relay_events values ('mb', 1);
    `]);
    for (let start = 0; start < 2; start += 1) {
      const storage = new StorageService({ dbPath, sqliteExecutable: "sqlite3" });
      await storage.init();
      await storage.hub().head();
      const now = await tables(dbPath);
      assert.deepEqual(now.filter((name) => /relay|mailbox/.test(name)), [], `start ${start + 1}: ${now.join(", ")}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
