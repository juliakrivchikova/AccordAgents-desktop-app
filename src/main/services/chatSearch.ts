import { createHash, randomUUID } from "node:crypto";

import { buildChatSearchDocuments } from "../../shared/chatSearchDocuments";
import type {
  ChatSearchCoverage,
  ChatSearchFailureDetail,
  ChatSearchFailureStage,
  ChatSearchHighlightRange,
  ChatSearchRequest,
  ChatSearchResponse
} from "../../shared/types";
import {
  type ChatSearchConversationRead,
  type ChatSearchConversationSnapshot,
  type ChatSearchDocumentReplacement,
  type ChatSearchIndexState,
  InvalidChatSearchSourceError,
  StorageService
} from "./storage";

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 200;
const MAX_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 24;
const SOURCE_READ_BATCH_SIZE = 24;
const INDEX_WRITE_BATCH_SIZE = 24;
const INDEX_WRITE_BATCH_CHARS = 4_000_000;

interface ChatSearchDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

interface SearchCursor {
  version: 2;
  matchQuery: string;
  corpusFingerprint: string;
  offset: number;
}

class ChatSearchFailure extends Error {
  constructor(
    readonly stage: ChatSearchFailureStage,
    readonly conversationId: string | undefined,
    readonly indexRecoverable: boolean,
    cause: unknown,
    readonly scope?: ChatSearchConversationSnapshot[]
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChatSearchFailure";
  }
}

class ChatSearchSourceChanged extends Error {
  constructor(readonly conversationId: string) {
    super(`Saved chat changed while search was indexing: ${conversationId}`);
    this.name = "ChatSearchSourceChanged";
  }
}

