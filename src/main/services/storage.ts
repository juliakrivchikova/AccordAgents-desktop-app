import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { runCommand } from "./command";
import type { Conversation, ConversationSummary } from "../../shared/types";
import { sanitizeConversationWarnings, sanitizeWarningList } from "../../shared/warnings";

const INTERRUPTED_RUN_WARNING = "Previous run was interrupted before completion. Resume the plan to continue from the saved context.";

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
        payload_json text not null
      );
      create index if not exists idx_conversations_updated_at on conversations(updated_at);
    `);
    this.initialized = true;
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
    const rows = await this.queryJson<{ payloadJson: string }>(
      `select payload_json as payloadJson from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (rows.length === 0) {
      return undefined;
    }
    const conversation = JSON.parse(rows[0].payloadJson) as Conversation;
    sanitizeConversationWarnings(conversation);
    return conversation;
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.init();
    const payload = JSON.stringify(conversation);
    await this.runSql(`
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
        payload_json = excluded.payload_json;
    `);
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

  private async runSql(sql: string): Promise<void> {
    await runCommand("sqlite3", [this.dbPath], { input: sql, timeoutMs: 10_000 });
  }
}
