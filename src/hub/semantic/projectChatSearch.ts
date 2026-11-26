import type { ChatSearchService } from "../../main/services/chatSearch";
import type { StorageService } from "../../main/services/storage";
import {
  CHAT_SEARCH_DEFAULT_LIMIT, CHAT_SEARCH_MAX_LIMIT, MEMORY_QUERY_MAX_CHARS, type ChatSearchHit, type ChatSearchValue, type MemoryResult
} from "../../shared/memory";
import { searchWords, snippetOf } from "../memoryWordSearch";
import { MESSAGE_COLUMNS, messageOfRow, type HubSemantic, type MessageRow } from "./hubSemantic";
import { messagePassages, printableText, takeTurns } from "./semanticVectors";

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
 * A member's search of the messages in the other chats of its chat's project
 * (the User, 2026-11-26: only that project's chats; a chat with no project
 * searches the other chats with no project). Its own chat is left out: what
 * it holds is in the member's context already. With the User's OpenAI key
 * the closest in meaning and the best by words take turns; without it (or
 * when OpenAI does not answer), by words alone.
 */
export async function searchProjectChats(
  deps: ProjectChatSearchDeps,
  member: { conversationId: string; projectPath?: string },
  request: { query?: unknown; limit?: unknown }
): Promise<MemoryResult<ChatSearchValue>> {
  const query = request.query;
  if (typeof query !== "string" || query.length > MEMORY_QUERY_MAX_CHARS || query.includes("\u0000") || !searchWords(query).length) {
    return { ok: false, error: { code: "invalid_request", message: `Give query: what to look for, in words (under ${MEMORY_QUERY_MAX_CHARS} characters).` } };
  }
  const limit = typeof request.limit === "number" && Number.isFinite(request.limit)
    ? Math.max(1, Math.min(CHAT_SEARCH_MAX_LIMIT, Math.floor(request.limit)))
    : CHAT_SEARCH_DEFAULT_LIMIT;
  const chats = await deps.storage.sqlExecutor().queryJson<{ id: string; title: string }>(
    `select id, title from conversations where kind = 'chat' and coalesce(repo_path, '') = ${quote(member.projectPath ?? "")} and id <> ${quote(member.conversationId)};`);
  const titles = new Map(chats.map((chat) => [chat.id, chat.title]));
  const words = searchWords(query);

  // Both at once: a member waits for the slower, not for the two in turn.
  const [byMeaning, byWords] = await Promise.all([
    meaningHits(deps, titles, query, words, limit).catch((error: unknown) => {
      deps.log("hub.chat-search.meaning-failed", { message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }),
    wordHits(deps, member, query, limit)
  ]);
  if (!byMeaning && !byWords) {
    return { ok: false, error: { code: "server_unavailable", message: "Your server could not search the chats just now (its search by words is still being prepared). Try again in a minute." } };
  }
  const hits = (byMeaning ? takeTurns(byMeaning, byWords ?? [], (hit) => `${hit.conversationId}\n${hit.messageId}`) : byWords ?? []).slice(0, limit);
  // Said by what found them: meaning that found nothing close ranked nothing.
  const ranking: ChatSearchValue["ranking"] = byMeaning?.length ? "meaning" : "any-word";
  deps.log("hub.chat-search", { conversationId: member.conversationId, chats: titles.size, found: hits.length, ranking, words: Boolean(byWords) });
  const catchingUp = byMeaning !== undefined && deps.semantic && !deps.semantic.complete();
  return { ok: true, value: { hits, ranking, ...(catchingUp ? { catchingUp: true } : {}) } };
}

/** The messages closest in meaning, as the chat shows them now; undefined
 *  without the key or when OpenAI did not answer. */
async function meaningHits(
  deps: ProjectChatSearchDeps,
  titles: Map<string, string>,
  query: string,
  words: ReturnType<typeof searchWords>,
  limit: number
): Promise<ChatSearchHit[] | undefined> {
  const print = deps.semantic?.enabled() ? await deps.semantic.printQuery(query, QUERY_PRINT_TIMEOUT_MS) : undefined;
  if (!print || !deps.semantic) return undefined;
  // A few more than asked: some fall under the closeness wanted, or are
  // hidden since they were printed.
  const close = (await deps.semantic.messageCloseness(print, new Set(titles.keys()), Math.min(CHAT_SEARCH_MAX_LIMIT * 2, limit * 2))).filter((item) => item.score >= CHAT_MEANING_MIN);
  const rows = await messageRows(deps.storage, close);
  const hits: ChatSearchHit[] = [];
  for (const item of close) {
    const row = rows.get(`${item.conversationId}\n${item.messageId}`);
    // Read again: hidden or emptied since it was printed, it is not given.
    const text = row ? printableText(messageOfRow(row)) : undefined;
    if (!row || !text) continue;
    const range = messagePassages(text).ranges[item.part];
    const passage = range ? text.slice(range.start, range.end) : text;
    hits.push({
      conversationId: item.conversationId,
      chatTitle: titles.get(item.conversationId) ?? "",
      messageId: item.messageId,
      author: row.role === "user" ? "User" : row.label?.trim() || "member",
      createdAt: row.createdAt,
      snippet: snippetOf(passage, words, SNIPPET_CHARS)
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The messages holding any word asked, best first; undefined when the
 *  search by words did not answer in time or failed. */
async function wordHits(
  deps: ProjectChatSearchDeps,
  member: { conversationId: string; projectPath?: string },
  query: string,
  limit: number
): Promise<ChatSearchHit[] | undefined> {
  if (!deps.chatSearch) return undefined;
  const byWords = await withinBudget(deps.chatSearch.search({
    requester: { kind: "user" }, query, anyWord: true, repoPath: member.projectPath ?? null, excludeConversationId: member.conversationId, limit
  }), WORD_SEARCH_BUDGET_MS).catch((error: unknown) => {
    deps.log("hub.chat-search.words-failed", { message: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  if (byWords?.status !== "ok") return undefined;
  return byWords.matches.flatMap((match): ChatSearchHit[] => match.kind !== "message" || match.conversationId === member.conversationId ? [] : [{
    conversationId: match.conversationId,
    chatTitle: match.conversationTitle,
    messageId: match.messageId,
    author: match.role === "user" ? "User" : match.authorLabel,
    createdAt: match.createdAt,
    snippet: cut(match.snippetText.replace(/\s+/g, " ").trim(), SNIPPET_CHARS)
  }]);
}

type ReadRow = MessageRow & { label: string | null; createdAt: string };

/** The messages named, read through their index (chat and message id). */
async function messageRows(storage: StorageService, items: Array<{ conversationId: string; messageId: string }>): Promise<Map<string, ReadRow>> {
  const rows = new Map<string, ReadRow>();
  if (!items.length) return rows;
  const where = items.map((item) => `(m.conversation_id = ${quote(item.conversationId)} and m.message_id = ${quote(item.messageId)})`).join(" or ");
  const read = await storage.sqlExecutor().queryJson<ReadRow>(`select ${MESSAGE_COLUMNS},
    json_extract(m.payload_json, '$.participantLabel') as label, m.created_at as createdAt
    from conversation_messages m where json_valid(m.payload_json) and (${where});`);
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
