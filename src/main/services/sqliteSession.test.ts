import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { JsonRowsReader, SqliteSession } from "./sqliteSession";

test("a large history response and the next queued query keep separate exact results", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sqlite-large-history-"));
  const db = new SqliteSession("sqlite3", path.join(dir, "state.db"), 1000);
  try {
    const size = 16 * 1024 * 1024;
    const [large, next] = await Promise.all([
      db.rows<{ history: string }>(`select hex(zeroblob(${size / 2})) as history;`, 15000),
      db.rows("select 'next query' as result;", 15000)
    ]);
    assert.equal(large[0].history, "0".repeat(size));
    assert.deepEqual(next, [{ result: "next query" }]);
    assert.equal(await db.run("select 'line 1' || char(10) || 'line 2';", 5000), "line 1\nline 2\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reused SQLite process keeps independent transactions, temporary tables and UTF-8 output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sqlite-session-"));
  const db = new SqliteSession("sqlite3", path.join(dir, "quoted \"name' Ж.db"), 1000);
  try {
    await db.run("create table entries(id integer primary key, value text); insert into entries values(1,'kept'); create temp table guard(n); pragma synchronous=full;", 5000);
    const firstPid = (db as any).child.pid;
    const rows = await db.rows("create temp table guard(n); select count(*) as n from entries;", 5000);
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.equal((db as any).child.pid, firstPid, "query reuse does not spawn a new process");
    assert.equal((await db.run("pragma synchronous;", 5000)).trim(), "1", "PRAGMA state starts fresh");
    await db.run("begin; insert into entries values(2,'must roll back without commit');", 5000);
    assert.equal((await db.run("select count(*) from entries;", 5000)).trim(), "1");
    const failures = await Promise.allSettled([
      db.run("begin; insert into entries values(2,'rollback'); insert into entries values(1,'duplicate'); commit;", 5000),
      db.rows("select count(*) as n from entries;", 5000)
    ]);
    assert.equal(failures[0].status, "rejected");
    assert.equal(failures[1].status, "fulfilled");
    assert.deepEqual((failures[1] as PromiseFulfilledResult<unknown[]>).value, [{ n: 1 }]);
    const dense = "🙂Ж'\"\\\n".repeat(150_000);
    const result = await db.rows<{ value: string }>(`select '${dense.replaceAll("'", "''")}' as value;`, 10000);
    assert.equal(result[0].value, dense, "multibyte text survives stdout chunk boundaries");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("timeout rolls back the open transaction and never retries it; a later query gets a fresh process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sqlite-timeout-"));
  const db = new SqliteSession("sqlite3", path.join(dir, "state.db"), 1000);
  try {
    await db.run("create table entries(id integer);", 5000);
    await assert.rejects(db.run(`begin; insert into entries values(1);
      with recursive counter(n) as (select 1 union all select n+1 from counter where n<1000000000)
      select sum(n) from counter; commit;`, 30), /timed out/);
    assert.equal((await db.run("select count(*) from entries;", 5000)).trim(), "0");
    const child = (db as any).child;
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    assert.equal((await db.run("select 42;", 5000)).trim(), "42", "idle process loss is recoverable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing SQLite executable fails promptly instead of leaving an unresolved query", async () => {
  const db = new SqliteSession(path.join(tmpdir(), "no-such-accord-sqlite-runtime"), ":memory:", 1000);
  await assert.rejects(db.rows("select 1;", 5000), /ENOENT/);
});

// V8's longest string is 2^29 - 24 characters (about 512 MB).
const LONGER_THAN_A_STRING = 560 * 1024 * 1024;

test("rows longer together than the longest string are all read", async () => {
  const db = new SqliteSession("sqlite3", ":memory:", 1000);
  const rowLength = 16 * 1024 * 1024;
  const count = LONGER_THAN_A_STRING / rowLength;
  const rows = await db.rows<{ n: number; payload: string }>(`with recursive counter(n) as (select 1 union all select n + 1 from counter where n < ${count})
    select n, hex(zeroblob(${rowLength / 2})) as payload from counter;`, 60_000);
  assert.deepEqual(rows.map((row) => row.n), Array.from({ length: count }, (_, index) => index + 1));
  assert.ok(rows.every((row) => row.payload.length === rowLength));
});

test("a response that cannot be read fails its own operation and leaves the next ones working", async () => {
  const db = new SqliteSession("sqlite3", ":memory:", 1000);
  const [tooLong, next] = await Promise.allSettled([
    db.run(`select hex(zeroblob(${LONGER_THAN_A_STRING / 4})) from (select 1 union all select 2);`, 60_000),
    db.rows("select 'still works' as result;", 5000)
  ]);
  assert.equal(tooLong.status, "rejected");
  assert.match(String((tooLong as PromiseRejectedResult).reason), /finished, but its response \(\d+ characters\) could not be read: Invalid string length/);
  assert.deepEqual(next, { status: "fulfilled", value: [{ result: "still works" }] });
  const pid = (db as any).child.pid;
  await assert.rejects(db.rows("select 1 as a; select 2 as b;", 5000), /could not be read: Unexpected "\[" after the result set/);
  assert.deepEqual(await db.rows("select 3 as c where 0;", 5000), []);
  assert.deepEqual(await db.rows("select 3 as c;", 5000), [{ c: 3 }]);
  assert.equal((db as any).child.pid, pid, "the process stays in step and is not replaced");
});

test("a failed operation keeps only the end of what it printed", async () => {
  const db = new SqliteSession("sqlite3", ":memory:", 1000);
  await assert.rejects(db.run("select hex(zeroblob(1000000)); select * from missing;", 5000), (error: any) => {
    assert.match(error.message, /no such table: missing/);
    assert.equal(error.result.stdout.length, 8192);
    return true;
  });
});

test("rows are read the same wherever their text is cut", () => {
  const expected = [
    { text: "", quotes: "\"\\\"", path: "C:\\dir\\", n: 1.5, none: null },
    { text: "{\"a\":[1,2]}\n]},{", quotes: "\\\\\"", path: "\\", n: -2e20, none: null },
    { text: "🙂Ж", quotes: "\"", path: "\\\"\\", n: 0, none: null }
  ];
  const text = `[${expected.map((row) => JSON.stringify(row)).join(",\r\n")}]\n`;
  for (let size = 1; size <= text.length; size += 1) {
    for (let first = 0; first < size; first += 1) {
      const reader = new JsonRowsReader();
      reader.write(text.slice(0, first));
      for (let at = first; at < text.length; at += size) reader.write(text.slice(at, at + size));
      assert.deepEqual(reader.finish(), expected, `cut every ${size} from ${first}`);
    }
  }
  const read = (value: string): unknown[] => {
    const reader = new JsonRowsReader();
    reader.write(value);
    return reader.finish();
  };
  assert.deepEqual(read(""), []);
  assert.deepEqual(read("[]\n"), []);
  for (const broken of ["[{\"a\":1}", "[{\"a\":\"x", "[{\"a\":1}] x", "Error", "[1]", "[{\"a\":{\"b\":1}}]"]) {
    assert.throws(() => read(broken), (error) => error instanceof Error, broken);
  }
});
