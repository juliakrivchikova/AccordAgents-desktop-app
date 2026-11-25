import type {
  ChatForkSeenReply, ChatMessage, ChatParticipantRequestBatch, Conversation, ConversationMessagePage,
  ConversationMessagePageRequest, ConversationOpenResult
} from "../../../../shared/types";
import { sanitizeConversationWarnings } from "../../../../shared/warnings";
import { forkSeenReplyOf, isMemberTurnEnd } from "../../../../shared/forkToNewChat";
import type { ForkReplyView } from "../../../../shared/forkToNewChat";
import { clearLegacyAccordState, messagePageInfo, normalizeMessagePageLimit } from "./conversationBody";
import { parseHexJson, sqlString, sqlStringList } from "../database/sqlText";
import type { StorageModules } from "../modules";

/** Reads one conversation, or a page of its messages. */
export class ConversationReads {
  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  /** A chat's kind, project folder and members, without its messages or
   *  the rest of its body (members' memory asks this on every request); its
   *  main session and view, for how the server words what it sends outside
   *  (an urgent alert names nobody by handle in the sessions view). */
  async conversationAccess(id: string): Promise<{ kind: string; repoPath?: string; participants: unknown[]; mainSessionParticipantId?: string; chatView?: string } | undefined> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ kind: string; repoPath: string | null; participantsJson: string | null; mainSessionParticipantId: string | null; chatView: string | null }>(
      `select kind, repo_path as repoPath,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.participants') as participantsJson,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.mainSessionParticipantId') as mainSessionParticipantId,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.chatView') as chatView
       from conversations where id = ${sqlString(id)};`
    );
    const row = rows[0];
    if (!row) return undefined;
    let participants: unknown[] = [];
    try {
      const parsed = row.participantsJson ? JSON.parse(row.participantsJson) as unknown : [];
      if (Array.isArray(parsed)) participants = parsed;
    } catch {
      participants = [];
    }
    return {
      kind: row.kind,
      ...(row.repoPath ? { repoPath: row.repoPath } : {}),
      participants,
      ...(typeof row.mainSessionParticipantId === "string" && row.mainSessionParticipantId ? { mainSessionParticipantId: row.mainSessionParticipantId } : {}),
      ...(typeof row.chatView === "string" && row.chatView ? { chatView: row.chatView } : {})
    };
  }

  /** A chat's member requests, oldest first, each only its batch (not the
   *  rest of its message): the whole history's tasks, read once to give the
   *  members made before titles were kept with them theirs. */
  async chatRequestBatches(conversationId: string): Promise<ChatParticipantRequestBatch[]> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ requestHex: string | null }>(
      `select hex(json_extract(payload_json, '$.metadata.participantRequest')) as requestHex from conversation_messages
       where conversation_id = ${sqlString(conversationId)}
         and instr(payload_json, '"participantRequest"') > 0
       order by sequence asc;`
    );
    return rows.flatMap((row) => {
      if (!row.requestHex) return [];
      try {
        const batch = parseHexJson<ChatParticipantRequestBatch>(row.requestHex, `request batches ${conversationId}`);
        return batch && typeof batch === "object" && Array.isArray(batch.items) ? [batch] : [];
      } catch {
        return [];
      }
    });
  }

  /** A chat's member session records (this device's own), without its
   *  messages: a main session made by Fork to new chat reads the session of
   *  the member it copies from that member's chat, which can be thousands of
   *  messages long. `undefined` when no such chat is stored. */
  async conversationParticipantSessions(id: string): Promise<unknown[] | undefined> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ kind: string; sessionsJson: string | null }>(
      `select kind,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.participantSessions') as sessionsJson
       from conversations where id = ${sqlString(id)};`
    );
    const row = rows[0];
    if (!row || row.kind !== "chat") return undefined;
    try {
      const parsed = row.sessionsJson ? JSON.parse(row.sessionsJson) as unknown : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** The titles of the chats named (those this device still has). */
  async conversationTitles(ids: readonly string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    await this.storage.schema.init();
    // sqlStringList is already parenthesized: one more pair makes a row value
    // that sqlite refuses as soon as there are two ids.
    const rows = await this.storage.sqlite.queryJson<{ id: string; title: string }>(`select id, title from conversations where id in ${sqlStringList(ids)};`);
    return Object.fromEntries(rows.map((row) => [row.id, row.title]));
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    await this.storage.schema.init();
    return this.readWholeConversation(id);
  }

  /** A chat's project folder, without reading a conversation that can be
   *  thousands of messages long. `undefined` when the chat is not stored. */
  async conversationRepoPath(id: string): Promise<{ repoPath?: string } | undefined> {
    await this.storage.schema.init();
    const [row] = await this.storage.sqlite.queryJson<{ repoPath: string | null }>(
      `select repo_path as repoPath from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!row) return undefined;
    return typeof row.repoPath === "string" && row.repoPath.trim() ? { repoPath: row.repoPath } : {};
  }

  /** Whether a chat is stored here (and holds one message), without reading
   *  a conversation that can be thousands of messages long. */
  async conversationPresence(id: string, messageId?: string): Promise<{ kind: Conversation["kind"]; hasMessage: boolean } | undefined> {
    await this.storage.schema.init();
    const hasMessage = messageId
      ? `exists(select 1 from conversation_messages where conversation_id = ${sqlString(id)} and message_id = ${sqlString(messageId)})`
      : "0";
    const [row] = await this.storage.sqlite.queryJson<{ kind: Conversation["kind"]; hasMessage: number }>(
      `select kind, ${hasMessage} as hasMessage from conversations where id = ${sqlString(id)} limit 1;`
    );
    return row ? { kind: row.kind, hasMessage: Boolean(row.hasMessage) } : undefined;
  }

  // The conversation is assembled from its body plus its message rows. The old
  // full `payload_json` copy is no longer written — it duplicated everything the
  // rows already hold, and rewriting it cost megabytes on every save — so it is
  // only read for rows that predate this change and have no body yet.
  async readWholeConversation(id: string): Promise<Conversation | undefined> {
    const bodyJson = await this.storage.sqlite.queryText(
      `select coalesce(nullif(body_json, ''), payload_json) from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!bodyJson) {
      return undefined;
    }
    const conversation = JSON.parse(bodyJson) as Conversation;
    const rows = await this.readAllConversationMessages(id);
    // No rows but the parsed copy has messages means this row still predates the
    // split and was never backfilled — that legacy payload is then the only
    // place the messages exist, so it wins. Anything else takes the rows.
    const legacyPayloadIsTheOnlySource = rows.length === 0 &&
      Array.isArray(conversation.messages) &&
      conversation.messages.length > 0;
    if (!legacyPayloadIsTheOnlySource) {
      conversation.messages = rows;
    }
    conversation.metadata = clearLegacyAccordState(conversation.metadata);
    sanitizeConversationWarnings(conversation);
    return conversation;
  }

  private async readAllConversationMessages(id: string): Promise<ChatMessage[]> {
    // By lines: a long chat's messages are more than one string can hold.
    const lines = await this.storage.sqlite.queryLines(
      `
        select sequence || '|' || hex(payload_json)
        from conversation_messages
        where conversation_id = ${sqlString(id)}
        order by sequence;
      `
    );
    return lines.map((line) => {
      const mark = line.indexOf("|");
      return parseHexJson<ChatMessage>(line.slice(mark + 1), `conversation message ${id}:${line.slice(0, mark)}`);
    });
  }

  async openConversation(
    id: string,
    limit?: number,
    page?: { beforeMessageId?: string }
  ): Promise<ConversationOpenResult | undefined> {
    await this.storage.schema.init();
    const bodyJson = await this.storage.sqlite.queryText(
      `select coalesce(nullif(body_json, ''), payload_json) from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!bodyJson) {
      return undefined;
    }
    const conversation = JSON.parse(bodyJson) as Conversation;
    conversation.metadata = clearLegacyAccordState(conversation.metadata);
    sanitizeConversationWarnings(conversation);
    const messagePage = await this.listConversationMessages({
      conversationId: id,
      limit,
      ...(page?.beforeMessageId ? { beforeMessageId: page.beforeMessageId } : {})
    });
    return {
      conversation: {
        ...conversation,
        messages: messagePage.messages
      },
      messagePage: messagePageInfo(messagePage)
    };
  }

  async listConversationMessages(request: ConversationMessagePageRequest): Promise<ConversationMessagePage> {
    await this.storage.schema.init();
    const limit = normalizeMessagePageLimit(request.limit);
    const aroundMessageId = typeof request.aroundMessageId === "string" ? request.aroundMessageId.trim() : "";
    const beforeMessageId = typeof request.beforeMessageId === "string" ? request.beforeMessageId.trim() : "";
    let sequenceClause = "";
    if (beforeMessageId) {
      // Strictly before a message the reader already holds. An unknown id
      // answers with nothing rather than the latest page: the reader asked
      // for older history, and the latest page is not that.
      const targetRows = await this.storage.sqlite.queryJson<{ sequence: number }>(
        `
          select sequence
          from conversation_messages
          where conversation_id = ${sqlString(request.conversationId)}
            and message_id = ${sqlString(beforeMessageId)}
          limit 1;
        `
      );
      const targetSequence = targetRows[0]?.sequence;
      if (targetSequence === undefined) {
        const countRows = await this.storage.sqlite.queryJson<{ totalMessages: number }>(
          `select count(*) as totalMessages from conversation_messages where conversation_id = ${sqlString(request.conversationId)};`
        );
        return {
          messages: [],
          hasMoreBefore: false,
          totalMessages: countRows[0]?.totalMessages ?? 0
        };
      }
      sequenceClause = ` and sequence < ${Math.max(0, Math.floor(targetSequence))}`;
    } else if (aroundMessageId) {
      const targetRows = await this.storage.sqlite.queryJson<{ sequence: number }>(
        `
          select sequence
          from conversation_messages
          where conversation_id = ${sqlString(request.conversationId)}
            and message_id = ${sqlString(aroundMessageId)}
          limit 1;
        `
      );
      const targetSequence = targetRows[0]?.sequence;
      if (targetSequence === undefined) {
        const countRows = await this.storage.sqlite.queryJson<{ totalMessages: number }>(
          `select count(*) as totalMessages from conversation_messages where conversation_id = ${sqlString(request.conversationId)};`
        );
        return {
          messages: [],
          hasMoreBefore: false,
          totalMessages: countRows[0]?.totalMessages ?? 0
        };
      }
      sequenceClause = ` and sequence <= ${Math.max(0, Math.floor(targetSequence))}`;
    } else if (typeof request.beforeSequence === "number") {
      sequenceClause = ` and sequence < ${Math.max(0, Math.floor(request.beforeSequence))}`;
    }
    const rows = await this.storage.sqlite.queryJson<{ sequence: number; payloadHex: string }>(
      `
        select sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id = ${sqlString(request.conversationId)}${sequenceClause}
        order by sequence desc
        limit ${limit + 1};
      `
    );
    const selectedRows = rows.slice(0, limit).reverse();
    const countRows = await this.storage.sqlite.queryJson<{ totalMessages: number }>(
      `select count(*) as totalMessages from conversation_messages where conversation_id = ${sqlString(request.conversationId)};`
    );
    return {
      messages: selectedRows.map((row) =>
        parseHexJson<ChatMessage>(row.payloadHex, `conversation message ${request.conversationId}:${row.sequence}`)
      ),
      oldestSequence: selectedRows[0]?.sequence,
      newestSequence: selectedRows[selectedRows.length - 1]?.sequence,
      hasMoreBefore: rows.length > limit,
      totalMessages: countRows[0]?.totalMessages ?? selectedRows.length
    };
  }

  /** Whether a member has a finished reply in a chat (the rule of
   *  isFinishedMemberReply): it ran there, so its device holds a session to
   *  fork (Fork to new chat from the phone). Read newest first, stopping at
   *  the first; a member that never answered reads the chat's messages once
   *  (when the phone's menu opens, never per list). */
  async conversationParticipantAnswered(conversationId: string, participantId: string): Promise<boolean> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ found: number }>(
      `select 1 as found from conversation_messages
        where conversation_id = ${sqlString(conversationId)}
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.participantId') = ${sqlString(participantId)}
          and coalesce(json_extract(payload_json, '$.status'), '') <> 'pending'
          and coalesce(json_extract(payload_json, '$.metadata.serverPlaceholder'), 0) <> 1
        order by sequence desc limit 1;`
    );
    return rows.length > 0;
  }

  /** The member's newest reply that ended a turn of its CLI (the rule of
   *  isMemberTurnEnd), as Fork to new chat keeps it (forkSeenReplyOf): where
   *  the copy ends. Read newest first, stopping at the first, and only the
   *  fields the cut needs (a reply can carry a long transcript). */
  async conversationLastTurnEnd(conversationId: string, participantId: string): Promise<ChatForkSeenReply | undefined> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ id: string; createdAt?: string; turnStartedAt?: string; workedMs?: number; sessionCut?: string }>(
      `select message_id as id,
              json_extract(payload_json, '$.createdAt') as createdAt,
              json_extract(payload_json, '$.metadata.turnStartedAt') as turnStartedAt,
              json_extract(payload_json, '$.metadata.workedMs') as workedMs,
              json_extract(payload_json, '$.metadata.sessionCut') as sessionCut
         from conversation_messages
        where conversation_id = ${sqlString(conversationId)}
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.participantId') = ${sqlString(participantId)}
          and coalesce(json_extract(payload_json, '$.status'), '') <> 'pending'
          and coalesce(json_extract(payload_json, '$.metadata.serverPlaceholder'), 0) <> 1
          and (json_type(payload_json, '$.metadata.workedMs') in ('integer', 'real')
            or (json_type(payload_json, '$.metadata.sessionCut.sessionId') = 'text'
              and json_type(payload_json, '$.metadata.sessionCut.at') = 'text'))
        order by sequence desc limit 20;`
    );
    // The first that ends a turn by the shared rule (the query narrows to
    // the same, but a cut it cannot use is skipped, as on the phone's view).
    for (const row of rows) {
      const seen = this.lastTurnEndRow(row, participantId);
      if (seen) return seen;
    }
    return undefined;
  }

  private lastTurnEndRow(row: { id: string; createdAt?: string; turnStartedAt?: string; workedMs?: number; sessionCut?: string }, participantId: string): ChatForkSeenReply | undefined {
    if (!row || typeof row.id !== "string") return undefined;
    let sessionCut: unknown;
    try {
      sessionCut = typeof row.sessionCut === "string" ? JSON.parse(row.sessionCut) : undefined;
    } catch {
      sessionCut = undefined;
    }
    const view: ForkReplyView = {
      id: row.id,
      role: "participant",
      participantId,
      ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
      metadata: {
        ...(typeof row.turnStartedAt === "string" ? { turnStartedAt: row.turnStartedAt } : {}),
        ...(typeof row.workedMs === "number" ? { workedMs: row.workedMs } : {}),
        ...(sessionCut !== undefined ? { sessionCut } : {})
      }
    };
    return isMemberTurnEnd(view, participantId) ? forkSeenReplyOf(view) : undefined;
  }

  /** One message of a chat by its id: a single read through the chat's
   *  message-id index, for readers that need nothing around it. */
  async conversationMessageById(conversationId: string, messageId: string): Promise<ChatMessage | undefined> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ sequence: number; payloadHex: string }>(
      `select sequence, hex(payload_json) as payloadHex from conversation_messages
        where conversation_id = ${sqlString(conversationId)} and message_id = ${sqlString(messageId)} limit 1;`
    );
    return rows[0] ? parseHexJson<ChatMessage>(rows[0].payloadHex, `message ${conversationId}:${rows[0].sequence}`) : undefined;
  }
}
