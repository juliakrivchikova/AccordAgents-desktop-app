/**
 * The durable claim a member's home takes before it starts a turn for a
 * message the User wrote on a phone.
 *
 * The phone's message reaches every device through the hub, and reaches the
 * same device again after a restart or a redelivery. The member's home runs
 * the turn once: the first application claims the turn's run id (the same id
 * on every device, see phoneTurnRunId), every later one finds the claim. A
 * Stop that arrives before the turn started writes the claim first, as
 * cancelled, so the turn never starts at all.
 */

export const PHONE_TURN_CLAIM_SCHEMA_SQL = `
  create table if not exists phone_turn_claims (
    run_id text primary key,
    conversation_id text not null,
    message_id text not null,
    participant_id text not null,
    state text not null check(state in ('claimed', 'cancelled')),
    created_at text not null
  );
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

export type PhoneTurnClaimOutcome =
  /** This call claimed the turn: start it. */
  | "claimed"
  /** Claimed before (an earlier application): it ran or runs already. */
  | "taken"
  /** A Stop for it came first: it must not start. */
  | "cancelled";

export class PhoneTurnClaimStore {
  constructor(private readonly database: Database) {}

  /** Claims a turn, or says why it is not this call's to start. */
  async claim(claim: { runId: string; conversationId: string; messageId: string; participantId: string; at: string }): Promise<PhoneTurnClaimOutcome> {
    await this.database.init();
    const rows = await this.database.query<{ state: string; mine: number }>(`
      insert into phone_turn_claims(run_id, conversation_id, message_id, participant_id, state, created_at)
        values (${quote(claim.runId)}, ${quote(claim.conversationId)}, ${quote(claim.messageId)}, ${quote(claim.participantId)}, 'claimed', ${quote(claim.at)})
      on conflict(run_id) do nothing;
      select state, changes() as mine from phone_turn_claims where run_id = ${quote(claim.runId)};
    `);
    const row = rows[0];
    if (!row) throw new Error("The phone turn claim could not be read.");
    if (row.state === "cancelled") return "cancelled";
    return Number(row.mine) === 1 ? "claimed" : "taken";
  }

  /** A Stop for a turn not running here: true when it was not claimed yet
   *  (it is now cancelled and never starts). */
  async cancelUnstarted(claim: { runId: string; conversationId: string; messageId: string; participantId: string; at: string }): Promise<boolean> {
    await this.database.init();
    const rows = await this.database.query<{ state: string; mine: number }>(`
      insert into phone_turn_claims(run_id, conversation_id, message_id, participant_id, state, created_at)
        values (${quote(claim.runId)}, ${quote(claim.conversationId)}, ${quote(claim.messageId)}, ${quote(claim.participantId)}, 'cancelled', ${quote(claim.at)})
      on conflict(run_id) do nothing;
      select state, changes() as mine from phone_turn_claims where run_id = ${quote(claim.runId)};
    `);
    return Number(rows[0]?.mine ?? 0) === 1;
  }

  async state(runId: string): Promise<"claimed" | "cancelled" | undefined> {
    await this.database.init();
    const rows = await this.database.query<{ state: "claimed" | "cancelled" }>(`select state from phone_turn_claims where run_id = ${quote(runId)};`);
    return rows[0]?.state;
  }

  /** The devices whose chat changes this device took in since `sinceIso`
   *  (the User's phones among them). */
  async chatChangeOriginsSince(sinceIso: string): Promise<string[]> {
    await this.database.init();
    const rows = await this.database.query<{ originId: string }>(`
      select distinct origin_id as originId from chat_events
      where received_at >= ${quote(sinceIso)} and kind = 'chat.changes' limit 200;
    `);
    return rows.map((row) => row.originId);
  }

  /** The chat changes these devices wrote, taken in since `sinceIso`, the
   *  oldest first (at most `limit`). */
  async chatChangesFrom(originIds: string[], sinceIso: string, limit: number): Promise<Array<{ envelopeHex: string }>> {
    if (originIds.length === 0) return [];
    await this.database.init();
    return this.database.query<{ envelopeHex: string }>(`
      select hex(envelope_json) as envelopeHex from chat_events
      where received_at >= ${quote(sinceIso)} and kind = 'chat.changes' and origin_id in (${originIds.map(quote).join(", ")})
      order by received_at limit ${Math.max(1, Math.min(Math.floor(limit), 2_000))};
    `);
  }
}

function quote(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}
