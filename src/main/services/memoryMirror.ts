import {
  MEMORY_IMPORT_PAGE_BYTES,
  type MemoryExportPlace,
  type MemoryExportValue,
  type MemoryImportValue,
  type MemoryNote
} from "../../shared/memory";
import type { MemoryServerAccess } from "./memoryTools";

/** Where this computer read the server's notes to, per server. */
const CURSOR_KEY = (hubId: string) => `memory-mirror-cursor:${hubId}`;
/** That this computer's copy of the notes was put on a server (once each). */
const MOVED_KEY = (hubId: string) => `memory-moved:${hubId}`;
/** Rows of the copy read at a time when moving it. */
const READ_PAGE = 200;

/** What a step of the copy came to: done, to be tried again, or refused for
 *  good on this server (a computer that is not its owner keeps no copy). */
export type MemoryMirrorOutcome = "ok" | "failed" | "denied";

interface Database {
  queryJson<T>(sql: string): Promise<T[]>;
  runSql(sql: string): Promise<void>;
}

interface ClientState {
  clientState(key: string): Promise<string | undefined>;
  setClientState(key: string, value: string): Promise<void>;
}

/**
 * The computer's copy of every note on the User's server, so notes move with
 * the chats when she moves to another server (from the one inside the app to
 * her own, or sets hers up again): the User, 2026-11-04. The copy follows the
 * server (what changed since the last read, about every minute); the first
 * time the computer links to a server, the copy is put there, each note as it
 * was, where that server has none of that id. A note the User deletes in
 * Settings is marked deleted here before the server is asked (so a lost
 * answer never brings it back), and a deletion the server reports is marked
 * too.
 */
