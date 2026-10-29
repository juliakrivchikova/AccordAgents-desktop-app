import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";

/** The exactly-once ledger of answers with a native effect (an approval, a
 *  choice, mentions): one row per answered target, taken before the effect.
 *  `event_id` holds the answer's key (a card's answer on the User's server). */
export const NATIVE_COMMAND_SCHEMA_SQL = `
  create table if not exists native_approval_effects (
    conversation_id text not null,
    approval_id text not null,
    participant_id text not null,
    event_id text not null unique,
    runtime_id text not null,
    pid integer not null,
    started_at text not null,
    primary key(conversation_id, approval_id)
  );
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

export interface NativeApprovalEffect extends NativeRuntimeIdentity {
  conversationId: string;
  approvalId: string;
  participantId: string;
  eventId: string;
}

/** The local native-effect boundary: an answer with a native effect is
 * admitted here once, before the effect, whichever device gave it. */
export class NativeCommandStore {
  constructor(private readonly database: Database) {}

  async approvalEffect(conversationId: string, approvalId: string): Promise<NativeApprovalEffect | undefined> {
    await this.database.init();
    return (await this.database.query<NativeApprovalEffect>(`select conversation_id as conversationId,
      approval_id as approvalId, participant_id as participantId, event_id as eventId,
      runtime_id as runtimeId, pid, started_at as startedAt from native_approval_effects
      where conversation_id = ${quote(conversationId)} and approval_id = ${quote(approvalId)};`))[0];
  }

  /**
   * The same durable boundary an approval crosses, for any answer that has a
   * native effect.
   *
   * A choice used to be admitted by asking whether a receipt event existed,
   * which is a read and not a claim: two answers arriving together both saw no
   * receipt and both told the provider, and a crash between telling it and
   * writing the receipt told it again on restart. The row here is the
   * admission, taken before the effect, in one table with one key.
   */
  targetEffect(conversationId: string, targetKey: string): Promise<NativeApprovalEffect | undefined> {
    return this.approvalEffect(conversationId, targetKey);
  }

  claimTarget(effect: Omit<NativeApprovalEffect, "approvalId"> & { targetKey: string }): Promise<boolean> {
    if (!effect.targetKey.includes(":")) throw new Error("A native target claim requires a qualified target key.");
    const { targetKey, ...rest } = effect;
    return this.claimApproval({ ...rest, approvalId: targetKey });
  }

  /** Called only after the domain validated the answer, immediately before
   * changing permissions, applying a tool or waking the native request.
   * `eventId` names the answer (a card's answer on the User's server): one
   * answer claims a target once, and no other answer claims it after. */
  async claimApproval(effect: NativeApprovalEffect): Promise<boolean> {
    if (!Number.isSafeInteger(effect.pid) || effect.pid < 1 || Object.entries(effect).some(([key, value]) => key !== "pid" && (typeof value !== "string" || !value.trim()))) {
      throw new Error("A native approval effect requires stable identities.");
    }
    await this.database.init();
    const rows = await this.database.query<{ eventId: string }>(durable(`insert into native_approval_effects(
      conversation_id, approval_id, participant_id, event_id, runtime_id, pid, started_at)
      select ${quote(effect.conversationId)}, ${quote(effect.approvalId)}, ${quote(effect.participantId)}, ${quote(effect.eventId)},
        ${quote(effect.runtimeId)}, ${effect.pid}, ${quote(effect.startedAt)}
      where not exists(select 1 from machine_power_state where stop_fence is not null)
      on conflict do nothing returning event_id as eventId;`));
    if (!rows.length && !await this.approvalEffect(effect.conversationId, effect.approvalId)) {
      // Neither taken nor held by another answer: this machine is stopping.
      throw new Error("This machine is stopping; the answer waits for its next start.");
    }
    return rows.length === 1;
  }
}

function quote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function durable(sql: string): string { return `pragma synchronous = full; pragma fullfsync = on; ${sql}`; }
