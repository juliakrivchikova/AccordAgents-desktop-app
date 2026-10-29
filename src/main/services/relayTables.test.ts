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
      await storage.hub().devices();
      const now = await tables(dbPath);
      assert.deepEqual(now.filter((name) => /relay|mailbox/.test(name)), [], `start ${start + 1}: ${now.join(", ")}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the old order's tables go once, a batch at a time, and only the server keeps its bodies", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-legacy-tables-"));
  try {
    for (const keepBodies of [false, true]) {
      const dbPath = path.join(dir, `accordagents-${keepBodies ? "server" : "device"}.sqlite3`);
      // A database as a device (or the server) left it before the server
      // owned the chats: the signed events, what was built on them, its place
      // in the old order, and bodies.
      await run("sqlite3", [dbPath, `
        create table chat_events (event_id text primary key, conversation_id text, log_scope_id text, origin_id text, origin_seq integer,
          logical_ts text, kind text, payload_json text, payload_hash text, event_hash text, prev_hash text, signature text, key_id text,
          envelope_json text, received_at text, unique(origin_id, log_scope_id, origin_seq));
        create index idx_chat_events_received_at on chat_events(received_at);
        create table device_event_outbox (event_id text not null references chat_events(event_id), device_id text, channel_id text, primary key(event_id, device_id));
        create table chat_event_projections (conversation_id text, projection_key text, primary key(conversation_id, projection_key));
        create table phone_turn_claims (run_id text primary key);
        create table native_commands (command_id text primary key, event_id text not null references chat_events(event_id));
        create table hub_log (hub_seq integer primary key autoincrement, event_id text not null unique references chat_events(event_id));
        create table hub_client_held_events (hub_seq integer primary key, event_id text not null);
        create table hub_client_state (key text primary key, value text not null);
        create table schema_meta (key text primary key, value text not null);
        create table device_event_blobs (blob_hash text primary key, byte_length integer not null, fragments integer not null, verified integer not null default 0);
        create table device_event_blob_fragments (blob_hash text not null, fragment_index integer not null, fragment_hash text not null, bytes blob not null, primary key(blob_hash, fragment_index));
        create table device_event_blob_pins (blob_hash text not null, reason text not null, expires_at integer, primary key(blob_hash, reason));
        create table native_approval_effects (conversation_id text not null, approval_id text not null, participant_id text not null,
          event_id text not null unique references chat_events(event_id), runtime_id text not null, pid integer not null, started_at text not null,
          primary key(conversation_id, approval_id));
        with recursive n(i) as (select 1 union all select i + 1 from n where i < 250)
          insert into chat_events select 'e' || i, 'chat', 'scope', 'device-a', i, 't', 'kind', '{}', 'h', 'h', null, 's', 'k', '{}', 'now' from n;
        insert into device_event_outbox values ('e1', 'machine', 'room');
        insert into hub_log(event_id) values ('e1');
        insert into hub_client_state values ('pulled-hub-seq', '12'), ('ops-cursor', '40');
        insert into schema_meta values ('chat-event-clock-v1', 'x'), ('chat-event-device-identity-v1', '{}');
        insert into device_event_blobs values ('sha256:aa', 1, 1, 1);
        insert into native_approval_effects values ('chat', 'approval-1', 'member', 'card-answer-1', 'runtime', 1, 'now');
      `]);
      const storage = new StorageService({ dbPath, sqliteExecutable: "sqlite3" });
      const logged: string[] = [];
      const result = await storage.dropLegacyEventTables({ keepBodies, batchRows: 100, pauseMs: 0, log: (event) => logged.push(event) });
      assert.equal(result.done, true);
      // 250 events, their outbox row and order place, and (on a device) its one body.
      assert.equal(result.rows, keepBodies ? 252 : 253, `every row went, in batches: ${result.rows}`);
      const now = await tables(dbPath);
      for (const gone of ["chat_events", "device_event_outbox", "chat_event_projections", "phone_turn_claims", "native_commands", "hub_log", "hub_client_held_events"]) {
        assert.equal(now.includes(gone), false, `${gone} is dropped (${keepBodies ? "server" : "device"})`);
      }
      assert.equal(now.includes("device_event_blobs"), keepBodies, keepBodies ? "the server keeps its bodies" : "a device keeps no bodies");
      assert.equal(now.includes("native_approval_effects"), true, "the answer ledger stays");
      const state = (await run("sqlite3", [dbPath, "select key from hub_client_state order by key; select key from schema_meta order by key;"], { encoding: "utf8" })).stdout;
      assert.match(state, /ops-cursor/, "the server link's own place stays");
      assert.doesNotMatch(state, /pulled-hub-seq|chat-event-clock-v1/, "the old order's places go");
      assert.match(state, /chat-event-device-identity-v1/, "the device's identity stays");
      assert.deepEqual(logged, ["storage.legacy-tables.dropped"]);
      // Once: a second pass finds nothing and says nothing.
      const again = await storage.dropLegacyEventTables({ keepBodies, log: (event) => logged.push(event) });
      assert.deepEqual(again.tables, []);
      assert.deepEqual(logged, ["storage.legacy-tables.dropped"]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stop in the middle of the drop leaves the rest for the next pass", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-legacy-stop-"));
  try {
    const dbPath = path.join(dir, "accordagents.sqlite3");
    await run("sqlite3", [dbPath, `
      create table chat_events (event_id text primary key, payload_json text);
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 50) insert into chat_events select 'e' || i, '{}' from n;
    `]);
    const storage = new StorageService({ dbPath, sqliteExecutable: "sqlite3" });
    const stop = new AbortController();
    stop.abort();
    const first = await storage.dropLegacyEventTables({ keepBodies: false, signal: stop.signal, batchRows: 10, pauseMs: 0 });
    assert.equal(first.done, false);
    assert.equal((await tables(dbPath)).includes("chat_events"), true, "nothing dropped after the stop");
    const second = await storage.dropLegacyEventTables({ keepBodies: false, batchRows: 10, pauseMs: 0 });
    assert.equal(second.done, true);
    assert.deepEqual(second.tables, ["chat_events"]);
    assert.equal((await tables(dbPath)).includes("chat_events"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
