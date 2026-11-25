import { createHash, randomUUID } from "node:crypto";
import type { Conversation } from "../../../../shared/types";
import { conversationBody, rowsMatchMessages } from "./conversationBody";
import { sqlString } from "../database/sqlText";
import type { SavedMessageRow } from "../types";
import type { StorageModules } from "../modules";

/** What this process last committed for a conversation: the token it stamped on
 *  the row, and the message ids and hashes in the order it wrote them. */
interface SavedMessageState {
  token: string;
  rows: Array<{ id: string; hash: string }>;
}

/** Saves and deletes conversations. */
export class ConversationSaves {
  // Only ever a cache of what this process itself wrote. It is dropped whenever
  // the database turns out to hold something else, so a wrong entry costs one
  // full rewrite rather than a lost message.
  readonly savedMessageState = new Map<string, SavedMessageState>();

  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  // A save used to delete every message row of a conversation and insert them
  // all back. On a 2400-message chat that is ~33MB of SQL text piped into a
  // spawned sqlite3 process, several times per turn, so the cost of saying
  // anything grew with the length of the chat. Only the rows that actually
  // changed are written now; the full rewrite remains as the fallback whenever
  // this process cannot prove what the database currently holds.
  /** Saves the conversation and returns the token stamped on its row. A caller
   *  that already serialized and hashed the messages for this exact snapshot
   *  passes them as `rows`; they are used only when they line up with the
   *  messages one to one, otherwise the messages are serialized here. */
  async saveConversation(conversation: Conversation, options: {
    rows?: SavedMessageRow[];
    /** Statements that must commit in the same transaction as this save, or
     *  not at all: the chat's outgoing change event. `onlyIfSql` receives the
     *  condition the incremental write is gated on. */
    alsoCommit?: { sql: string; onlyIfSql(condition: string): string };
  } = {}): Promise<string> {
    await this.storage.schema.init();
    const rows: SavedMessageRow[] = rowsMatchMessages(options.rows, conversation.messages)
      ? options.rows
      : conversation.messages.map((message, index) => {
        const json = JSON.stringify(message);
        return {
          index,
          id: message.id,
          createdAt: message.createdAt,
          json,
          hash: createHash("sha1").update(json).digest("hex")
        };
      });
    const previous = this.savedMessageState.get(conversation.id);
    const nextToken = randomUUID();
    // Another app instance can share this database. The token makes a partial
    // save atomic against that: every message statement is gated on this
    // process still owning the row it last wrote, so a foreign write in between
    // turns the whole batch into a no-op instead of splicing our rows into
    // theirs and producing a state neither instance ever held.
    let claimed = false;
    if (previous) {
      try {
        claimed = await this.writeConversationIncrementally(conversation, rows, previous, nextToken, options.alsoCommit);
      } catch (error) {
        // A failed partial write leaves this process unable to say what the row
        // holds, so the cache is worthless and the next save must rewrite
        // everything.
        this.savedMessageState.delete(conversation.id);
        throw error;
      }
    }
    if (claimed) {
      this.savedMessageState.set(conversation.id, {
        token: nextToken,
        rows: rows.map((row) => ({ id: row.id, hash: row.hash }))
      });
      return nextToken;
    }
    this.savedMessageState.delete(conversation.id);
    await this.writeConversationInFull(conversation, rows, nextToken, options.alsoCommit?.sql);
    this.savedMessageState.set(conversation.id, {
      token: nextToken,
      rows: rows.map((row) => ({ id: row.id, hash: row.hash }))
    });
    return nextToken;
  }

  /** True while the conversation row still carries `token`, the value a
   *  particular `saveConversation` call returned. Every save — from any
   *  instance or any caller in this process — stamps a new token, so a match
   *  proves nothing has written the conversation since that save and storage
   *  holds exactly the snapshot it persisted. */
  async isConversationSaveOwned(conversationId: string, token: string): Promise<boolean> {
    if (!token) {
      return false;
    }
    await this.storage.schema.init();
    const observed = await this.storage.sqlite.queryText(
      `select save_token from conversations where id = ${sqlString(conversationId)} limit 1;`
    );
    return observed === token;
  }

