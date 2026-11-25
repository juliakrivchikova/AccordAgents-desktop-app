import type {
  ChatMessage, ChatRunningMessageTarget, Conversation, ListChatActivityRequest, ListChatActivityResult
} from "../../../../shared/types";
import { runningMessageForParticipant, runningMessageTarget } from "../../../../shared/chatRunningMessage";
import {
  DEFAULT_CHAT_ACTIVITY_LIMIT, DEFAULT_CHAT_ACTIVITY_RECENT_CONVERSATION_LIMIT, DEFAULT_CHAT_ACTIVITY_RECENT_WINDOW_DAYS,
  buildChatActivityItems, limitChatActivityItems, sortChatActivityItems
} from "../../../../shared/chatActivity";
import { sessionsTaskTitle, titleTaskByMember } from "../../../../shared/mainSessionView";
import { sanitizeConversationWarnings } from "../../../../shared/warnings";
import {
  clearLegacyAccordState, hasPendingAppToolApprovals, normalizePositiveInteger, pendingApprovalTriggerTargets
} from "../conversations/conversationBody";
import { parseHexJson, parseHexText, sqlString, sqlStringList, sqlStringPairList } from "../database/sqlText";
import type { StorageModules } from "../modules";

/** How many still-pending choices the phone's chat list may carry across
 *  the listed chats before the set is called incomplete. */
const MAX_PENDING_CHOICE_ROWS = 500;

/** The chat state the running-message rule reads (chatActiveRuns.ts):
 *  the chat's members and its run bookkeeping, nothing else of its body. */
const RUNNING_MESSAGE_RUN_STATE_KEYS = [
  "participants",
  "activeRunIds",
  "runId",
  "activeRunOwnersByRunId",
  "activeRunParticipantIdsByRunId",
  "remoteRunHandles"
] as const;

/** Long enough for every hidden "waiting for approval" status the rule
 *  recognises (isParticipantRequestWaitingStatus), which are one sentence. */
const RUNNING_MESSAGE_CONTENT_CHARS = 400;

function decodedRunningMessageContent(value: unknown): string {
  try {
    return parseHexText(value, "a running message");
  } catch {
    return "";
  }
}

/** What Activity and the members panel show. */
export class ChatActivity {
  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  /** The chat's newest messages that give a member a task (a request item
   *  naming it as its target; not the requests it sent itself), read without
   *  the rest of the chat: how the sessions view titles that member
   *  (sessionsMemberTitle, titleTaskByMember). When none of them titles it,
   *  the newest delegation that names it is read as well, so a member with
   *  many follow-ups keeps the title its delegation gave it. */
  async memberTaskMessages(conversationId: string, participantId: string, limit = 5): Promise<ChatMessage[]> {
    await this.storage.schema.init();
    const target = `${JSON.stringify("targetParticipantId")}:${JSON.stringify(participantId)}`;
    const read = async (extra: string, count: number): Promise<ChatMessage[]> => {
      const rows = await this.storage.sqlite.queryJson<{ payloadJson: string }>(
        `select payload_json as payloadJson from conversation_messages
         where conversation_id = ${sqlString(conversationId)}
           and instr(payload_json, '"participantRequest"') > 0
           and instr(payload_json, ${sqlString(target)}) > 0${extra}
         order by sequence desc limit ${Math.max(1, Math.floor(count))};`
      );
      return rows.flatMap((row) => {
        try {
          const message = JSON.parse(row.payloadJson) as ChatMessage;
          return message && typeof message === "object" ? [message] : [];
        } catch {
          return [];
        }
      }).reverse();
    };
    const newest = await read("", limit);
    // The main session's title only: an inferred request's is the app's
    // (titleTaskByMember).
    const titled = newest.some((message) => message.metadata?.participantRequest?.source !== "inferred" &&
      (message.metadata?.participantRequest?.items ?? [])
        .some((item) => item.targetParticipantId === participantId && typeof item.title === "string" && item.title.trim()));
    if (titled) return newest;
    const delegation = await read(` and instr(payload_json, '"delegation"') > 0`, 1);
    return [...delegation.filter((message) => !newest.some((known) => known.id === message.id)), ...newest];
  }

