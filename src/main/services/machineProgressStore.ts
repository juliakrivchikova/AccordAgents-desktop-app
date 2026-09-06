import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { decodeMachineProgress, machineProgressEventId, type MachineProgressFrame } from "../../shared/machineProgress";
import type { ChatMessage, ReviewProgress } from "../../shared/types";

export const MACHINE_PROGRESS_SCHEMA = `
  create index if not exists machine_progress_events on chat_events(origin_id, kind);
  create table if not exists machine_progress_heads (
    run_id text primary key, conversation_id text not null, stream_id text not null,
    sequence integer not null, event_id text not null, closed integer not null default 0
  );
  create index if not exists machine_progress_open on machine_progress_heads(conversation_id, closed);
  create table if not exists machine_progress_frames (
    run_id text not null, sequence integer not null, event_id text not null unique references chat_events(event_id),
    primary key(run_id, sequence)
  );
`;

interface ProgressHead { runId: string; conversationId: string; streamId: string; sequence: number; eventId: string; closed: number; }
interface ProgressDatabase {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
  hydrate(payload: unknown): Promise<unknown>;
}
const HEAD_COLUMNS = "run_id as runId, conversation_id as conversationId, stream_id as streamId, sequence, event_id as eventId, closed";

/** The signed event log owns text/tool deltas. This projection writes only
 * event references, never a growing full answer or a 14,000-message chat. */
export class MachineProgressStore {
  private readonly cache = new Map<string, { eventId: string; sequence: number; value: ReviewProgress; display?: ReviewProgress }>();
  constructor(private readonly database: ProgressDatabase) {}

  /** Publishing the signed event precedes updating this local projection. A
   * crash between those writes must not discard the last stored partial answer
   * when native-run recovery builds its terminal. Only the local author's
   * events are replayed here; remote events still obey channel gap/ACK rules. */
  async recoverLocal(originId: string): Promise<void> {
    await this.database.init();
    let cursor = 0;
    for (;;) {
      const rows = await this.database.query<{ rowId: number; envelope: string }>(`with candidates as (
        select e.rowid as rowId,e.envelope_json as envelope from chat_events e
        where e.origin_id=${q(originId)} and e.kind='machine.turn.progress.delta' and e.rowid>${cursor}
          and not exists(select 1 from machine_progress_frames f where f.event_id=e.event_id)
        order by e.rowid limit 100
      ), page as (select *,sum(length(cast(envelope as blob))) over(order by rowId) as bytes,
        row_number() over(order by rowId) as ordinal from candidates)
      select rowId,envelope from page where bytes<=1048576 or ordinal=1 order by rowId;`);
      if (!rows.length) return;
      for (const row of rows) {
        const event = JSON.parse(row.envelope) as ChatEventEnvelope;
        const frame = await this.database.hydrate(event.payload) as MachineProgressFrame;
        await this.apply(event, frame);
        cursor = row.rowId;
      }
    }
  }

  async apply(event: ChatEventEnvelope, frame: MachineProgressFrame): Promise<ReviewProgress | undefined> {
    await this.database.init();
    if (event.eventId !== machineProgressEventId(frame) || event.kind !== frame.type || event.conversationId !== frame.conversationId) {
      throw new Error("Machine progress has the wrong immutable event identity.");
    }
    const head = await this.head(frame.runId);
    if (head?.closed) return undefined;
    if (head && (head.conversationId !== frame.conversationId || head.streamId !== frame.streamId)) throw new Error("Machine progress changed stream identity.");
    if (head && frame.sequence <= head.sequence) {
      const previous = (await this.database.query<{ id: string }>(`select event_id as id from machine_progress_frames where run_id = ${q(frame.runId)} and sequence = ${frame.sequence};`))[0];
      if (previous?.id !== event.eventId) throw new Error("Conflicting machine progress frame.");
      return undefined;
    }
    if (frame.sequence !== (head?.sequence ?? 0) + 1 || (frame.previousEventId ?? null) !== (head?.eventId ?? null)) {
      throw new Error("Machine progress is missing an earlier frame.");
    }
    const value = decodeMachineProgress(head ? await this.read(head) : undefined, frame);
    await this.database.execute(`pragma synchronous=FULL; begin immediate;
      create temp table progress_guard(valid integer check(valid=1));
      insert into progress_guard select case when exists(select 1 from chat_events where event_id=${q(event.eventId)} and event_hash=${q(event.eventHash)})
        and ${head ? `exists(select 1 from machine_progress_heads where run_id=${q(frame.runId)} and event_id=${q(head.eventId)} and closed=0)` : `not exists(select 1 from machine_progress_heads where run_id=${q(frame.runId)})`} then 1 else 0 end;
      insert into machine_progress_frames(run_id,sequence,event_id) values(${q(frame.runId)},${frame.sequence},${q(event.eventId)});
      insert into machine_progress_heads(run_id,conversation_id,stream_id,sequence,event_id,closed)
        values(${q(frame.runId)},${q(frame.conversationId)},${q(frame.streamId)},${frame.sequence},${q(event.eventId)},0)
        on conflict(run_id) do update set sequence=excluded.sequence,event_id=excluded.event_id;
      commit;`);
    this.cache.set(frame.runId, { eventId: event.eventId, sequence: frame.sequence, value,
      display: displayProgress(this.cache.get(frame.runId)?.display, value) });
    return value;
  }

