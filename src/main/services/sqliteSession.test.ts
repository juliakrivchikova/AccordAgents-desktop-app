import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { SqliteSession } from "./sqliteSession";

test("a large history response and the next queued query keep separate exact results", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sqlite-large-history-"));
  const db = new SqliteSession("sqlite3", path.join(dir, "state.db"), 1000);
  try {
    const size = 16 * 1024 * 1024;
    const [large, next] = await Promise.all([
      db.run(`select hex(zeroblob(${size / 2})) as history;`, "json", 15000),
      db.run("select 'next query' as result;", "json", 15000)
    ]);
    assert.equal(JSON.parse(large)[0].history, "0".repeat(size));
    assert.deepEqual(JSON.parse(next), [{ result: "next query" }]);
    assert.equal(await db.run("select 'line 1' || char(10) || 'line 2';", "list", 5000), "line 1\nline 2\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reused SQLite process keeps independent transactions, temporary tables and UTF-8 output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sqlite-session-"));
  const db = new SqliteSession("sqlite3", path.join(dir, "quoted \"name' Ж.db"), 1000);
  try {
    await db.run("create table entries(id integer primary key, value text); insert into entries values(1,'kept'); create temp table guard(n); pragma synchronous=full;", "list", 5000);
    const firstPid = (db as any).child.pid;
    const rows = await db.run("create temp table guard(n); select count(*) as n from entries;", "json", 5000);
    assert.deepEqual(JSON.parse(rows), [{ n: 1 }]);
    assert.equal((db as any).child.pid, firstPid, "query reuse does not spawn a new process");
    assert.equal((await db.run("pragma synchronous;", "list", 5000)).trim(), "1", "PRAGMA state starts fresh");
    await db.run("begin; insert into entries values(2,'must roll back without commit');", "list", 5000);
    assert.equal((await db.run("select count(*) from entries;", "list", 5000)).trim(), "1");
    const failures = await Promise.allSettled([
      db.run("begin; insert into entries values(2,'rollback'); insert into entries values(1,'duplicate'); commit;", "list", 5000),
      db.run("select count(*) as n from entries;", "json", 5000)
    ]);
    assert.equal(failures[0].status, "rejected");
    assert.equal(failures[1].status, "fulfilled");
    assert.deepEqual(JSON.parse((failures[1] as PromiseFulfilledResult<string>).value), [{ n: 1 }]);
    const dense = "🙂Ж'\"\\\n".repeat(150_000);
    const result = await db.run(`select '${dense.replaceAll("'", "''")}' as value;`, "json", 10000);
    assert.equal(JSON.parse(result)[0].value, dense, "multibyte text survives stdout chunk boundaries");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("timeout rolls back the open transaction and never retries it; a later query gets a fresh process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sqlite-timeout-"));
  const db = new SqliteSession("sqlite3", path.join(dir, "state.db"), 1000);
  try {
    await db.run("create table entries(id integer);", "list", 5000);
    await assert.rejects(db.run(`begin; insert into entries values(1);
      with recursive counter(n) as (select 1 union all select n+1 from counter where n<1000000000)
      select sum(n) from counter; commit;`, "list", 30), /timed out/);
    assert.equal((await db.run("select count(*) from entries;", "list", 5000)).trim(), "0");
    const child = (db as any).child;
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    assert.equal((await db.run("select 42;", "list", 5000)).trim(), "42", "idle process loss is recoverable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing SQLite executable fails promptly instead of leaving an unresolved query", async () => {
  const db = new SqliteSession(path.join(tmpdir(), "no-such-accord-sqlite-runtime"), ":memory:", 1000);
  await assert.rejects(db.run("select 1;", "json", 5000), /ENOENT/);
});