  /** The messages whose choice still waits for the User, in the given chats:
   *  what the phone's chat list carries so a phone can drop a card the
   *  desktop no longer waits on. One query over the listed chats' rows (their
   *  payloads are scanned; a chat's history is never read through the CLI).
   *  Past the cap the set is incomplete and says so, because the phone treats
   *  what it is given as the whole. */
  async listPendingChoiceMessages(conversationIds: string[]): Promise<{
    rows: Array<{ conversationId: string; message: ChatMessage }>;
    truncated: boolean;
  }> {
    await this.storage.schema.init();
    const ids = [...new Set(conversationIds.filter((id) => typeof id === "string" && id.trim()))];
    if (ids.length === 0) {
      return { rows: [], truncated: false };
    }
    const found = await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id in ${sqlStringList(ids)}
          and json_valid(payload_json)
          and json_extract(payload_json, '$.metadata.pendingChoice.status') = 'pending'
        order by created_at desc
        limit ${MAX_PENDING_CHOICE_ROWS + 1};
      `
    );
    const truncated = found.length > MAX_PENDING_CHOICE_ROWS;
    const rows: Array<{ conversationId: string; message: ChatMessage }> = [];
    for (const row of found.slice(0, MAX_PENDING_CHOICE_ROWS)) {
      try {
        rows.push({
          conversationId: row.conversationId,
          message: parseHexJson<ChatMessage>(row.payloadHex, `pending choice message ${row.conversationId}:${row.sequence}`)
        });
      } catch (error) {
        console.warn(`[StorageService] Skipping invalid pending choice message ${row.conversationId}:${row.sequence}: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { rows, truncated };
  }

