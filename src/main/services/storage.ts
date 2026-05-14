import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { runCommand } from "./command";
import type {
  ChatMessage,
  Conversation,
  ConversationMessagePage,
  ConversationMessagePageInfo,
  ConversationOpenResult,
  ConversationSummary
} from "../../shared/types";
import { sanitizeConversationWarnings, sanitizeWarningList } from "../../shared/warnings";

const INTERRUPTED_RUN_WARNING = "Previous run was interrupted before completion. Continue from the saved context.";
const DEFAULT_MESSAGE_PAGE_LIMIT = 80;
const MAX_MESSAGE_PAGE_LIMIT = 200;

function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export class StorageService {
  private readonly dbPath: string;
  private initialized = false;

  constructor() {
    this.dbPath = path.join(app.getPath("userData"), "ai-consensus.sqlite3");
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(path.dirname(this.dbPath), { recursive: true });
    await this.runSql(`
      create table if not exists conversations (
        id text primary key,
        title text not null,
        kind text not null,
        created_at text not null,
        updated_at text not null,
        repo_path text,
        body_json text,
        payload_json text not null
      );
      create index if not exists idx_conversations_updated_at on conversations(updated_at);
      create table if not exists conversation_messages (
        conversation_id text not null,
        sequence integer not null,
        message_id text not null,
        created_at text not null,
        payload_json text not null,
        primary key (conversation_id, sequence),
        unique (conversation_id, message_id)
      );
      create index if not exists idx_conversation_messages_conversation_sequence on conversation_messages(conversation_id, sequence);
    `);
    await this.ensureColumn("conversations", "body_json", "text");
    this.initialized = true;
    await this.backfillConversationBodiesAndMessages();
    await this.clearInterruptedRuns();
  }

  async listConversations(): Promise<ConversationSummary[]> {
    await this.init();
    const rows = await this.queryJson<{
      id: string;
      title: string;
      kind: ConversationSummary["kind"];
      createdAt: string;
      updatedAt: string;
      repoPath?: string;
    }>(
      "select id, title, kind, created_at as createdAt, updated_at as updatedAt, repo_path as repoPath from conversations order by updated_at desc;"
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      repoPath: row.repoPath ?? undefined
    }));
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    await this.init();
    const payloadJson = await this.queryText(
      `select payload_json from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!payloadJson) {
      return undefined;
    }
    const conversation = JSON.parse(payloadJson) as Conversation;
    sanitizeConversationWarnings(conversation);
    return conversation;
  }

  async openConversation(id: string, limit?: number): Promise<ConversationOpenResult | undefined> {
    await this.init();
    const bodyJson = await this.queryText(
      `select coalesce(nullif(body_json, ''), payload_json) from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!bodyJson) {
      return undefined;
    }
    const conversation = JSON.parse(bodyJson) as Conversation;
    sanitizeConversationWarnings(conversation);
    const messagePage = await this.listConversationMessages({
      conversationId: id,
      limit
    });
    return {
      conversation: {
        ...conversation,
        messages: messagePage.messages
      },
      messagePage: messagePageInfo(messagePage)
    };
  }

  async listConversationMessages(request: { conversationId: string; beforeSequence?: number; limit?: number }): Promise<ConversationMessagePage> {
    await this.init();
    const limit = normalizeMessagePageLimit(request.limit);
    const beforeClause = typeof request.beforeSequence === "number"
      ? ` and sequence < ${Math.max(0, Math.floor(request.beforeSequence))}`
      : "";
    const rows = await this.queryJson<{ sequence: number; payloadJson: string }>(
      `
        select sequence, payload_json as payloadJson
        from conversation_messages
        where conversation_id = ${sqlString(request.conversationId)}${beforeClause}
        order by sequence desc
        limit ${limit + 1};
      `
    );
    const selectedRows = rows.slice(0, limit).reverse();
    const countRows = await this.queryJson<{ totalMessages: number }>(
      `select count(*) as totalMessages from conversation_messages where conversation_id = ${sqlString(request.conversationId)};`
    );
    return {
      messages: selectedRows.map((row) => JSON.parse(row.payloadJson) as ChatMessage),
      oldestSequence: selectedRows[0]?.sequence,
      newestSequence: selectedRows[selectedRows.length - 1]?.sequence,
      hasMoreBefore: rows.length > limit,
      totalMessages: countRows[0]?.totalMessages ?? selectedRows.length
    };
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.init();
    const payload = JSON.stringify(conversation);
    const bodyPayload = JSON.stringify(conversationBody(conversation));
    const messageRows = conversation.messages.map((message, index) => `
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
      values (
        ${sqlString(conversation.id)},
        ${index},
        ${sqlString(message.id)},
        ${sqlString(message.createdAt)},
        ${sqlString(JSON.stringify(message))}
      );
    `).join("\n");
    await this.runSql(`
      begin;
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
      update conversations set body_json = ${sqlString(bodyPayload)} where id = ${sqlString(conversation.id)};
      delete from conversation_messages where conversation_id = ${sqlString(conversation.id)};
      ${messageRows}
      commit;
    `);
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.queryJson<{ name: string }>(`pragma table_info(${table});`);
    if (rows.some((row) => row.name === column)) {
      return;
    }
    await this.runSql(`alter table ${table} add column ${column} ${definition};`);
  }

  private async backfillConversationBodiesAndMessages(): Promise<void> {
    const rows = await this.queryJson<{ id: string; payloadJson: string; bodyJson?: string; messageCount: number }>(`
      select
        c.id,
        c.payload_json as payloadJson,
        c.body_json as bodyJson,
        count(m.message_id) as messageCount
      from conversations c
      left join conversation_messages m on m.conversation_id = c.id
      group by c.id
      having c.body_json is null or c.body_json = '' or messageCount = 0;
    `);
    for (const row of rows) {
      let conversation: Conversation;
      try {
        conversation = JSON.parse(row.payloadJson) as Conversation;
      } catch {
        continue;
      }
      if (row.bodyJson?.trim() && row.messageCount > 0) {
        continue;
      }
      await this.saveConversation(conversation);
    }
  }

  private async clearInterruptedRuns(): Promise<void> {
    const rows = await this.queryJson<{ payloadJson: string }>(
      "select payload_json as payloadJson from conversations where payload_json like '%\"running\":true%';"
    );
    for (const row of rows) {
      let conversation: Conversation;
      try {
        conversation = JSON.parse(row.payloadJson) as Conversation;
      } catch {
        continue;
      }
      if (conversation.metadata.running !== true) {
        continue;
      }
      const warnings = sanitizeWarningList(conversation.metadata.warnings);
      if (!warnings.includes(INTERRUPTED_RUN_WARNING)) {
        warnings.push(INTERRUPTED_RUN_WARNING);
      }
      conversation.metadata = {
        ...conversation.metadata,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
    }
  }

  private async queryJson<T>(sql: string): Promise<T[]> {
    const result = await runCommand("sqlite3", ["-json", this.dbPath, sql], { timeoutMs: 10_000 });
    const text = result.stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  private async queryText(sql: string): Promise<string> {
    const result = await runCommand("sqlite3", ["-batch", "-noheader", this.dbPath, sql], { timeoutMs: 10_000 });
    return result.stdout.trim();
  }

  private async runSql(sql: string): Promise<void> {
    await runCommand("sqlite3", [this.dbPath], { input: sql, timeoutMs: 10_000 });
  }
}

function normalizeMessagePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.floor(limit as number)));
}

function conversationBody(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: []
  };
}

function messagePageInfo(page: ConversationMessagePage): ConversationMessagePageInfo {
  return {
    oldestSequence: page.oldestSequence,
    newestSequence: page.newestSequence,
    hasMoreBefore: page.hasMoreBefore,
    totalMessages: page.totalMessages
  };
}