  private async writeConversationInFull(
    conversation: Conversation,
    rows: SavedMessageRow[],
    token: string,
    alsoCommitSql = ""
  ): Promise<void> {
    const bodyPayload = JSON.stringify(conversationBody(conversation));
    // `payload_json` used to hold a second, complete copy of the conversation —
    // every message again, megabytes of it, rewritten on every save. The body
    // and the message rows are the record now; the column stays because it is
    // `not null` and because rows written before this change are still read
    // through it, but it is no longer a copy of anything.
    const payload = bodyPayload;
    const messageRows = rows.map((row) => `
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
      values (
        ${sqlString(conversation.id)},
        ${row.index},
        ${sqlString(row.id)},
        ${sqlString(row.createdAt)},
        ${sqlString(row.json)}
      );
    `).join("\n");
    await this.storage.sqlite.runSql(`
      begin immediate;
      insert into conversations (id, title, kind, created_at, updated_at, repo_path, payload_json)
      values (
        ${sqlString(conversation.id)},
        ${sqlString(conversation.title)},
        ${sqlString(conversation.kind)},
        ${sqlString(conversation.createdAt)},
        ${sqlString(conversation.updatedAt)},
        ${sqlString(conversation.repoPath)},
        ${sqlString(payload)}
      )
      on conflict(id) do update set
        title = excluded.title,
        kind = excluded.kind,
        updated_at = excluded.updated_at,
        repo_path = excluded.repo_path,
        body_json = ${sqlString(bodyPayload)},
        payload_json = excluded.payload_json;
      update conversations set body_json = ${sqlString(bodyPayload)}, save_token = ${sqlString(token)}
        where id = ${sqlString(conversation.id)};
      delete from conversation_messages where conversation_id = ${sqlString(conversation.id)};
      ${messageRows}
      ${alsoCommitSql}
      commit;
    `);
  }

  /** Returns false when this process no longer owns the row, so the caller must
   *  fall back to a full rewrite. */
  private async writeConversationIncrementally(
    conversation: Conversation,
    rows: SavedMessageRow[],
    previous: SavedMessageState,
    token: string,
    alsoCommit?: { sql: string; onlyIfSql(condition: string): string }
  ): Promise<boolean> {
    const bodyPayload = JSON.stringify(conversationBody(conversation));
    const payload = bodyPayload;
    // Messages are spliced, not only appended (`chat.ts` inserts a message into
    // the middle of the array and removes pending ones), and a splice shifts
    // every later row's sequence while leaving its content identical. Comparing
    // content alone would call those rows clean and leave stale sequences
    // behind, and re-inserting a message id that still exists at another
    // sequence would trip `unique (conversation_id, message_id)` and fail the
    // whole transaction. So the first position whose message id differs decides:
    // everything from there is rewritten, everything before it is touched only
    // when its content changed. An append makes that boundary the old length; an
    // in-place edit makes it the end.
    const shared = Math.min(previous.rows.length, rows.length);
    let divergence = shared;
    for (let index = 0; index < shared; index += 1) {
      if (previous.rows[index].id !== rows[index].id) {
        divergence = index;
        break;
      }
    }
    const owned = `exists (select 1 from conversations where id = ${sqlString(conversation.id)}
      and save_token = ${sqlString(previous.token)})`;
    const statements: string[] = [];
    statements.push(`
      delete from conversation_messages
      where conversation_id = ${sqlString(conversation.id)} and sequence >= ${divergence} and ${owned};
    `);
    for (const row of rows) {
      const changed = row.index >= divergence || previous.rows[row.index].hash !== row.hash;
      if (!changed) {
        continue;
      }
      statements.push(`
        insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
        select ${sqlString(conversation.id)}, ${row.index}, ${sqlString(row.id)},
          ${sqlString(row.createdAt)}, ${sqlString(row.json)}
        where ${owned}
        on conflict(conversation_id, sequence) do update set
          message_id = excluded.message_id,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json;
      `);
    }
    await this.storage.sqlite.runSql(`
      begin immediate;
      update conversations set
        title = ${sqlString(conversation.title)},
        kind = ${sqlString(conversation.kind)},
        updated_at = ${sqlString(conversation.updatedAt)},
        repo_path = ${sqlString(conversation.repoPath)},
        body_json = ${sqlString(bodyPayload)},
        payload_json = ${sqlString(payload)}
      where id = ${sqlString(conversation.id)} and save_token = ${sqlString(previous.token)};
      ${statements.join("\n")}
      ${alsoCommit ? alsoCommit.onlyIfSql(owned) : ""}
      update conversations set save_token = ${sqlString(token)}
        where id = ${sqlString(conversation.id)} and save_token = ${sqlString(previous.token)};
      commit;
    `);
    const observed = await this.storage.sqlite.queryText(
      `select save_token from conversations where id = ${sqlString(conversation.id)} limit 1;`
    );
    return observed === token;
  }

