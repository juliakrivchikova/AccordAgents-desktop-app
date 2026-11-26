import type { ChatMessage, ChatRunningMessageTarget, Conversation } from "../../../../shared/types";
import { runningMessageForParticipant, runningMessageTarget } from "../../../../shared/chatRunningMessage";
import { parseHexJson, parseHexText, sqlString, sqlStringList } from "../database/sqlText";
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

/** What the members panel and the phone's chat list read: a member's tasks,
 *  its turn in progress, the choices still waiting. */
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
}