  async listChatActivity(request: ListChatActivityRequest = {}): Promise<ListChatActivityResult> {
    await this.storage.schema.init();
    const limit = normalizePositiveInteger(request.limit, DEFAULT_CHAT_ACTIVITY_LIMIT);
    const conversationLimit = normalizePositiveInteger(
      request.recentConversationLimit,
      DEFAULT_CHAT_ACTIVITY_RECENT_CONVERSATION_LIMIT
    );
    const recentWindowDays = normalizePositiveInteger(
      request.recentWindowDays,
      DEFAULT_CHAT_ACTIVITY_RECENT_WINDOW_DAYS
    );
    const rows = await this.storage.sqlite.queryJson<{
      id: string;
      bodyHex: string;
    }>(
      `select
         id,
         hex(coalesce(nullif(body_json, ''), json_set(payload_json, '$.messages', json_array()))) as bodyHex
       from conversations
       where kind = 'chat'
         and coalesce(json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.archived'), 0) not in (1, '1', 'true')
       order by updated_at desc
       limit ${conversationLimit};`
    );
    if (rows.length === 0) {
      return { items: [], generatedAt: new Date().toISOString() };
    }

    const conversationsById = new Map<string, Conversation>();
    for (const row of rows) {
      let conversation: Conversation;
      try {
        conversation = parseHexJson<Conversation>(row.bodyHex, `conversation ${row.id}`);
      } catch (error) {
        console.warn(
          `[StorageService] Skipping invalid chat activity conversation ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
      conversation.metadata = clearLegacyAccordState(conversation.metadata);
      conversation.messages = [];
      sanitizeConversationWarnings(conversation);
      conversationsById.set(conversation.id, conversation);
    }
    if (conversationsById.size === 0) {
      return { items: [], generatedAt: new Date().toISOString() };
    }

    const conversationIds = [...conversationsById.keys()];
    const approvalConversationIds = [...conversationsById.values()]
      .filter((conversation) => hasPendingAppToolApprovals(conversation))
      .map((conversation) => conversation.id);
    const approvalTriggerTargets = [...conversationsById.values()].flatMap(pendingApprovalTriggerTargets);
    const messages = await this.activityMessageRows(
      conversationIds,
      conversationLimit,
      approvalConversationIds,
      approvalTriggerTargets
    );
    for (const row of messages) {
      const conversation = conversationsById.get(row.conversationId);
      if (!conversation) {
        continue;
      }
      conversation.messages.push(row.message);
    }
    for (const conversation of conversationsById.values()) {
      conversation.messages.sort((left, right) => {
        const timeDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return timeDelta || left.id.localeCompare(right.id);
      });
    }

    const excludedItemIds = new Set(
      (request.excludedItemIds ?? [])
        .filter((itemId): itemId is string => typeof itemId === "string" && itemId.trim().length > 0)
        .slice(-1_000)
    );
    const preferences = {
      clearedItemIds: excludedItemIds,
      ...(request.clearedRecentThroughByGroup ? { clearedRecentThroughByGroup: request.clearedRecentThroughByGroup } : {}),
      ...(request.clearedRecentThroughBefore ? { clearedRecentThroughBefore: request.clearedRecentThroughBefore } : {})
    };
    const knownTitles = await this.activitySessionsTitles([...conversationsById.values()]);
    const items = [...conversationsById.values()].flatMap((conversation) =>
      buildChatActivityItems(conversation, {
        recentWindowDays,
        lastViewedAt: request.lastViewedAtByConversationId?.[conversation.id],
        preferences,
        ...(knownTitles.has(conversation.id) ? { knownTitles: knownTitles.get(conversation.id) } : {})
      })
    );
    return {
      items: limitChatActivityItems(sortChatActivityItems(items), limit),
      generatedAt: new Date().toISOString()
    };
  }

  /** The member messages still in progress that answer these turns (the
   *  member and the message each turn answers), wherever they are in the
   *  chat. Read from the earliest of those messages on, not the whole chat;
   *  few and small (a turn's message holds only its placeholder until it
   *  ends). A dead message of another turn is never one of them. */
  async listPendingTurnMessages(
    conversationId: string,
    turns: Array<{ messageId: string; participantId: string }>
  ): Promise<ChatMessage[]> {
    if (turns.length === 0) return [];
    await this.storage.schema.init();
    const asked = [...new Set(turns.map((turn) => turn.messageId))].slice(0, 200);
    const [first] = await this.storage.sqlite.queryJson<{ sequence: number | null }>(
      `select min(sequence) as sequence from conversation_messages
        where conversation_id = ${sqlString(conversationId)} and message_id in (${asked.map(sqlString).join(", ")});`
    );
    if (typeof first?.sequence !== "number") return [];
    const rows = await this.storage.sqlite.queryJson<{ sequence: number; payloadHex: string }>(
      `
        select sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id = ${sqlString(conversationId)}
          and sequence >= ${Math.max(0, Math.floor(first.sequence))}
          and payload_json like '%"status":"pending"%'
          and json_valid(payload_json)
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.status') = 'pending'
        order by sequence;
      `
    );
    const wanted = new Set(turns.map((turn) => `${turn.participantId}\u0000${turn.messageId}`));
    return rows
      .map((row) => parseHexJson<ChatMessage>(row.payloadHex, `pending message ${conversationId}:${row.sequence}`))
      .filter((message) => {
        const answers = message.metadata?.sourceMessageId || message.metadata?.parentMessageId;
        return Boolean(message.participantId && answers) && wanted.has(`${message.participantId}\u0000${answers}`);
      });
  }

  /** The member's turn in progress (see runningMessageForParticipant), found
   *  in the whole chat: an open chat holds only its latest page, and a long
   *  turn's message can be far above it. Reads only the chat's run state and,
   *  of its pending member messages, the run fields plus the first characters
   *  of their text (to recognise a hidden "waiting for approval" status), so
   *  the answer stays a handful of short rows on any chat. */
  async findRunningParticipantMessage(conversationId: string, participantId: string): Promise<ChatRunningMessageTarget | undefined> {
    await this.storage.schema.init();
    const body = `coalesce(nullif(body_json, ''), payload_json)`;
    const runStateJson = await this.storage.sqlite.queryText(
      `
        select json_object(${RUNNING_MESSAGE_RUN_STATE_KEYS.map((key) =>
          `${sqlString(key)}, json_extract(${body}, ${sqlString(`$.metadata.${key}`)})`).join(", ")})
        from conversations
        where id = ${sqlString(conversationId)} and json_valid(${body})
        limit 1;
      `
    );
    if (!runStateJson) {
      return undefined;
    }
    const metadata = JSON.parse(runStateJson) as Conversation["metadata"];
    const rows = await this.storage.sqlite.queryJson<{
      id: string;
      participantId: string | null;
      createdAt: string | null;
      runId: string | null;
      queued: number;
      chatThreadRootId: string | null;
      hiddenFromTimeline: number | null;
      contentHex: string | null;
    }>(
      `
        select
          message_id as id,
          json_extract(payload_json, '$.participantId') as participantId,
          json_extract(payload_json, '$.createdAt') as createdAt,
          json_extract(payload_json, '$.metadata.runId') as runId,
          json_extract(payload_json, '$.metadata.queuedBehind') is not null as queued,
          json_extract(payload_json, '$.metadata.chatThreadRootId') as chatThreadRootId,
          json_extract(payload_json, '$.metadata.hiddenFromTimeline') as hiddenFromTimeline,
          hex(substr(json_extract(payload_json, '$.content'), 1, ${RUNNING_MESSAGE_CONTENT_CHARS})) as contentHex
        from conversation_messages
        where conversation_id = ${sqlString(conversationId)}
          and payload_json like '%"status":"pending"%'
          and json_valid(payload_json)
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.status') = 'pending'
        order by sequence;
      `
    );
    const messages: ChatMessage[] = rows.flatMap((row) => typeof row.id === "string" && row.id ? [{
      id: row.id,
      role: "participant" as const,
      status: "pending" as const,
      ...(typeof row.participantId === "string" ? { participantId: row.participantId } : {}),
      content: decodedRunningMessageContent(row.contentHex),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      metadata: {
        ...(typeof row.runId === "string" ? { runId: row.runId } : {}),
        ...(row.queued ? { queuedBehind: { handle: "" } } : {}),
        ...(typeof row.chatThreadRootId === "string" ? { chatThreadRootId: row.chatThreadRootId } : {}),
        ...(row.hiddenFromTimeline ? { hiddenFromTimeline: true } : {})
      }
    }] : []);
    const running = runningMessageForParticipant({ metadata, messages }, participantId);
    return running ? runningMessageTarget(running) : undefined;
  }

  /** The task titles of the members of chats shown in the sessions view, by
   *  chat and member: Activity names a member by its task there, and the
   *  rows it reads hold only recent messages. Each chat's newest 40 task
   *  messages (request messages) are read, nothing else. */
  private async activitySessionsTitles(conversations: Conversation[]): Promise<Map<string, Map<string, string>>> {
    const sessionsChats = conversations.filter((conversation) =>
      Boolean(conversation.metadata?.mainSessionParticipantId) && (conversation.metadata?.chatView ?? "sessions") === "sessions");
    const result = new Map<string, Map<string, string>>();
    if (sessionsChats.length === 0) return result;
    // Only the request of each message is read, not its whole payload.
    const rows = await this.storage.sqlite.queryJson<{ conversationId: string; requestHex: string | null }>(
      `select conversationId, hex(requestJson) as requestHex from (
         select conversation_id as conversationId, json_extract(payload_json, '$.metadata.participantRequest') as requestJson,
           row_number() over (partition by conversation_id order by sequence desc) as rank
         from conversation_messages
         where conversation_id in ${sqlStringList(sessionsChats.map((conversation) => conversation.id))}
           and instr(payload_json, '"participantRequest"') > 0
       ) where rank <= 40 and requestJson is not null;`
    ).catch((error: unknown) => {
      console.warn(`[StorageService] Activity task titles could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const messagesByChat = new Map<string, ChatMessage[]>();
    for (const row of rows) {
      if (!row.requestHex) continue;
      try {
        const participantRequest = parseHexJson<NonNullable<NonNullable<ChatMessage["metadata"]>["participantRequest"]>>(row.requestHex, `activity task ${row.conversationId}`);
        const list = messagesByChat.get(row.conversationId) ?? [];
        list.push({ id: participantRequest.id, role: "participant", content: "", createdAt: participantRequest.createdAt, status: "done", metadata: { participantRequest } } as ChatMessage);
        messagesByChat.set(row.conversationId, list);
      } catch {
        // A request that does not read names nobody.
      }
    }
    for (const conversation of sessionsChats) {
      const tasks = titleTaskByMember(messagesByChat.get(conversation.id) ?? []);
      const titles = new Map<string, string>();
      for (const [participantId, task] of tasks) titles.set(participantId, sessionsTaskTitle(task.item) || "");
      for (const [participantId, title] of titles) if (!title) titles.delete(participantId);
      if (titles.size > 0) result.set(conversation.id, titles);
    }
    return result;
  }

  private async activityMessageRows(
    conversationIds: string[],
    conversationLimit: number,
    approvalConversationIds: string[] = [],
    approvalTriggerTargets: Array<[string, string]> = []
  ): Promise<{ conversationId: string; sequence: number; message: ChatMessage }[]> {
    const idList = sqlStringList(conversationIds);
    const pendingRows = await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id in ${idList}
          and (
            json_extract(payload_json, '$.metadata.pendingChoice.status') = 'pending'
            or exists (
              select 1
              from json_each(payload_json, '$.metadata.pendingMentions') as mention
              where json_extract(mention.value, '$.status') = 'pending'
            )
            or json_extract(payload_json, '$.metadata.participantRequest.status') = 'pending_approval'
          )
        order by created_at desc;
      `
    );
    const pendingParticipantRows = await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id in ${idList}
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.status') = 'pending'
          and json_extract(payload_json, '$.metadata.runId') is not null
        order by created_at desc
        limit ${Math.max(DEFAULT_CHAT_ACTIVITY_LIMIT, conversationLimit * 2)};
      `
    );
    const participantRows = await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversationId, sequence, hex(payloadJson) as payloadHex
        from (
          select
            conversation_id as conversationId,
            sequence,
            payload_json as payloadJson,
            row_number() over (
              partition by
                conversation_id,
                coalesce(
                  nullif(json_extract(payload_json, '$.participantId'), ''),
                  lower(nullif(json_extract(payload_json, '$.participantLabel'), '')),
                  message_id
                )
              order by created_at desc
            ) as rowNumber
          from conversation_messages
          where conversation_id in ${idList}
            and json_extract(payload_json, '$.role') = 'participant'
            and json_extract(payload_json, '$.status') = 'done'
            and coalesce(json_extract(payload_json, '$.metadata.hiddenFromTimeline'), 0) not in (1, '1', 'true')
        )
        where rowNumber <= 8
        order by json_extract(payloadJson, '$.createdAt') desc
        limit ${Math.max(DEFAULT_CHAT_ACTIVITY_LIMIT * 4, conversationLimit * 16)};
      `
    );
    const approvalContextRows = approvalConversationIds.length > 0
      ? await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
        `
          select conversationId, sequence, hex(payloadJson) as payloadHex
          from (
            select
              conversation_id as conversationId,
              sequence,
              payload_json as payloadJson,
              row_number() over (partition by conversation_id order by created_at desc) as rowNumber
            from conversation_messages
            where conversation_id in ${sqlStringList(approvalConversationIds)}
              and coalesce(json_extract(payload_json, '$.role'), '') != 'system'
          )
          where rowNumber <= 48
          order by conversationId, sequence;
        `
      )
      : [];
    const approvalTriggerRows = approvalTriggerTargets.length > 0
      ? await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
        `
          select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
          from conversation_messages
          where (conversation_id, message_id) in ${sqlStringPairList(approvalTriggerTargets)};
        `
      )
      : [];
    const decodeRows = (
      rows: Array<{ conversationId: string; sequence: number; payloadHex: string }>,
      context: string
    ) => rows.map((row) => ({
      conversationId: row.conversationId,
      sequence: row.sequence,
      message: parseHexJson<ChatMessage>(
        row.payloadHex,
        `${context} ${row.conversationId}:${row.sequence}`
      )
    }));
    const decodedPendingRows = decodeRows(pendingRows, "pending activity message");
    const decodedPendingParticipantRows = decodeRows(pendingParticipantRows, "pending participant activity message");
    const decodedParticipantRows = decodeRows(participantRows, "participant activity message");
    const decodedApprovalContextRows = decodeRows(approvalContextRows, "approval context message");
    const decodedApprovalTriggerRows = decodeRows(approvalTriggerRows, "approval trigger message");
    const activitySourceTargets = [
      ...decodedPendingRows,
      ...decodedPendingParticipantRows,
      ...decodedApprovalTriggerRows
    ].flatMap((row) => {
      const ids = [row.message.metadata?.sourceMessageId, row.message.metadata?.parentMessageId, row.message.metadata?.chatThreadRootId]
        .flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []);
      return [...new Set(ids)].map((messageId) => [row.conversationId, messageId] as [string, string]);
    });
    const activitySourceRows = activitySourceTargets.length > 0
      ? await this.storage.sqlite.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
        `
          select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
          from conversation_messages
          where (conversation_id, message_id) in ${sqlStringPairList(activitySourceTargets)};
        `
      )
      : [];
    const decodedSourceRows = activitySourceRows.map((row) => ({
      conversationId: row.conversationId,
      sequence: row.sequence,
      message: parseHexJson<ChatMessage>(
        row.payloadHex,
        `activity source message ${row.conversationId}:${row.sequence}`
      )
    }));
    const byKey = new Map<string, { conversationId: string; sequence: number; message: ChatMessage }>();
    for (const row of [
      ...decodedPendingRows,
      ...decodedPendingParticipantRows,
      ...decodedParticipantRows,
      ...decodedApprovalContextRows,
      ...decodedApprovalTriggerRows,
      ...decodedSourceRows
    ]) {
      byKey.set(`${row.conversationId}:${row.sequence}`, row);
    }
    return [...byKey.values()];
  }
}
