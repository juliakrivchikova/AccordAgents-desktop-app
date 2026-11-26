import type { ConversationSummary } from "../../../../shared/types";
import { conversationSummaryMainSessionKind, normalizeConversationSummaryChatParticipants } from "../../../../shared/conversationSummary";
import { pendingReplyRowHintSql } from "../constants";
import { sqlString } from "../database/sqlText";
import type { ChatMemberProviderRow } from "../types";
import type { StorageModules } from "../modules";

/** Lists conversations and finds those in a given state. */
export class ConversationLists {
  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  async listConversations(): Promise<ConversationSummary[]> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{
      id: string;
      title: string;
      kind: ConversationSummary["kind"];
      createdAt: string;
      updatedAt: string;
      repoPath?: string;
      running?: number | string | boolean | null;
      archived?: number | string | boolean | null;
      pinned?: number | string | boolean | null;
      pinnedAt?: string | null;
      activeRunIdsCount?: number | string | null;
      replyPending?: number | string | null;
      waitingChoice?: number | string | null;
      chatParticipantsJson?: string | null;
      mainSessionParticipantId?: string | null;
    }>(
      // Besides this device's runs, whether a member's reply has not ended
      // (`isPendingReply`): a machine member's turn asked from the phone runs
      // with no run here at all, and the reply is the only sign of it.
      `select
         id,
         title,
         kind,
         created_at as createdAt,
         updated_at as updatedAt,
         repo_path as repoPath,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.running') as running,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.archived') as archived,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.pinned') as pinned,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.pinnedAt') as pinnedAt,
         coalesce(json_array_length(coalesce(nullif(body_json, ''), payload_json), '$.metadata.activeRunIds'), 0) as activeRunIdsCount,
         exists (
           select 1 from conversation_messages m
           where m.conversation_id = conversations.id
             and ${pendingReplyRowHintSql("m.payload_json")}
             and json_valid(m.payload_json)
             and json_extract(m.payload_json, '$.status') = 'pending'
             and json_extract(m.payload_json, '$.role') = 'participant'
         ) as replyPending,
         exists (
           select 1 from conversation_messages m
           where m.conversation_id = conversations.id
             and ${pendingReplyRowHintSql("m.payload_json")}
             and json_valid(m.payload_json)
             and json_extract(m.payload_json, '$.role') = 'participant'
             and json_extract(m.payload_json, '$.metadata.pendingChoice.status') = 'pending'
             and coalesce(json_extract(m.payload_json, '$.metadata.serverCard.state'), '') <> 'answered'
         ) as waitingChoice,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.participants') as chatParticipantsJson,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.mainSessionParticipantId') as mainSessionParticipantId
       from conversations
       order by updated_at desc;`
    );
    return rows.map((row) => {
      const activeCount = typeof row.activeRunIdsCount === "string"
        ? Number.parseInt(row.activeRunIdsCount, 10) || 0
        : (row.activeRunIdsCount ?? 0);
      const runningFlag = row.running === 1 || row.running === "1" || row.running === true || row.running === "true";
      const replyPending = row.replyPending === 1 || row.replyPending === "1";
      const isRunning = activeCount > 0 || runningFlag;
      const isArchived = row.archived === 1 || row.archived === "1" || row.archived === true || row.archived === "true";
      const isPinned = row.pinned === 1 || row.pinned === "1" || row.pinned === true || row.pinned === "true";
      const waitingChoice = row.waitingChoice === 1 || row.waitingChoice === "1";
      const chatParticipants = row.kind === "chat"
        ? normalizeConversationSummaryChatParticipants(row.chatParticipantsJson)
        : undefined;
      const mainSessionKind = row.kind === "chat"
        ? conversationSummaryMainSessionKind(row.chatParticipantsJson, row.mainSessionParticipantId)
        : undefined;
      return {
        id: row.id,
        title: row.title,
        kind: row.kind,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        repoPath: row.repoPath ?? undefined,
        running: isRunning,
        ...(replyPending ? { replyPending: true } : {}),
        archived: isArchived,
        ...(isPinned ? { pinned: true, ...(typeof row.pinnedAt === "string" && row.pinnedAt ? { pinnedAt: row.pinnedAt } : {}) } : {}),
        ...(waitingChoice ? { waitingChoice: true } : {}),
        ...(chatParticipants ? { chatParticipants } : {}),
        ...(mainSessionKind ? { mainSessionKind } : {})
      };
    });
  }

  /** The CLI sessions the chats already hold, by chat: every member's
   *  session id and every imported main session's thread, for the CLI import
   *  to open a thread's chat rather than make a second one (a session id can
   *  change after a turn, and a move takes the record away). No message is
   *  read. */
  async listChatCliSessions(): Promise<Array<{ conversationId: string; sessionId: string }>> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ conversationId?: unknown; sessionId?: unknown }>(
      `select c.id as conversationId, json_extract(s.value, '$.sessionId') as sessionId
         from conversations c, json_each(coalesce(nullif(c.body_json, ''), c.payload_json), '$.metadata.participantSessions') s
        where c.kind = 'chat' and json_valid(coalesce(nullif(c.body_json, ''), c.payload_json))
       union
       select c.id as conversationId, json_extract(p.value, '$.importOrigin.sessionId') as sessionId
         from conversations c, json_each(coalesce(nullif(c.body_json, ''), c.payload_json), '$.metadata.participants') p
        where c.kind = 'chat' and json_valid(coalesce(nullif(c.body_json, ''), c.payload_json));`
    );
    return rows.flatMap((row) => typeof row.conversationId === "string" && typeof row.sessionId === "string" && row.sessionId.trim()
      ? [{ conversationId: row.conversationId, sessionId: row.sessionId.trim() }] : []);
  }

  /** Each chat's members, as the runtime fields that say which provider they
   *  run on (the CLI and any added provider) and their role (to tell the
   *  Assistant apart), for the usage signals. One
   *  query over the chats' own rows, the same body the chat list reads, that
   *  returns only those fields; no message is read, and a chat whose
   *  row cannot be read is left out rather than failing the rest. */
  async listChatMemberProviders(): Promise<Array<Array<ChatMemberProviderRow>>> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ id: string; kind?: unknown; hostId?: unknown; hostVendor?: unknown; roleConfigId?: unknown; participantConfigId?: unknown; handle?: unknown; behaviorRuleCount?: unknown; member?: number | null }>(
      `select c.id as id,
              json_extract(p.value, '$.kind') as kind,
              json_extract(p.value, '$.hostId') as hostId,
              json_extract(p.value, '$.hostVendor') as hostVendor,
              json_extract(p.value, '$.roleConfigId') as roleConfigId,
              json_extract(p.value, '$.participantConfigId') as participantConfigId,
              json_extract(p.value, '$.handle') as handle,
              coalesce(json_array_length(p.value, '$.behaviorRuleIds'), 0) as behaviorRuleCount,
              p.key as member
       from (
         select id, coalesce(nullif(body_json, ''), payload_json) as body
         from conversations
         where kind = 'chat' and json_valid(coalesce(nullif(body_json, ''), payload_json))
       ) c
       left join json_each(
         case when json_type(c.body, '$.metadata.participants') = 'array' then c.body else '{"metadata":{"participants":[]}}' end,
         '$.metadata.participants'
       ) p
       order by c.id;`
    );
    const chats = new Map<string, Array<ChatMemberProviderRow>>();
    for (const row of rows) {
      const members = chats.get(row.id) ?? [];
      if (row.member !== null && row.member !== undefined) {
        members.push({
          kind: row.kind ?? undefined,
          hostId: row.hostId ?? undefined,
          hostVendor: row.hostVendor ?? undefined,
          roleConfigId: row.roleConfigId ?? undefined,
          participantConfigId: row.participantConfigId ?? undefined,
          handle: row.handle ?? undefined,
          behaviorRuleCount: typeof row.behaviorRuleCount === "number" ? row.behaviorRuleCount : 0
        });
      }
      chats.set(row.id, members);
    }
    return [...chats.values()];
  }

  /** The chats with a User message written since `since` (the weekly usage
   *  snapshot), each with what decides the view it is shown in
   *  (shared/mainSession.ts chatViewFor): its main session, whether that is
   *  still a member, and its view. One query over the chat rows; a message's
   *  body is looked at only for rows written since then. */
  async listChatViewsWithUserMessagesSince(since: string): Promise<Array<{ mainSessionParticipantId?: string; chatView?: string }>> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ mainId?: unknown; isMember?: unknown; view?: unknown }>(
      `select json_extract(c.body, '$.metadata.mainSessionParticipantId') as mainId,
              exists (
                select 1 from json_each(
                  case when json_type(c.body, '$.metadata.participants') = 'array' then c.body else '{"metadata":{"participants":[]}}' end,
                  '$.metadata.participants'
                ) p
                where json_extract(p.value, '$.id') = json_extract(c.body, '$.metadata.mainSessionParticipantId')
              ) as isMember,
              json_extract(c.body, '$.metadata.chatView') as view
       from (
         select id, coalesce(nullif(body_json, ''), payload_json) as body
         from conversations
         where kind = 'chat' and json_valid(coalesce(nullif(body_json, ''), payload_json))
       ) c
       where exists (
         select 1 from conversation_messages m
         where m.conversation_id = c.id
           and m.created_at >= ${sqlString(since)}
           and json_valid(m.payload_json)
           and json_extract(m.payload_json, '$.role') = 'user'
       );`
    );
    return rows.map((row) => ({
      ...(typeof row.mainId === "string" && row.mainId && row.isMember === 1 ? { mainSessionParticipantId: row.mainId } : {}),
      ...(typeof row.view === "string" ? { chatView: row.view } : {})
    }));
  }

  /** Chats holding an approved roster change that had not been applied yet
   *  (ChatAppToolApproval.memberRemovalQueuedAt or memberAdditionQueuedAt);
   *  read once at startup. */
  async conversationIdsWithQueuedRosterChanges(): Promise<string[]> {
    await this.storage.schema.init();
    return this.queryConversationIds(
      `coalesce(nullif(body_json, ''), payload_json) like '%"memberRemovalQueuedAt":%'` +
      ` or coalesce(nullif(body_json, ''), payload_json) like '%"memberAdditionQueuedAt":%'`
    );
  }

  /** Chats that may hold a card a member waits on: an approval waiting (or
   *  an approved roster change not made yet), a member's choice waiting, its
   *  mentions waiting for approval, or another device's card answered and
   *  shown here as waiting. Read at a start and a reconnect, so the cards on
   *  the User's server match them (ChatService.resumeServerCards). Without
   *  `messages` only the chats' bodies are read (a reconnect): every message
   *  row is read only at a start. */
  async conversationIdsWithOpenCards(options: { messages?: boolean } = {}): Promise<string[]> {
    await this.storage.schema.init();
    const messages = options.messages !== false;
    const bodies = `
      select id from conversations
        where kind = 'chat'
          and coalesce(nullif(body_json, ''), payload_json) like '%"pendingAppToolApprovals":[{%'
          and json_valid(coalesce(nullif(body_json, ''), payload_json))
          and exists (
            select 1 from json_each(coalesce(nullif(body_json, ''), payload_json), '$.metadata.pendingAppToolApprovals') as approval
            where json_extract(approval.value, '$.status') = 'pending'
              or json_extract(approval.value, '$.memberRemovalQueuedAt') is not null
              or json_extract(approval.value, '$.memberAdditionQueuedAt') is not null
              or json_extract(approval.value, '$.machineDecisionPending') is not null
          )`;
    const rows = await this.storage.sqlite.queryJson<{ id: string }>(`${bodies}${messages ? `
      union
      select distinct m.conversation_id as id from conversation_messages m
        where (m.payload_json like '%"pendingChoice":%' or m.payload_json like '%"pendingMentions":%' or m.payload_json like '%"serverCard":%')
          and json_valid(m.payload_json)
          and (
            json_extract(m.payload_json, '$.metadata.pendingChoice.status') = 'pending'
            or json_extract(m.payload_json, '$.metadata.serverCard') is not null
            or exists (
              select 1 from json_each(m.payload_json, '$.metadata.pendingMentions') as mention
              where json_extract(mention.value, '$.status') = 'pending'
            )
          )` : ""};`);
    return rows.flatMap((row) => typeof row.id === "string" && row.id.trim() ? [row.id] : []);
  }

  /** The chats holding a member's choice that still waits for the User
   *  (ChatService.resumeChoiceExpiry). */
  async conversationIdsWithPendingChoices(): Promise<string[]> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ id: string }>(`
      select distinct m.conversation_id as id from conversation_messages m
        where m.payload_json like '%"pendingChoice":%'
          and json_valid(m.payload_json)
          and json_extract(m.payload_json, '$.metadata.pendingChoice.status') = 'pending';`);
    return rows.flatMap((row) => typeof row.id === "string" && row.id.trim() ? [row.id] : []);
  }

  async queryConversationIds(whereSql: string): Promise<string[]> {
    const rows = await this.storage.sqlite.queryJson<{ id: string }>(`select id from conversations where ${whereSql};`);
    return rows.flatMap((row) => typeof row.id === "string" && row.id.trim() ? [row.id] : []);
  }
}