export class MemoryMirror {
  private ready?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: () => Database,
    private readonly state: () => ClientState,
    private readonly log: (event: string, payload: Record<string, unknown>) => void = () => undefined
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.database().runSql(`
      create table if not exists member_memory_mirror (
        id text primary key,
        change_seq integer not null,
        saved_at text not null,
        note_json text not null
      );
      create table if not exists member_memory_mirror_deleted (
        id text primary key,
        deleted_at text not null
      );
    `).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /** One thing at a time: a read of the server never crosses a move. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Reads what changed on the server since the last read into the copy. */
  sync(access: MemoryServerAccess, hubId: string): Promise<MemoryMirrorOutcome> {
    return this.serialize(async () => {
      await this.init();
      const state = this.state();
      let place = parsePlace(await state.clientState(CURSOR_KEY(hubId)));
      let changed = 0;
      for (let page = 0; page < 1_000; page += 1) {
        const result = await access.memory<MemoryExportValue>({ action: "export", ...(place ? { after: place } : {}) });
        if (!result.ok) {
          this.log("memory.mirror.sync-failed", { code: result.error.code, message: result.error.message.slice(0, 200) });
          return result.error.code === "access_denied" ? "denied" : "failed";
        }
        // The server's notes were started anew under the same name: read
        // everything again (nothing here is dropped for it).
        if (place && result.value.head < place.seq) {
          this.log("memory.mirror.cursor-reset", { head: result.value.head, cursor: place.seq });
          place = undefined;
          await state.setClientState(CURSOR_KEY(hubId), "");
          continue;
        }
        const now = new Date().toISOString();
        const statements = [
          ...result.value.notes.map((note) => `insert into member_memory_mirror(id, change_seq, saved_at, note_json)
            select ${quote(note.id)}, ${Math.max(0, Math.floor(note.changeSeq))}, ${quote(now)}, ${quote(JSON.stringify(withoutSeq(note)))}
            where not exists (select 1 from member_memory_mirror_deleted where id = ${quote(note.id)})
            on conflict(id) do update set change_seq = excluded.change_seq, saved_at = excluded.saved_at, note_json = excluded.note_json;`),
          ...(result.value.deleted ?? []).map((gone) => `insert or ignore into member_memory_mirror_deleted(id, deleted_at) values (${quote(gone.id)}, ${quote(now)});
            delete from member_memory_mirror where id = ${quote(gone.id)};`)
        ];
        if (statements.length) {
          await this.database().runSql(statements.join("\n"));
          changed += statements.length;
        }
        const entries = [...result.value.notes, ...(result.value.deleted ?? [])]
          .sort((left, right) => left.changeSeq - right.changeSeq || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        const last = entries[entries.length - 1];
        if (last) {
          place = { seq: last.changeSeq, id: last.id };
          await state.setClientState(CURSOR_KEY(hubId), JSON.stringify(place));
        }
        if (!result.value.next) break;
        place = result.value.next;
      }
      if (changed) this.log("memory.mirror.synced", { changed });
      return "ok";
    });
  }

  /** Whether the copy still has to be put on this server. */
  async needsMove(hubId: string): Promise<boolean> {
    return !await this.state().clientState(MOVED_KEY(hubId));
  }

  /**
   * Puts the copy on a server this computer links to for the first time
   * (once per server). When it could not be done yet it is tried again
   * about every minute, and the copy is kept as it is meanwhile.
   */
  moveTo(access: MemoryServerAccess, hubId: string): Promise<MemoryMirrorOutcome> {
    return this.serialize(async () => {
      await this.init();
      const state = this.state();
      if (await state.clientState(MOVED_KEY(hubId))) return "ok";
      let after = "";
      let imported = 0;
      let skipped = 0;
      for (;;) {
        const rows = await this.database().queryJson<{ id: string; noteJson: string }>(`select id, note_json as noteJson from member_memory_mirror
          where id > ${quote(after)} and id not in (select id from member_memory_mirror_deleted) order by id limit ${READ_PAGE};`);
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
        for (const batch of batches(rows.flatMap((row) => parseNote(row.noteJson)))) {
          const result = await access.memory<MemoryImportValue>({ action: "import", notes: batch });
          if (!result.ok) {
            this.log("memory.mirror.move-failed", { code: result.error.code, message: result.error.message.slice(0, 200), imported });
            return result.error.code === "access_denied" ? "denied" : "failed";
          }
          imported += result.value.imported;
          skipped += result.value.skipped;
        }
      }
      await state.setClientState(MOVED_KEY(hubId), new Date().toISOString());
      this.log("memory.mirror.moved", { imported, skipped });
      return "ok";
    });
  }

  /** A note the User deletes leaves the copy and is marked deleted, before
   *  the server is asked: it never comes back on a move, even when the
   *  server's answer is lost. Not queued behind a read of the server. */
  async forget(noteId: string): Promise<void> {
    await this.init();
    await this.database().runSql(`insert or ignore into member_memory_mirror_deleted(id, deleted_at) values (${quote(noteId)}, ${quote(new Date().toISOString())});
      delete from member_memory_mirror where id = ${quote(noteId)};`);
  }

  /** How many notes the copy holds (for tests and the debug log). */
  async size(): Promise<number> {
    await this.init();
    const rows = await this.database().queryJson<{ total: number }>("select count(*) as total from member_memory_mirror;");
    return Number(rows[0]?.total ?? 0);
  }
}

function withoutSeq(note: MemoryNote & { changeSeq?: number }): MemoryNote {
  const { changeSeq: _changeSeq, ...rest } = note;
  return rest;
}

function parsePlace(value: string | undefined): MemoryExportPlace | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<MemoryExportPlace>;
    return Number.isSafeInteger(parsed.seq) && typeof parsed.id === "string" ? { seq: Number(parsed.seq), id: parsed.id } : undefined;
  } catch {
    return undefined;
  }
}

function parseNote(json: string): MemoryNote[] {
  try {
    const parsed = JSON.parse(json) as MemoryNote;
    return parsed && typeof parsed.id === "string" ? [parsed] : [];
  } catch {
    return [];
  }
}

/** Notes in pages small enough for one request to the server. */
function batches(notes: MemoryNote[]): MemoryNote[][] {
  const out: MemoryNote[][] = [];
  let current: MemoryNote[] = [];
  let bytes = 0;
  for (const note of notes) {
    const size = Buffer.byteLength(JSON.stringify(note));
    if (current.length && bytes + size > MEMORY_IMPORT_PAGE_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(note);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

function quote(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}
