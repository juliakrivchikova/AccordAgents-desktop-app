import type { NativeCommand, NativeRuntimeIdentity, NativeSessionExecutor } from "../../shared/nativeCommands";

export const NATIVE_COMMAND_SCHEMA_SQL = `
  create table if not exists native_commands (
    command_id text primary key,
    event_id text not null references chat_events(event_id),
    conversation_id text not null,
    participant_id text not null,
    run_id text not null unique,
    terminal_event_id text not null unique,
    phase text not null check(phase in ('queued', 'claimed', 'finished')),
    runtime_id text,
    executor_generation integer,
    cancelled integer not null default 0 check(cancelled in (0, 1))
  );
  create index if not exists idx_native_commands_pending on native_commands(phase, conversation_id, participant_id);
  create table if not exists native_run_cancellations (
    run_id text primary key,
    conversation_id text not null,
    event_id text not null references chat_events(event_id)
  );
  create table if not exists native_run_outcomes (
    run_id text primary key,
    event_id text not null references chat_events(event_id),
    origin_seq integer not null
  );
  create table if not exists native_approval_effects (
    conversation_id text not null,
    approval_id text not null,
    participant_id text not null,
    event_id text not null unique references chat_events(event_id),
    runtime_id text not null,
    pid integer not null,
    started_at text not null,
    primary key(conversation_id, approval_id)
  );
  create table if not exists native_session_executors (
    conversation_id text not null,
    participant_id text not null,
    generation integer not null,
    runtime_id text not null,
    pid integer not null,
    started_at text not null,
    released integer not null default 0 check(released in (0, 1)),
    primary key(conversation_id, participant_id)
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

const COMMAND_COLUMNS = `command_id as commandId, event_id as eventId, conversation_id as conversationId,
  participant_id as participantId, run_id as runId, terminal_event_id as terminalEventId,
  phase, runtime_id as runtimeId, executor_generation as executorGeneration, cancelled`;

/** The local native-effect boundary. The signed log owns request bodies; this
 * bounded ledger owns admission and cancellation. No TTL reclaims an executor:
 * a caller must verify the old provider processes are gone before releasing it. */
export class NativeCommandStore {
  constructor(private readonly database: Database) {}

  async approvalEffect(conversationId: string, approvalId: string): Promise<NativeApprovalEffect | undefined> {
    await this.database.init();
    return (await this.database.query<NativeApprovalEffect>(`select conversation_id as conversationId,
      approval_id as approvalId, participant_id as participantId, event_id as eventId,
      runtime_id as runtimeId, pid, started_at as startedAt from native_approval_effects
      where conversation_id = ${quote(conversationId)} and approval_id = ${quote(approvalId)};`))[0];
  }

  /** Called only after the domain validated the answer, immediately before
   * changing permissions, applying a tool or waking the native request. */
  async claimApproval(effect: NativeApprovalEffect): Promise<boolean> {
    if (!Number.isSafeInteger(effect.pid) || effect.pid < 1 || Object.entries(effect).some(([key, value]) => key !== "pid" && (typeof value !== "string" || !value.trim()))) {
      throw new Error("A native approval effect requires stable identities.");
    }
    await this.database.init();
    const rows = await this.database.query<{ eventId: string }>(durable(`insert into native_approval_effects(
      conversation_id, approval_id, participant_id, event_id, runtime_id, pid, started_at)
      select conversation_id, ${quote(effect.approvalId)}, ${quote(effect.participantId)}, event_id,
        ${quote(effect.runtimeId)}, ${effect.pid}, ${quote(effect.startedAt)} from chat_events
      where event_id = ${quote(effect.eventId)} and conversation_id = ${quote(effect.conversationId)} and kind = 'machine.approval.decision'
        and not exists(select 1 from machine_power_state where stop_fence is not null)
      on conflict(conversation_id, approval_id) do nothing returning event_id as eventId;`));
    if (!rows.length && !await this.approvalEffect(effect.conversationId, effect.approvalId)) throw new Error("The signed approval decision is not stored.");
    return rows.length === 1;
  }

  async accept(command: Pick<NativeCommand, "commandId" | "eventId" | "conversationId" | "participantId" | "runId" | "terminalEventId">): Promise<NativeCommand> {
    for (const value of Object.values(command)) if (typeof value !== "string" || !value.trim()) throw new Error("A native command requires stable identities.");
    await this.database.init();
    const rows = await this.database.query<NativeCommand>(durable(`begin immediate;
      insert into native_commands(command_id, event_id, conversation_id, participant_id, run_id, terminal_event_id, phase, cancelled)
      select ${quote(command.commandId)}, event_id, ${quote(command.conversationId)}, ${quote(command.participantId)},
        ${quote(command.runId)}, ${quote(command.terminalEventId)}, 'queued',
        exists(select 1 from native_run_cancellations where run_id = ${quote(command.runId)} and conversation_id = ${quote(command.conversationId)})
      from chat_events where event_id = ${quote(command.eventId)} and conversation_id = ${quote(command.conversationId)}
        and not exists(select 1 from machine_power_state where stop_fence is not null)
      on conflict(command_id) do update set event_id = case
        when event_id = excluded.event_id and conversation_id = excluded.conversation_id
          and participant_id = excluded.participant_id and run_id = excluded.run_id
          and terminal_event_id = excluded.terminal_event_id then event_id else null end;
      select ${COMMAND_COLUMNS} from native_commands where command_id = ${quote(command.commandId)};
      commit;`));
    if (!rows[0]) throw new Error("The native command's signed request is not stored.");
    return normalizeCommand(rows[0]);
  }

  async cancel(runId: string, conversationId: string, eventId: string): Promise<void> {
    await this.database.init();
    await this.database.execute(durable(`begin immediate;
      insert into native_run_cancellations(run_id, conversation_id, event_id)
      select ${quote(runId)}, case when exists(select 1 from native_commands where run_id = ${quote(runId)} and conversation_id != ${quote(conversationId)})
        then null else ${quote(conversationId)} end, event_id from chat_events
        where event_id = ${quote(eventId)} and conversation_id = ${quote(conversationId)}
      on conflict(run_id) do update set conversation_id = case
        when conversation_id = excluded.conversation_id then conversation_id else null end;
      update native_commands set cancelled = 1 where run_id = ${quote(runId)} and conversation_id = ${quote(conversationId)}
        and exists(select 1 from native_run_cancellations where run_id = ${quote(runId)});
      commit;`));
    const stored = await this.database.query<{ present: number }>(`select 1 as present from native_run_cancellations where run_id = ${quote(runId)} and conversation_id = ${quote(conversationId)};`);
    if (!stored.length) throw new Error("The native cancellation is not stored.");
  }

  /** Exactly one runtime claims a command. The same runtime can hold several
   * commands for its resident session; its provider adapter serializes them. */
  async claim(commandId: string, owner: NativeRuntimeIdentity): Promise<NativeCommand | undefined> {
    if (!owner.runtimeId || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.startedAt) throw new Error("A native executor requires its process identity.");
    await this.database.init();
    const rows = await this.database.query<NativeCommand>(durable(`begin immediate;
      insert into native_session_executors(conversation_id, participant_id, generation, runtime_id, pid, started_at)
      select conversation_id, participant_id, 1, ${quote(owner.runtimeId)}, ${owner.pid}, ${quote(owner.startedAt)}
        from native_commands where command_id = ${quote(commandId)} and phase = 'queued' and cancelled = 0
          and not exists(select 1 from machine_power_state where stop_fence is not null)
      on conflict(conversation_id, participant_id) do update set
        generation = generation + 1, runtime_id = excluded.runtime_id, pid = excluded.pid, started_at = excluded.started_at, released = 0
        where released = 1;
      update native_commands set phase = 'claimed', runtime_id = ${quote(owner.runtimeId)},
        executor_generation = (select generation from native_session_executors s
          where s.conversation_id = native_commands.conversation_id and s.participant_id = native_commands.participant_id)
      where command_id = ${quote(commandId)} and phase = 'queued' and cancelled = 0
        and not exists(select 1 from machine_power_state where stop_fence is not null)
        and exists(select 1 from native_session_executors s where s.conversation_id = native_commands.conversation_id
          and s.participant_id = native_commands.participant_id and s.runtime_id = ${quote(owner.runtimeId)}
          and s.pid = ${owner.pid} and s.started_at = ${quote(owner.startedAt)} and s.released = 0)
      returning ${COMMAND_COLUMNS};
      commit;`));
    return rows[0] ? normalizeCommand(rows[0]) : undefined;
  }

  async get(commandId: string): Promise<NativeCommand | undefined> {
    await this.database.init();
    const rows = await this.database.query<NativeCommand>(`select ${COMMAND_COLUMNS} from native_commands where command_id = ${quote(commandId)};`);
    return rows[0] ? normalizeCommand(rows[0]) : undefined;
  }

  async forRun(runId: string): Promise<NativeCommand | undefined> {
    await this.database.init();
    const rows = await this.database.query<NativeCommand>(`select ${COMMAND_COLUMNS} from native_commands where run_id = ${quote(runId)};`);
    return rows[0] ? normalizeCommand(rows[0]) : undefined;
  }

  /** Native continuations can finish after their original dispatch wrapper.
   * Keep the latest immutable receipt, including after its transport ACK. */
  async recordOutcome(runId: string, eventId: string): Promise<void> {
    await this.database.init();
    await this.database.execute(durable(`insert into native_run_outcomes(run_id, event_id, origin_seq)
      select ${quote(runId)}, event_id, origin_seq from chat_events where event_id = ${quote(eventId)} and kind = 'machine.turn.finished'
      on conflict(run_id) do update set event_id = excluded.event_id, origin_seq = excluded.origin_seq
        where excluded.origin_seq > native_run_outcomes.origin_seq;`));
  }

  async latestOutcome(runId: string): Promise<string | undefined> {
    await this.database.init();
    const rows = await this.database.query<{ eventId: string }>(`select event_id as eventId from native_run_outcomes where run_id = ${quote(runId)};`);
    return rows[0]?.eventId;
  }

  async pending(after?: { commandId: string; logicalTs: string }): Promise<Array<NativeCommand & { logicalTs: string }>> {
    await this.database.init();
    const rows = await this.database.query<NativeCommand & { logicalTs: string }>(`select c.command_id as commandId, c.event_id as eventId,
      c.conversation_id as conversationId, c.participant_id as participantId, c.run_id as runId, c.terminal_event_id as terminalEventId,
      c.phase, c.runtime_id as runtimeId, c.executor_generation as executorGeneration, c.cancelled, e.logical_ts as logicalTs
      from native_commands c join chat_events e on e.event_id = c.event_id
      where c.phase != 'finished' ${after ? `and (e.logical_ts, c.command_id) > (${quote(after.logicalTs)}, ${quote(after.commandId)})` : ""}
      order by e.logical_ts, c.command_id limit 100;`);
    return rows.map(row => ({ ...normalizeCommand(row), logicalTs: row.logicalTs }));
  }

  async executor(conversationId: string, participantId: string): Promise<NativeSessionExecutor | undefined> {
    await this.database.init();
    const rows = await this.database.query<NativeSessionExecutor>(`select conversation_id as conversationId, participant_id as participantId,
      generation, runtime_id as runtimeId, pid, started_at as startedAt, released from native_session_executors
      where conversation_id = ${quote(conversationId)} and participant_id = ${quote(participantId)};`);
    return rows[0] ? { ...rows[0], released: Boolean(rows[0].released) } : undefined;
  }

  /** Caller supplies the exact generation whose process tree it verified.
   * Finishing a command alone cannot release a still-resident provider. */
  async releaseVerifiedExecutor(executor: NativeSessionExecutor): Promise<boolean> {
    await this.database.init();
    const rows = await this.database.query<{ released: number }>(durable(`update native_session_executors set released = 1
      where conversation_id = ${quote(executor.conversationId)} and participant_id = ${quote(executor.participantId)}
        and generation = ${executor.generation} and runtime_id = ${quote(executor.runtimeId)}
        and pid = ${executor.pid} and started_at = ${quote(executor.startedAt)} and released = 0 returning released;`));
    return rows.length === 1;
  }

  /** The terminal event is committed first. A crash between these writes can
   * recover it by its deterministic id, without running the command again. */
  async finish(commandId: string): Promise<void> {
    await this.database.init();
    const rows = await this.database.query<{ commandId: string }>(durable(`update native_commands set phase = 'finished'
      where command_id = ${quote(commandId)} and exists(select 1 from chat_events e
        where e.event_id = native_commands.terminal_event_id and e.conversation_id = native_commands.conversation_id)
      returning command_id as commandId;`));
    if (!rows.length) throw new Error("The native command's terminal event is not stored.");
  }
}

function normalizeCommand(row: NativeCommand): NativeCommand { return { ...row, cancelled: Boolean(row.cancelled) }; }
function quote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function durable(sql: string): string { return `pragma synchronous = full; pragma fullfsync = on; ${sql}`; }
