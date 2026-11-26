import type { ChatSearchService } from "../../main/services/chatSearch";
import type { StorageService } from "../../main/services/storage";
import {
  CHAT_SEARCH_DEFAULT_LIMIT, CHAT_SEARCH_MAX_LIMIT, MEMORY_QUERY_MAX_CHARS, type ChatSearchHit, type ChatSearchValue, type MemoryResult
} from "../../shared/memory";
import { searchWords, snippetOf } from "../memoryWordSearch";
import type { HubSemantic } from "./hubSemantic";
import { messagePassages } from "./semanticVectors";

/** A message this far from the query in meaning is not given (prints of
 *  512 numbers; unrelated text scores under it on the User's chats). */
const CHAT_MEANING_MIN = 0.2;
const QUERY_PRINT_TIMEOUT_MS = 4_000;
/** The search by words indexes chats it has not seen yet first: on a
 *  server nobody searched before, that takes a while. A member waits this
 *  long, then gets what was found by meaning (the index goes on). */
const WORD_SEARCH_BUDGET_MS = 15_000;
const SNIPPET_CHARS = 300;

export interface ProjectChatSearchDeps {
  storage: StorageService;
  semantic?: HubSemantic;
  chatSearch?: ChatSearchService;
  log: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * A member's search of the messages of its chat's project (the User,
 * 2026-11-26: only that project's chats; a chat with no project searches
 * chats with no project). Closest in meaning first with the User's OpenAI
 * key, then messages holding any word asked; without the key (or when
 * OpenAI does not answer), by words alone.
 */
export async function searchProjectChats(
  deps: ProjectChatSearchDeps,
  member: { conversationId: string; projectPath?: string },
  request: { query?: unknown; limit?: unknown }
): Promise<MemoryResult<ChatSearchValue>> {
  const query = request.query;
  if (typeof query !== "string" || query.length > MEMORY_QUERY_MAX_CHARS || query.includes("\u0000") || !searchWords(query).length) {
    return { ok: false, error: { code: "invalid_request", message: `Search by words under ${MEMORY_QUERY_MAX_CHARS} characters.` } };
  }
  const limit = typeof request.limit === "number" && Number.isFinite(request.limit)
    ? Math.max(1, Math.min(CHAT_SEARCH_MAX_LIMIT, Math.floor(request.limit)))
    : CHAT_SEARCH_DEFAULT_LIMIT;
  const chats = await deps.storage.sqlExecutor().queryJson<{ id: string; title: string }>(
    `select id, title from conversations where kind = 'chat' and coalesce(repo_path, '') = ${quote(member.projectPath ?? "")};`);
  const titles = new Map(chats.map((chat) => [chat.id, chat.title]));
  const words = searchWords(query);
  const hits: ChatSearchHit[] = [];
  const seen = new Set<string>();
  let ranking: ChatSearchValue["ranking"] = "any-word";

  const print = deps.semantic?.enabled() ? await deps.semantic.printQuery(query, QUERY_PRINT_TIMEOUT_MS) : undefined;
  if (print && deps.semantic) {
    ranking = "meaning";
    const close = (await deps.semantic.messageCloseness(print, new Set(titles.keys()), limit)).filter((item) => item.score >= CHAT_MEANING_MIN);
    const rows = await messageRows(deps.storage, close);
    for (const item of close) {
      const row = rows.get(`${item.conversationId}\n${item.messageId}`);
      if (!row || typeof row.content !== "string") continue;
      const range = messagePassages(row.content).ranges[item.part];
      const passage = range ? row.content.slice(range.start, range.end) : row.content;
      seen.add(`${item.conversationId}\n${item.messageId}`);
      hits.push({
        conversationId: item.conversationId,
        chatTitle: titles.get(item.conversationId) ?? "",
        ...(item.conversationId === member.conversationId ? { thisChat: true } : {}),
        messageId: item.messageId,
        author: row.role === "user" ? "User" : row.label?.trim() || "member",
        createdAt: row.createdAt,
        snippet: snippetOf(passage, words, SNIPPET_CHARS)
      });
    }
  }

  if (hits.length < limit && deps.chatSearch) {
    const byWords = await withinBudget(deps.chatSearch.search({
      requester: { kind: "user" }, query, anyWord: true, repoPath: member.projectPath ?? null, limit
    }), WORD_SEARCH_BUDGET_MS).catch((error: unknown) => {
      deps.log("hub.chat-search.words-failed", { message: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
    if (byWords?.status === "ok") {
      for (const match of byWords.matches) {
        if (hits.length >= limit) break;
        if (match.kind !== "message" || seen.has(`${match.conversationId}\n${match.messageId}`)) continue;
        seen.add(`${match.conversationId}\n${match.messageId}`);
        hits.push({
          conversationId: match.conversationId,
          chatTitle: match.conversationTitle,
          ...(match.conversationId === member.conversationId ? { thisChat: true } : {}),
          messageId: match.messageId,
          author: match.role === "user" ? "User" : match.authorLabel,
          createdAt: match.createdAt,
          snippet: cut(match.snippetText.replace(/\s+/g, " ").trim(), SNIPPET_CHARS)
        });
      }
    } else if (!byWords && !print) {
      return { ok: false, error: { code: "server_unavailable", message: "Your server is still preparing its search of the chats. Try again in a minute." } };
    }
  }
  deps.log("hub.chat-search", { conversationId: member.conversationId, chats: titles.size, found: hits.length, ranking });
  const catchingUp = ranking === "meaning" && deps.semantic && !deps.semantic.complete();
  return { ok: true, value: { hits, ranking, ...(catchingUp ? { catchingUp: true } : {}) } };
}

interface MessageRow {
  conversationId: string;
  messageId: string;
  role: string;
  label: string | null;
  createdAt: string;
  content: string | null;
}

/** The messages named, read through their index (chat and message id). */
async function messageRows(storage: StorageService, items: Array<{ conversationId: string; messageId: string }>): Promise<Map<string, MessageRow>> {
  const rows = new Map<string, MessageRow>();
  if (!items.length) return rows;
  const where = items.map((item) => `(conversation_id = ${quote(item.conversationId)} and message_id = ${quote(item.messageId)})`).join(" or ");
  const read = await storage.sqlExecutor().queryJson<MessageRow>(`select conversation_id as conversationId, message_id as messageId,
    json_extract(payload_json, '$.role') as role, json_extract(payload_json, '$.participantLabel') as label, created_at as createdAt,
    substr(json_extract(payload_json, '$.content'), 1, 12000) as content
    from conversation_messages where json_valid(payload_json) and (${where});`);
  for (const row of read) rows.set(`${row.conversationId}\n${row.messageId}`, row);
  return rows;
}

function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : text;
}

function quote(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be read.");
  return `'${value.replace(/'/g, "''")}'`;
}