export class ChatSearchService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageService,
    private readonly debugLogger?: ChatSearchDebugLogger
  ) {}

  search(request: ChatSearchRequest): Promise<ChatSearchResponse> {
    const task = this.queue.then(() => this.searchNow(request));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async searchNow(request: ChatSearchRequest): Promise<ChatSearchResponse> {
    const requestedAt = new Date().toISOString();
    const matchQuery = buildChatSearchMatchQuery(request?.query);
    const cursor = decodeCursor(request?.cursor, matchQuery);
    if (!matchQuery || !validRequester(request?.requester) || cursor === null) {
      return unavailableResponse([], requestedAt, "invalid-request");
    }

    let scope: ChatSearchConversationSnapshot[] = [];
    for (let indexAttempt = 0; indexAttempt < 2; indexAttempt += 1) {
      try {
        const result = await this.searchWithStableSource(request, matchQuery, cursor);
        scope = result.scope;
        return result.response;
      } catch (error) {
        const failure = normalizeFailure(error);
        if (failure.indexRecoverable && indexAttempt === 0) {
          try {
            await this.storage.rebuildChatSearchIndex();
            continue;
          } catch (rebuildError) {
            return this.unavailableAfterFailure(failure.scope ?? scope, requestedAt, new ChatSearchFailure(
              "index-prepare",
              undefined,
              false,
              rebuildError
            ));
          }
        }
        return this.unavailableAfterFailure(failure.scope ?? scope, requestedAt, failure);
      }
    }
    return unavailableResponse(scope, requestedAt, "search-unavailable", { stage: "index-prepare" });
  }

  private async searchWithStableSource(
    request: ChatSearchRequest,
    matchQuery: string,
    cursor: SearchCursor | undefined
  ): Promise<{ scope: ChatSearchConversationSnapshot[]; response: ChatSearchResponse }> {
    for (let sourceAttempt = 0; sourceAttempt < 2; sourceAttempt += 1) {
      const snapshots = await atStage(
        "source-snapshot",
        false,
        () => this.storage.listChatSearchConversationSnapshots({
          includeParticipants: request.requester.kind === "participant"
        })
      );
      const sourceSnapshotAt = new Date().toISOString();
      const scope = resolveRequesterScope(snapshots, request.requester);
      if (!scope) {
        return {
          scope: [],
          response: unavailableResponse([], sourceSnapshotAt, "requester-not-authorized")
        };
      }
      const unreadableSnapshot = scope.find((snapshot) => snapshot.sourceReadable === false);
      if (unreadableSnapshot) {
        throw new ChatSearchFailure(
          "source-snapshot",
          unreadableSnapshot.conversationId,
          false,
          new Error(`Saved chat ${unreadableSnapshot.conversationId} has invalid canonical JSON.`),
          scope
        );
      }
      const fingerprint = corpusFingerprint(scope);
      if (cursor && cursor.corpusFingerprint !== fingerprint) {
        return {
          scope,
          response: unavailableResponse(scope, sourceSnapshotAt, "invalid-request")
        };
      }

      try {
        const response = await this.searchSnapshot(scope, snapshots, sourceSnapshotAt, matchQuery, request, cursor, fingerprint);
        return { scope, response };
      } catch (error) {
        if (error instanceof ChatSearchSourceChanged && sourceAttempt === 0) {
          continue;
        }
        if (error instanceof ChatSearchSourceChanged) {
          throw new ChatSearchFailure("source-read", error.conversationId, false, error);
        }
        if (error instanceof ChatSearchFailure && !error.scope) {
          throw new ChatSearchFailure(
            error.stage,
            error.conversationId,
            error.indexRecoverable,
            error,
            scope
          );
        }
        throw error;
      }
    }
    throw new ChatSearchFailure("source-read", undefined, false, new Error("Saved chats changed repeatedly during search."));
  }

  private async searchSnapshot(
    scope: ChatSearchConversationSnapshot[],
    allSnapshots: ChatSearchConversationSnapshot[],
    sourceSnapshotAt: string,
    matchQuery: string,
    request: ChatSearchRequest,
    cursor: SearchCursor | undefined,
    fingerprint: string
  ): Promise<ChatSearchResponse> {
    await atStage("index-prepare", true, () => this.storage.ensureChatSearchIndex());
    const allStates = await atStage("index-prepare", true, () => this.storage.listChatSearchIndexStates());
    const stateByConversationId = new Map(allStates.map((state) => [state.conversationId, state]));
    const staleSnapshots = scope.filter((snapshot) =>
      !chatSearchStateMatchesSnapshot(stateByConversationId.get(snapshot.conversationId), snapshot)
    );
    const reads: ChatSearchConversationRead[] = [];
    for (const batch of chunks(staleSnapshots, SOURCE_READ_BATCH_SIZE)) {
      const batchIds = batch.map((snapshot) => snapshot.conversationId);
      const batchReads = await atStage("source-read", false, () => this.storage.readChatSearchConversations(batchIds));
      const readById = new Map(batchReads.map((read) => [read.snapshot.conversationId, read]));
      for (const planned of batch) {
        const read = readById.get(planned.conversationId);
        if (!read) {
          throw new ChatSearchFailure(
            "source-read",
            planned.conversationId,
            false,
            new Error(`Saved chat disappeared during search: ${planned.conversationId}`)
          );
        }
        if (!sameSourceVersion(planned, read.snapshot)) {
          throw new ChatSearchSourceChanged(planned.conversationId);
        }
        reads.push(read);
      }
    }

    const indexedAt = new Date().toISOString();
    const replacements: ChatSearchDocumentReplacement[] = reads.map((read) => ({
      snapshot: read.snapshot,
      documents: buildChatSearchDocuments({ ...read.conversation, title: read.snapshot.title }),
      indexedAt
    }));
    for (const batch of replacementChunks(replacements)) {
      await atStage("index-write", true, () => this.storage.replaceChatSearchDocumentsBatch(batch));
      for (const replacement of batch) {
        stateByConversationId.set(replacement.snapshot.conversationId, stateFromReplacement(replacement));
      }
    }

    if (request.requester.kind === "user") {
      const liveConversationIds = new Set(allSnapshots.map((snapshot) => snapshot.conversationId));
      const orphanedConversationIds = allStates
        .map((state) => state.conversationId)
        .filter((conversationId) => !liveConversationIds.has(conversationId));
      if (orphanedConversationIds.length > 0) {
        await atStage("index-write", true, () => this.storage.deleteChatSearchDocuments(orphanedConversationIds));
      }
    }

    const limit = normalizeLimit(request.limit);
    const offset = cursor?.offset ?? 0;
    const markerNonce = randomUUID();
    const startMarker = `\u{f0000}ACCORD_${markerNonce}_START\u{f0001}`;
    const endMarker = `\u{f0000}ACCORD_${markerNonce}_END\u{f0001}`;
    const result = await atStage("index-query", true, () => this.storage.queryChatSearchIndex({
      conversationIds: scope.map((snapshot) => snapshot.conversationId),
      matchQuery,
      startMarker,
      endMarker,
      limit: limit + 1,
      offset
    }));
    const hasMore = result.messageMatches.length > limit;
    const messagePage = result.messageMatches.slice(0, limit);
    const snapshotById = new Map(scope.map((snapshot) => [snapshot.conversationId, snapshot]));
    const scopeStates = scope.flatMap((snapshot) => {
      const state = stateByConversationId.get(snapshot.conversationId);
      return state ? [state] : [];
    });
    return {
      status: "ok",
      matches: [
        ...result.titleMatches.flatMap((row) => {
          const snapshot = snapshotById.get(row.conversationId);
          if (!snapshot) {
            return [];
          }
          const parsedTitle = parseChatSearchSnippet(row.snippet, startMarker, endMarker);
          return [{
            kind: "title" as const,
            conversationId: row.conversationId,
            conversationTitle: snapshot.title,
            conversationUpdatedAt: snapshot.updatedAt,
            ...(snapshot.repoPath ? { repoPath: snapshot.repoPath } : {}),
            archived: snapshot.archived,
            titleText: parsedTitle.text,
            highlightRanges: parsedTitle.highlightRanges,
            rank: row.rank
          }];
        }),
        ...messagePage.flatMap((row) => {
          const snapshot = snapshotById.get(row.conversationId);
          if (!snapshot) {
            return [];
          }
          const parsedSnippet = parseChatSearchSnippet(row.snippet, startMarker, endMarker);
          return [{
            kind: "message" as const,
            conversationId: row.conversationId,
            conversationTitle: snapshot.title,
            conversationUpdatedAt: snapshot.updatedAt,
            ...(snapshot.repoPath ? { repoPath: snapshot.repoPath } : {}),
            archived: snapshot.archived,
            messageId: row.messageId,
            ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
            role: row.role,
            authorLabel: row.authorLabel,
            createdAt: row.createdAt,
            snippetText: parsedSnippet.text,
            highlightRanges: parsedSnippet.highlightRanges,
            rank: row.rank
          }];
        })
      ],
      coverage: completeCoverage(scope, sourceSnapshotAt, oldestIndexedAt(scopeStates) ?? sourceSnapshotAt),
      messageMatchCount: result.messageMatchCount,
      matchedChatCount: result.matchedChatCount,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor({
        version: 2,
        matchQuery,
        corpusFingerprint: fingerprint,
        offset: offset + limit
      }) } : {})
    };
  }

  private unavailableAfterFailure(
    scope: ChatSearchConversationSnapshot[],
    sourceSnapshotAt: string,
    failure: ChatSearchFailure
  ): ChatSearchResponse {
    const detail: ChatSearchFailureDetail = {
      stage: failure.stage,
      ...(failure.conversationId ? { conversationId: failure.conversationId } : {})
    };
    void this.debugLogger?.write("chat-search.unavailable", { ...detail });
    console.warn(`[ChatSearchService] Search unavailable at ${failure.stage}: ${failure.message}`);
    return unavailableResponse(scope, sourceSnapshotAt, "search-unavailable", detail);
  }
}