  async close(runId: string): Promise<void> {
    await this.database.init();
    await this.database.execute(`pragma synchronous=FULL;
      insert into machine_progress_heads(run_id,conversation_id,stream_id,sequence,event_id,closed) values(${q(runId)},'','',0,'',1)
      on conflict(run_id) do update set closed=1;`);
    this.cache.delete(runId);
  }

  /** A crash/unknown outcome can legitimately have no native message. Keep
   * the already stored partial output alongside that diagnostic; never invent
   * a completed reply or replace a real provider result with a partial one. */
  async retainPartialForOutcome(request: {
    runId: string; participantId: string; status: string; messages: ChatMessage[];
  }): Promise<ChatMessage[]> {
    if (request.status === "completed") return request.messages;
    await this.database.init();
    const head = await this.head(request.runId);
    if (!head || head.closed) return request.messages;
    await this.read(head);
    const display = this.cache.get(request.runId)?.display;
    const agent = display?.agentProgress;
    if (!agent?.messageId || agent.participantId !== request.participantId || !agent.partialContent) return request.messages;
    const existing = request.messages.find(message => message.id === agent.messageId);
    if (existing?.content.trim()) return request.messages;
    const partial: ChatMessage = { ...existing, id: agent.messageId, role: "participant", participantId: request.participantId,
      content: agent.partialContent, status: existing?.status ?? "pending", createdAt: existing?.createdAt ?? display!.createdAt,
      metadata: { ...existing?.metadata, runId: request.runId, ...(agent.activityEvents ? { activityEvents: agent.activityEvents } : {}) } };
    return existing ? request.messages.map(message => message.id === partial.id ? partial : message) : [...request.messages, partial];
  }

  /** Overlay only pending rows at read time. A completed answer can never be
   * replaced by late progress, and each frame avoids rewriting message rows. */
  async overlay(conversationId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
    if (!messages.some(message => message.status === "pending" && message.metadata?.runId)) return messages;
    await this.database.init();
    const heads = await this.database.query<ProgressHead>(`select ${HEAD_COLUMNS} from machine_progress_heads where conversation_id=${q(conversationId)} and closed=0;`);
    if (!heads.length) return messages;
    const byId = new Map(messages.map(message => [message.id, message]));
    for (const head of heads) {
      await this.read(head);
      const agent = this.cache.get(head.runId)?.display?.agentProgress;
      const message = agent?.messageId ? byId.get(agent.messageId) : undefined;
      if (!message || message.status !== "pending" || message.metadata?.runId !== head.runId ||
          (agent?.participantId && message.participantId !== agent.participantId)) continue;
      byId.set(message.id, { ...message, content: agent?.partialContent ?? message.content,
        metadata: { ...message.metadata, ...(agent?.activityEvents ? { activityEvents: agent.activityEvents } : {}) } });
    }
    return messages.map(message => byId.get(message.id)!);
  }

  private async head(runId: string): Promise<ProgressHead | undefined> {
    return (await this.database.query<ProgressHead>(`select ${HEAD_COLUMNS} from machine_progress_heads where run_id=${q(runId)};`))[0];
  }

  private async read(head: ProgressHead): Promise<ReviewProgress> {
    let cached = this.cache.get(head.runId);
    if (cached?.eventId === head.eventId) return cached.value;
    if (cached && cached.sequence > head.sequence) cached = undefined;
    let sequence = cached?.sequence ?? 0;
    let value = cached?.value;
    let display = cached?.display;
    let eventId = cached?.eventId;
    while (sequence < head.sequence) {
      const rows = await this.database.query<{ envelope: string }>(`with candidates as (
        select f.sequence,e.envelope_json as envelope from machine_progress_frames f join chat_events e on e.event_id=f.event_id
        where f.run_id=${q(head.runId)} and f.sequence>${sequence} and f.sequence<=${head.sequence} order by f.sequence limit 100
      ), page as (select *,sum(length(cast(envelope as blob))) over(order by sequence) as bytes,row_number() over(order by sequence) as ordinal from candidates)
      select envelope from page where bytes<=1048576 or ordinal=1 order by sequence;`);
      if (!rows.length) throw new Error("Stored machine progress has a missing frame.");
      for (const row of rows) {
        const event = JSON.parse(row.envelope) as ChatEventEnvelope;
        const frame = await this.database.hydrate(event.payload) as MachineProgressFrame;
        if (frame.runId !== head.runId || frame.streamId !== head.streamId || frame.sequence !== sequence + 1 ||
            frame.conversationId !== head.conversationId || event.conversationId !== head.conversationId || event.kind !== frame.type ||
            (frame.previousEventId ?? null) !== (eventId ?? null) || event.eventId !== machineProgressEventId(frame)) {
          throw new Error("Stored machine progress has a broken frame chain.");
        }
        value = decodeMachineProgress(value, frame);
        display = displayProgress(display, value);
        sequence = frame.sequence;
        eventId = event.eventId;
      }
    }
    if (!value || eventId !== head.eventId) throw new Error("Stored machine progress does not match its head.");
    this.cache.set(head.runId, { eventId, sequence, value, display });
    return value;
  }
}

function q(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

function displayProgress(previous: ReviewProgress | undefined, next: ReviewProgress): ReviewProgress | undefined {
  if (!next.agentProgress?.messageId) return previous;
  if (next.agentProgress.state === "finished" && previous?.agentProgress?.messageId === next.agentProgress.messageId) {
    return { ...next, agentProgress: { ...previous.agentProgress, ...next.agentProgress } };
  }
  return next;
}