  /**
   * Chats this device has been told are gone.
   *
   * A replicated copy cannot tell a new conversation from a stale snapshot of
   * a deleted one; both are just rows arriving. The tombstone is what makes
   * the difference, and it has to outlive the rows and the process.
   */
  conversationTombstones(): {
    mark(conversationId: string, deletedAt: string): Promise<void>;
    isDeleted(conversationId: string): Promise<boolean>;
    deletedAt(conversationId: string): Promise<string | undefined>;
    pendingCopies(): Promise<Array<{ conversationId: string; deletedAt: string }>>;
  } {
    return {
      mark: async (conversationId, deletedAt) => {
        await this.storage.schema.init();
        await this.storage.sqlite.runSql(`begin immediate; ${this.conversationDeletionSql(conversationId, deletedAt)} commit;`);
      },
      isDeleted: async (conversationId) => Boolean(await this.conversationTombstones().deletedAt(conversationId)),
      deletedAt: async (conversationId) => {
        await this.storage.schema.init();
        const rows = await this.storage.sqlite.queryJson<{ deletedAt: string }>(
          `select deleted_at as deletedAt from deleted_conversations where conversation_id = ${sqlString(conversationId)};`);
        return rows[0]?.deletedAt;
      },
      pendingCopies: async () => {
        await this.storage.schema.init();
        return this.storage.sqlite.queryJson<{ conversationId: string; deletedAt: string }>(`select d.conversation_id as conversationId, d.deleted_at as deletedAt
          from deleted_conversations d join conversations c on c.id = d.conversation_id order by d.conversation_id limit 100;`);
      }
    };
  }

  private conversationDeletionSql(conversationId: string, deletedAt: string): string {
    if (!conversationId.trim() || !deletedAt.trim()) throw new Error("A deletion tombstone requires stable identities.");
    return `insert into deleted_conversations(conversation_id, deleted_at)
      values (${sqlString(conversationId)}, ${sqlString(deletedAt)}) on conflict(conversation_id) do nothing;`;
  }

  async deleteConversation(id: string, options: { alsoCommitSql?: string } = {}): Promise<boolean> {
    await this.storage.schema.init();
    const exists = await this.storage.sqlite.queryText(
      `select id from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!exists) {
      return false;
    }
    await this.storage.sqlite.runSql(`
      begin immediate;
      ${this.conversationDeletionSql(id, new Date().toISOString())}
      delete from conversation_messages where conversation_id = ${sqlString(id)};
      delete from conversations where id = ${sqlString(id)};
      ${options.alsoCommitSql ?? ""}
      commit;
    `);
    this.savedMessageState.delete(id);
    return true;
  }
}