export function buildChatSearchMatchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const terms = value
    .slice(0, MAX_QUERY_CHARS)
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_]+/gu)
    ?.slice(0, MAX_QUERY_TERMS);
  if (!terms?.length) {
    return undefined;
  }
  return terms.map((term, index) => `"${term.replaceAll('"', '""')}"${index === terms.length - 1 ? "*" : ""}`)
    .join(" AND ");
}

export function parseChatSearchSnippet(
  value: string,
  startMarker: string,
  endMarker: string
): { text: string; highlightRanges: ChatSearchHighlightRange[] } {
  let cursor = 0;
  let text = "";
  let highlightStart: number | undefined;
  const highlightRanges: ChatSearchHighlightRange[] = [];
  while (cursor < value.length) {
    if (value.startsWith(startMarker, cursor)) {
      if (highlightStart === undefined) {
        highlightStart = text.length;
      }
      cursor += startMarker.length;
      continue;
    }
    if (value.startsWith(endMarker, cursor)) {
      if (highlightStart !== undefined && text.length > highlightStart) {
        highlightRanges.push({ start: highlightStart, end: text.length });
      }
      highlightStart = undefined;
      cursor += endMarker.length;
      continue;
    }
    text += value[cursor];
    cursor += 1;
  }
  if (highlightStart !== undefined && text.length > highlightStart) {
    highlightRanges.push({ start: highlightStart, end: text.length });
  }
  return { text, highlightRanges };
}

