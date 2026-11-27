import type { MemoryNote, MemoryNoteKind, MemoryNoteSummary, MemoryScope } from "../shared/memory";
import { searchTextOf } from "./memoryWordSearch";

/** Members' notes as the server's table keeps them, shared by its parts
 *  (HubMemory, HubCliMemory). */

/** Takes the next place in the order (changes are made one at a time); sent
 *  in the same batch as the change that uses SEQ_SQL. */
export const BUMP_SQL = "update member_memory_counter set value = value + 1 where key = 'change_seq';";
export const SEQ_SQL = "(select value from member_memory_counter where key = 'change_seq')";

export interface Row {
  id: string;
  kind: string;
  title: string;
  body?: string;
  tagsJson: string;
  scope: string;
  scopeKey: string;
  source: string | null;
  author: string;
  updatedBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  awaitingRepository: number;
  archivedAt: string | null;
  lastRequest?: string | null;
  createRequestHash?: string | null;
}

export const SUMMARY_COLUMNS = `id, kind, title, tags_json as tagsJson, scope, scope_key as scopeKey, source, author, updated_by as updatedBy, version,
  created_at as createdAt, updated_at as updatedAt, verified_at as verifiedAt, awaiting_repository as awaitingRepository, archived_at as archivedAt`;

export function summaryOf(row: Row): MemoryNoteSummary {
  const scope = row.scope as MemoryScope;
  return {
    id: row.id,
    kind: row.kind as MemoryNoteKind,
    title: row.title,
    tags: parseTags(row.tagsJson),
    scope,
    ...(scope === "project" ? { projectPath: row.scopeKey } : {}),
    ...(scope === "role" ? { roleId: row.scopeKey } : {}),
    ...(scope === "chat" ? { conversationId: row.scopeKey } : {}),
    author: row.author,
    updatedBy: row.updatedBy,
    version: Number(row.version),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : {}),
    awaitingRepository: Number(row.awaitingRepository) === 1,
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {})
  };
}

export function noteOf(row: Row): MemoryNote {
  return { ...summaryOf(row), body: row.body ?? "", ...(row.source ? { source: row.source } : {}) };
}

export function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/** Lower case by the language's own rules (sqlite's lower() knows only ASCII). */
export function searchText(fields: { title: string; body: string; tags: string[] }): string {
  return searchTextOf(fields);
}

export function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}
