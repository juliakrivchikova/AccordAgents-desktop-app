import type { HubCard, HubCardKind, HubClaimOutcome, HubFeedEntry, HubOpEffect, HubOpResult, HubTurn, HubTurnOutcome, HubTurnState } from "../../shared/hubOps";

/**
 * The server's own record of what it accepted (agreements Д1, Д3): every
 * accepted operation in the server's order, and every turn and where it
 * stands. Server-side only; a device keeps none of this.
 */
export const HUB_OPS_SCHEMA_SQL = `
  create table if not exists hub_ops (
    seq integer primary key autoincrement,
    op_id text not null unique,
    device_id text not null,
    conversation_id text not null,
    kind text not null,
    effect_json text not null,
    result_json text not null,
    accepted_at text not null
  );
  create index if not exists hub_ops_conversation on hub_ops(conversation_id, seq);
  create table if not exists hub_turns (
    run_id text primary key,
    conversation_id text not null,
    message_id text not null,
    participant_id text not null,
    state text not null check(state in ('requested', 'claimed', 'stopped', 'finished')),
    requested_at text,
    requested_by text,
    pending_message_id text,
    request_json text,
    executor_device_id text,
    claimed_at text,
    stop_requested_at text,
    finished_at text,
    outcome text
  );
  create index if not exists hub_turns_message on hub_turns(conversation_id, message_id);
  create index if not exists hub_turns_requested on hub_turns(state) where state = 'requested';
  create index if not exists hub_turns_claimed on hub_turns(executor_device_id) where state = 'claimed';
  -- Messages removed from a chat: never added again, whoever writes them.
  create table if not exists hub_removed_messages (
    conversation_id text not null,
    message_id text not null,
    removed_at text not null,
    primary key(conversation_id, message_id)
  );
  -- Where each device last read the feed, and when: a machine that has
  -- work waiting and has not read it is woken; retention keeps what a
  -- device has not read yet.
  create table if not exists hub_ops_cursors (
    device_id text primary key,
    seq integer not null,
    updated_at text not null
  );
  -- Cards members wait on: raised by the member's device, answered from
  -- any device, settled by the member's device.
  create table if not exists hub_cards (
    card_id text primary key,
    conversation_id text not null,
    card_kind text not null,
    participant_id text,
    message_id text,
    raised_by text not null,
    raised_at text not null,
    card_json text not null,
    state text not null check(state in ('pending', 'answered', 'settled')),
    answer_json text,
    answered_by text,
    answered_at text,
    outcome_json text,
    settled_at text,
    answer_op_id text
  );
  create index if not exists hub_cards_open on hub_cards(conversation_id, state);
  -- How far the feed was forgotten (retention): a device that read less
  -- reads its chats again.
  create table if not exists hub_ops_state (
    key text primary key,
    value text not null
  );
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

interface TurnRow {
  runId: string;
  conversationId: string;
  messageId: string;
  participantId: string;
  state: HubTurnState;
  requestedAt: string | null;
  requestedBy: string | null;
  pendingMessageId: string | null;
  requestJson: string | null;
  executorDeviceId: string | null;
  claimedAt: string | null;
  stopRequestedAt: string | null;
  finishedAt: string | null;
  outcome: HubTurnOutcome | null;
}

const TURN_COLUMNS = `run_id as runId, conversation_id as conversationId, message_id as messageId, participant_id as participantId,
  state, requested_at as requestedAt, requested_by as requestedBy, pending_message_id as pendingMessageId, request_json as requestJson,
  executor_device_id as executorDeviceId, claimed_at as claimedAt, stop_requested_at as stopRequestedAt,
  finished_at as finishedAt, outcome`;

export class HubOpsStore {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(HUB_OPS_SCHEMA_SQL);
      // A server whose cards table predates the answer's operation id gets
      // the column (the id is what a refusal names, for the device that
      // answered).
      const columns = await this.database.query<{ name: string }>(`select name from pragma_table_info('hub_cards');`);
      if (!columns.some((column) => column.name === "answer_op_id")) {
        await this.database.execute(`alter table hub_cards add column answer_op_id text;`).catch(async (error: unknown) => {
          const again = await this.database.query<{ name: string }>(`select name from pragma_table_info('hub_cards');`);
          if (!again.some((column) => column.name === "answer_op_id")) throw error;
        });
      }
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  /** The newest place in the order (0 before anything was accepted). */
  async head(): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ seq: number }>(`select coalesce((select seq from sqlite_sequence where name = 'hub_ops'), 0) as seq;`);
    return Number(rows[0]?.seq ?? 0);
  }

  /** What the order answered for operations it already accepted, by id. */
  async accepted(opIds: string[]): Promise<Map<string, { seq: number; deviceId: string; result: HubOpResult }>> {
    const found = new Map<string, { seq: number; deviceId: string; result: HubOpResult }>();
    if (opIds.length === 0) return found;
    await this.init();
    const rows = await this.database.query<{ opId: string; seq: number; deviceId: string; resultJson: string }>(
      `select op_id as opId, seq, device_id as deviceId, result_json as resultJson from hub_ops where op_id in (${opIds.map(quote).join(", ")});`);
    for (const row of rows) found.set(row.opId, { seq: Number(row.seq), deviceId: row.deviceId, result: JSON.parse(row.resultJson) as HubOpResult });
    return found;
  }

  /** The statement that places one accepted operation, to commit together
   *  with whatever it changed. `condition` gates it like the change itself. */
  insertSql(entry: { seq: number; opId: string; deviceId: string; conversationId: string; kind: string; effect: HubOpEffect; result: HubOpResult; acceptedAt: string }, condition?: string): string {
    return `insert into hub_ops(seq, op_id, device_id, conversation_id, kind, effect_json, result_json, accepted_at)
      select ${entry.seq}, ${quote(entry.opId)}, ${quote(entry.deviceId)}, ${quote(entry.conversationId)}, ${quote(entry.kind)},
        ${quote(JSON.stringify(entry.effect))}, ${quote(JSON.stringify(entry.result))}, ${quote(entry.acceptedAt)}
      ${condition ? `where ${condition}` : ""};`;
  }

  async execute(sql: string): Promise<void> {
    await this.init();
    await this.database.execute(`begin immediate; ${sql} commit;`);
  }

  /** The full answer to an operation already placed (a document action's
   *  result, known only once its change committed): what a device that
   *  sends the same operation again is told. */
  async setResult(opId: string, result: HubOpResult): Promise<void> {
    await this.init();
    await this.database.execute(`update hub_ops set result_json = ${quote(JSON.stringify(result))} where op_id = ${quote(opId)};`);
  }

  /** Accepted operations after `after`, in order: at most `limit` entries and
   *  about `maxBytes` of effects (always at least one entry). */
  async after(after: number, limit: number, maxBytes: number): Promise<{ entries: HubFeedEntry[]; more: boolean }> {
    await this.init();
    const rows = await this.database.query<{ seq: number; opId: string; deviceId: string; conversationId: string; acceptedAt: string; effectJson: string; size: number }>(`
      select seq, op_id as opId, device_id as deviceId, conversation_id as conversationId, accepted_at as acceptedAt,
        effect_json as effectJson, length(effect_json) as size
      from hub_ops where seq > ${Math.max(0, Math.floor(after))} order by seq limit ${Math.max(1, Math.floor(limit)) + 1};`);
    const entries: HubFeedEntry[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      if (entries.length > 0 && bytes + Number(row.size) > maxBytes) return { entries, more: true };
      bytes += Number(row.size);
      entries.push({ seq: Number(row.seq), opId: row.opId, deviceId: row.deviceId, conversationId: row.conversationId, acceptedAt: row.acceptedAt,
        effect: JSON.parse(row.effectJson) as HubOpEffect });
    }
    return { entries, more: rows.length > limit };
  }

  /** A device read the feed from `after`: it holds everything up to there. */
  async recordRead(deviceId: string, after: number, at: string): Promise<void> {
    await this.init();
    await this.database.execute(`insert into hub_ops_cursors(device_id, seq, updated_at)
      values (${quote(deviceId)}, ${Math.max(0, Math.floor(after))}, ${quote(at)})
      on conflict(device_id) do update set seq = max(seq, excluded.seq), updated_at = excluded.updated_at;`);
  }

  async cursorTimes(): Promise<Map<string, { hubSeq: number; updatedAt: string }>> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string; seq: number; updatedAt: string }>(
      `select device_id as deviceId, seq, updated_at as updatedAt from hub_ops_cursors;`);
    return new Map(rows.map((row) => [row.deviceId, { hubSeq: Number(row.seq), updatedAt: row.updatedAt }]));
  }

  /** Forgets accepted operations every reader has read, older than
   *  `cutoff`, oldest first, at most `limit`. Readers are the devices that
   *  keep copies (the computer, machines); one that never read keeps all. */
  async prune(readers: string[], cutoff: string, limit: number): Promise<{ events: number; bytes: number; through: number }> {
    await this.init();
    if (readers.length === 0) return { events: 0, bytes: 0, through: await this.prunedThrough() };
    const floorRows = await this.database.query<{ floor: number | null }>(`select min(coalesce(c.seq, 0)) as floor
      from (${readers.map((deviceId) => `select ${quote(deviceId)} as device_id`).join(" union all ")}) r
      left join hub_ops_cursors c on c.device_id = r.device_id;`);
    const floor = Number(floorRows[0]?.floor ?? 0);
    if (!(floor > 0)) return { events: 0, bytes: 0, through: await this.prunedThrough() };
    const picked = await this.database.query<{ seq: number; size: number }>(`select seq, length(effect_json) + length(result_json) as size from hub_ops
      where seq <= ${Math.floor(floor)} and accepted_at < ${quote(cutoff)} order by seq limit ${Math.max(1, Math.floor(limit))};`);
    if (picked.length === 0) return { events: 0, bytes: 0, through: await this.prunedThrough() };
    const through = Number(picked[picked.length - 1].seq);
    await this.database.execute(`begin immediate;
      delete from hub_ops where seq <= ${through};
      insert into hub_ops_state(key, value) values ('pruned-through', ${quote(String(through))})
        on conflict(key) do update set value = case when cast(value as integer) < ${through} then excluded.value else value end;
      commit;`);
    return { events: picked.length, bytes: picked.reduce((sum, row) => sum + Number(row.size), 0), through };
  }

  /** The feed forgot everything up to here (retention). */
  async prunedThrough(): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ value: string }>(`select value from hub_ops_state where key = 'pruned-through';`);
    return Number(rows[0]?.value ?? 0) || 0;
  }

  async turn(runId: string): Promise<HubTurn | undefined> {
    await this.init();
    const rows = await this.database.query<TurnRow>(`select ${TURN_COLUMNS} from hub_turns where run_id = ${quote(runId)};`);
    return rows[0] ? turnFromRow(rows[0]) : undefined;
  }

  /** The turns of these messages in a chat. */
  async turnsFor(conversationId: string, messageIds: string[]): Promise<HubTurn[]> {
    if (messageIds.length === 0) return [];
    await this.init();
    const turns: HubTurn[] = [];
    for (let start = 0; start < messageIds.length; start += 500) {
      const slice = messageIds.slice(start, start + 500);
      const rows = await this.database.query<TurnRow>(`select ${TURN_COLUMNS} from hub_turns
        where conversation_id = ${quote(conversationId)} and message_id in (${slice.map(quote).join(", ")}) order by run_id;`);
      turns.push(...rows.map(turnFromRow));
    }
    return turns;
  }

  /** Writes a turn as it stands now (inside the caller's transaction). */
  turnSql(turn: HubTurn): string {
    const value = (text: string | undefined) => text === undefined ? "null" : quote(text);
    return `insert into hub_turns(run_id, conversation_id, message_id, participant_id, state, requested_at, requested_by, pending_message_id, request_json,
        executor_device_id, claimed_at, stop_requested_at, finished_at, outcome)
      values (${quote(turn.runId)}, ${quote(turn.conversationId)}, ${quote(turn.messageId)}, ${quote(turn.participantId)}, ${quote(turn.state)},
        ${value(turn.requestedAt)}, ${value(turn.requestedBy)}, ${value(turn.pendingMessageId)}, ${turn.request ? quote(JSON.stringify(turn.request)) : "null"},
        ${value(turn.executorDeviceId)}, ${value(turn.claimedAt)}, ${value(turn.stopRequestedAt)}, ${value(turn.finishedAt)}, ${value(turn.outcome)})
      on conflict(run_id) do update set state = excluded.state, executor_device_id = excluded.executor_device_id,
        claimed_at = excluded.claimed_at, stop_requested_at = excluded.stop_requested_at, finished_at = excluded.finished_at,
        outcome = excluded.outcome;`;
  }

  /** Turns asked for that nobody has taken yet, oldest first. */
  async requested(limit = 500): Promise<HubTurn[]> {
    await this.init();
    const rows = await this.database.query<TurnRow>(`select ${TURN_COLUMNS} from hub_turns where state = 'requested'
      order by requested_at, run_id limit ${Math.max(1, Math.floor(limit))};`);
    return rows.map(turnFromRow);
  }

  /** Turns this device took and has not finished, oldest first. */
  async claimedBy(deviceId: string, limit = 500): Promise<HubTurn[]> {
    await this.init();
    const rows = await this.database.query<TurnRow>(`select ${TURN_COLUMNS} from hub_turns where state = 'claimed'
      and executor_device_id = ${quote(deviceId)} order by claimed_at, run_id limit ${Math.max(1, Math.floor(limit))};`);
    return rows.map(turnFromRow);
  }

  async card(cardId: string): Promise<HubCard | undefined> {
    await this.init();
    const rows = await this.database.query<CardRow>(`select ${CARD_COLUMNS} from hub_cards where card_id = ${quote(cardId)};`);
    return rows[0] ? cardFromRow(rows[0]) : undefined;
  }

  /** Cards not settled yet (in one chat, or all), oldest first. */
  async openCards(conversationId?: string, limit = 500, options: { newestFirst?: boolean; exceptKinds?: HubCardKind[] } = {}): Promise<HubCard[]> {
    await this.init();
    const except = (options.exceptKinds ?? []).map(quote).join(", ");
    const order = options.newestFirst ? "raised_at desc, card_id desc" : "raised_at, card_id";
    const rows = await this.database.query<CardRow>(`select ${CARD_COLUMNS} from hub_cards where state != 'settled'
      ${conversationId ? `and conversation_id = ${quote(conversationId)}` : ""} ${except ? `and card_kind not in (${except})` : ""}
      order by ${order} limit ${Math.max(1, Math.floor(limit))};`);
    return rows.map(cardFromRow);
  }

  /** Removes a deleted chat's cards (committed with the deletion). */
  deleteCardsSql(conversationId: string): string {
    return `delete from hub_cards where conversation_id = ${quote(conversationId)};`;
  }

  cardSql(card: HubCard): string {
    const value = (text: string | undefined) => text === undefined ? "null" : quote(text);
    const json = (object: Record<string, unknown> | undefined) => object === undefined ? "null" : quote(JSON.stringify(object));
    return `insert into hub_cards(card_id, conversation_id, card_kind, participant_id, message_id, raised_by, raised_at, card_json, state,
        answer_json, answered_by, answered_at, outcome_json, settled_at, answer_op_id)
      values (${quote(card.cardId)}, ${quote(card.conversationId)}, ${quote(card.cardKind)}, ${value(card.participantId)}, ${value(card.messageId)},
        ${quote(card.raisedBy)}, ${quote(card.raisedAt)}, ${quote(JSON.stringify(card.card))}, ${quote(card.state)},
        ${json(card.answer)}, ${value(card.answeredBy)}, ${value(card.answeredAt)}, ${json(card.outcome)}, ${value(card.settledAt)}, ${value(card.answerOpId)})
      on conflict(card_id) do update set card_json = excluded.card_json, state = excluded.state, answer_json = excluded.answer_json,
        answered_by = excluded.answered_by, answered_at = excluded.answered_at, outcome_json = excluded.outcome_json, settled_at = excluded.settled_at,
        answer_op_id = excluded.answer_op_id;`;
  }

  async isRemoved(conversationId: string, messageId: string): Promise<boolean> {
    await this.init();
    const rows = await this.database.query<{ one: number }>(`select 1 as one from hub_removed_messages
      where conversation_id = ${quote(conversationId)} and message_id = ${quote(messageId)};`);
    return rows.length > 0;
  }

  removedSql(conversationId: string, messageId: string, removedAt: string, condition?: string): string {
    return `insert into hub_removed_messages(conversation_id, message_id, removed_at)
      select ${quote(conversationId)}, ${quote(messageId)}, ${quote(removedAt)} ${condition ? `where ${condition}` : ""}
      on conflict do nothing;`;
  }
}

interface CardRow {
  cardId: string;
  conversationId: string;
  cardKind: HubCard["cardKind"];
  participantId: string | null;
  messageId: string | null;
  raisedBy: string;
  raisedAt: string;
  cardJson: string;
  state: HubCard["state"];
  answerJson: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  outcomeJson: string | null;
  settledAt: string | null;
  answerOpId: string | null;
}

const CARD_COLUMNS = `card_id as cardId, conversation_id as conversationId, card_kind as cardKind, participant_id as participantId,
  message_id as messageId, raised_by as raisedBy, raised_at as raisedAt, card_json as cardJson, state, answer_json as answerJson,
  answered_by as answeredBy, answered_at as answeredAt, outcome_json as outcomeJson, settled_at as settledAt, answer_op_id as answerOpId`;

function cardFromRow(row: CardRow): HubCard {
  return {
    cardId: row.cardId,
    conversationId: row.conversationId,
    cardKind: row.cardKind,
    ...(row.participantId ? { participantId: row.participantId } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    raisedBy: row.raisedBy,
    raisedAt: row.raisedAt,
    card: JSON.parse(row.cardJson) as Record<string, unknown>,
    state: row.state,
    ...(row.answerJson ? { answer: JSON.parse(row.answerJson) as Record<string, unknown> } : {}),
    ...(row.answeredBy ? { answeredBy: row.answeredBy } : {}),
    ...(row.answeredAt ? { answeredAt: row.answeredAt } : {}),
    ...(row.outcomeJson ? { outcome: JSON.parse(row.outcomeJson) as Record<string, unknown> } : {}),
    ...(row.settledAt ? { settledAt: row.settledAt } : {}),
    ...(row.answerOpId ? { answerOpId: row.answerOpId } : {})
  };
}

function turnFromRow(row: TurnRow): HubTurn {
  return {
    runId: row.runId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    participantId: row.participantId,
    state: row.state,
    ...(row.requestedAt ? { requestedAt: row.requestedAt } : {}),
    ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    ...(row.pendingMessageId ? { pendingMessageId: row.pendingMessageId } : {}),
    ...(row.requestJson ? { request: JSON.parse(row.requestJson) as Record<string, unknown> } : {}),
    ...(row.executorDeviceId ? { executorDeviceId: row.executorDeviceId } : {}),
    ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
    ...(row.stopRequestedAt ? { stopRequestedAt: row.stopRequestedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {})
  };
}

/** The claim outcome a turn's state gives a device that asks for it. */
export function claimOutcomeFor(turn: HubTurn | undefined, deviceId: string): HubClaimOutcome | undefined {
  if (!turn || turn.state === "requested") return undefined;
  if (turn.state === "stopped") return "stopped";
  if (turn.state === "finished") return "finished";
  return turn.executorDeviceId === deviceId ? "already-yours" : "taken";
}

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}