async function atStage<T>(
  stage: ChatSearchFailureStage,
  indexRecoverable: boolean,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ChatSearchFailure || error instanceof ChatSearchSourceChanged) {
      throw error;
    }
    throw new ChatSearchFailure(
      stage,
      error instanceof InvalidChatSearchSourceError ? error.conversationId : undefined,
      indexRecoverable,
      error
    );
  }
}

function normalizeFailure(error: unknown): ChatSearchFailure {
  return error instanceof ChatSearchFailure
    ? error
    : new ChatSearchFailure("index-query", undefined, false, error);
}

function validRequester(value: unknown): value is ChatSearchRequest["requester"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if ((value as { kind?: unknown }).kind === "user") {
    return true;
  }
  return (value as { kind?: unknown }).kind === "participant" &&
    typeof (value as { conversationId?: unknown }).conversationId === "string" &&
    Boolean((value as { conversationId: string }).conversationId.trim()) &&
    typeof (value as { participantId?: unknown }).participantId === "string" &&
    Boolean((value as { participantId: string }).participantId.trim());
}

function resolveRequesterScope(
  snapshots: ChatSearchConversationSnapshot[],
  requester: ChatSearchRequest["requester"]
): ChatSearchConversationSnapshot[] | undefined {
  if (requester.kind === "user") {
    return snapshots;
  }
  const current = snapshots.find((snapshot) => snapshot.conversationId === requester.conversationId);
  const participant = current?.participants.find((candidate) => candidate.id === requester.participantId);
  if (!current || !participant) {
    return undefined;
  }
  const participantConfigId = participant.participantConfigId?.trim();
  if (!participantConfigId) {
    return [current];
  }
  return snapshots.filter((snapshot) => snapshot.participants.some((candidate) =>
    candidate.participantConfigId === participantConfigId
  ));
}

function chatSearchStateMatchesSnapshot(
  state: ChatSearchIndexState | undefined,
  snapshot: ChatSearchConversationSnapshot
): boolean {
  return state?.indexSchemaVersion === 2 &&
    state.sourceTitle === snapshot.title &&
    state.sourceUpdatedAt === snapshot.updatedAt &&
    state.sourceMessageCount === snapshot.messageCount &&
    (state.sourceNewestMessageAt ?? undefined) === (snapshot.newestMessageAt ?? undefined);
}

function sameSourceVersion(
  planned: ChatSearchConversationSnapshot,
  read: ChatSearchConversationSnapshot
): boolean {
  return planned.updatedAt === read.updatedAt &&
    planned.title === read.title &&
    planned.messageCount === read.messageCount &&
    (planned.newestMessageAt ?? undefined) === (read.newestMessageAt ?? undefined);
}

function normalizeLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(parsed)))
    : DEFAULT_SEARCH_LIMIT;
}

function completeCoverage(
  scope: ChatSearchConversationSnapshot[],
  sourceSnapshotAt: string,
  indexedAt: string
): ChatSearchCoverage {
  return {
    eligibleChatCount: scope.length,
    searchedChatCount: scope.length,
    messagePeriod: messagePeriod(scope),
    sourceSnapshotAt,
    indexedAt,
    completeness: "complete"
  };
}

function unavailableResponse(
  scope: ChatSearchConversationSnapshot[],
  sourceSnapshotAt: string,
  errorCode: Extract<ChatSearchResponse, { status: "unavailable" }>["errorCode"],
  failure?: ChatSearchFailureDetail
): ChatSearchResponse {
  return {
    status: "unavailable",
    matches: [],
    coverage: {
      eligibleChatCount: scope.length,
      searchedChatCount: 0,
      messagePeriod: messagePeriod(scope),
      sourceSnapshotAt,
      completeness: "none"
    },
    errorCode,
    ...(failure ? { failure } : {})
  };
}

function messagePeriod(scope: ChatSearchConversationSnapshot[]): { from: string; to: string } | null {
  const oldest = scope.flatMap((snapshot) => snapshot.oldestMessageAt ? [snapshot.oldestMessageAt] : []).sort()[0];
  const newest = scope.flatMap((snapshot) => snapshot.newestMessageAt ? [snapshot.newestMessageAt] : []).sort().at(-1);
  return oldest && newest ? { from: oldest, to: newest } : null;
}

function oldestIndexedAt(states: ChatSearchIndexState[]): string | undefined {
  return states.map((state) => state.indexedAt).filter(Boolean).sort()[0];
}

function stateFromReplacement(replacement: ChatSearchDocumentReplacement): ChatSearchIndexState {
  return {
    conversationId: replacement.snapshot.conversationId,
    sourceTitle: replacement.snapshot.title,
    sourceUpdatedAt: replacement.snapshot.updatedAt,
    sourceMessageCount: replacement.snapshot.messageCount,
    ...(replacement.snapshot.newestMessageAt
      ? { sourceNewestMessageAt: replacement.snapshot.newestMessageAt }
      : {}),
    indexedAt: replacement.indexedAt,
    indexSchemaVersion: 2
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function replacementChunks(replacements: ChatSearchDocumentReplacement[]): ChatSearchDocumentReplacement[][] {
  const result: ChatSearchDocumentReplacement[][] = [];
  let current: ChatSearchDocumentReplacement[] = [];
  let currentChars = 0;
  for (const replacement of replacements) {
    const replacementChars = replacement.documents.reduce(
      (total, document) => total + (document.kind === "message" ? document.body.length : document.titleText.length) + 256,
      256
    );
    if (current.length > 0 &&
      (current.length >= INDEX_WRITE_BATCH_SIZE || currentChars + replacementChars > INDEX_WRITE_BATCH_CHARS)) {
      result.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(replacement);
    currentChars += replacementChars;
  }
  if (current.length > 0) {
    result.push(current);
  }
  return result;
}

function corpusFingerprint(scope: ChatSearchConversationSnapshot[]): string {
  const source = [...scope]
    .sort((left, right) => left.conversationId.localeCompare(right.conversationId))
    .map((snapshot) => [
      snapshot.conversationId,
      snapshot.title,
      snapshot.updatedAt,
      snapshot.messageCount,
      snapshot.newestMessageAt ?? ""
    ])
    .map((parts) => parts.join("\u0000"))
    .join("\u0001");
  return createHash("sha256").update(source).digest("base64url");
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown, matchQuery: string | undefined): SearchCursor | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value || !matchQuery || value.length > 2_000) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SearchCursor>;
    return parsed.version === 2 &&
      parsed.matchQuery === matchQuery &&
      typeof parsed.corpusFingerprint === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(parsed.corpusFingerprint) &&
      Number.isSafeInteger(parsed.offset) &&
      (parsed.offset ?? -1) >= 0
      ? parsed as SearchCursor
      : null;
  } catch {
    return null;
  }
}
