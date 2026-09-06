import { createHash, randomUUID } from "node:crypto";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { encodeMachineProgress, machineProgressEventId, progressStructure, type MachineProgressFrame } from "../../shared/machineProgress";
import type { ReviewProgress } from "../../shared/types";

interface PendingProgress { structure: string; frame: MachineProgressFrame; frozen: boolean; }

/** Text snapshots coalesce before the next flush; observed state changes do
 * not. A failed write retains the identical frame/id ahead of later updates. */
export class MachineProgressSender {
  private readonly streamId = randomUUID();
  private readonly pending: PendingProgress[] = [];
  private latest?: ReviewProgress;
  private tailBase?: ReviewProgress;
  private latestEventId?: string;
  private sequence = 0;
  private flushing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private finished = false;
  private stopped = false;
  private failed = false;

  constructor(private readonly options: {
    conversationId: string;
    publish(frame: MachineProgressFrame): Promise<ChatEventEnvelope>;
    stored(event: ChatEventEnvelope, frame: MachineProgressFrame): Promise<unknown>;
    onError(error: unknown): void;
    onRecovered(): void;
  }) {}

  note(progress: ReviewProgress): void {
    if (this.finished) return;
    const value = structuredClone(progress);
    const structure = createHash("sha256").update(progressStructure(value)).digest("hex");
    const last = this.pending.at(-1);
    if (last && !last.frozen && last.structure === structure) {
      last.frame = encodeMachineProgress(this.tailBase, value, last.frame);
    } else {
      const frame = encodeMachineProgress(this.latest, value, { conversationId: this.options.conversationId,
        streamId: this.streamId, sequence: ++this.sequence, previousEventId: this.latestEventId });
      this.pending.push({ structure, frame, frozen: false });
      this.tailBase = this.latest;
      this.latestEventId = machineProgressEventId(frame);
    }
    // Retain only two full snapshots; a slow/full disk queues deltas, not a
    // cumulative answer copy for every observed tool transition.
    this.latest = value;
    this.schedule(last && last.structure === structure ? 100 : 0);
  }

  hasPending(): boolean { return this.pending.length > 0; }

  async finish(): Promise<void> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  close(): void {
    this.stopped = true;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const work = (async () => {
      while (this.pending.length) {
        const item = this.pending[0];
        item.frozen = true;
        const event = await this.options.publish(item.frame);
        await this.options.stored(event, item.frame);
        this.pending.shift();
      }
      if (this.failed) {
        this.failed = false;
        this.options.onRecovered();
      }
    })();
    this.flushing = work;
    try { await work; }
    catch (error) {
      this.failed = true;
      this.options.onError(error);
      this.schedule(1000);
      throw error;
    } finally { if (this.flushing === work) this.flushing = undefined; }
  }

  private schedule(delay: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, delay);
    this.timer.unref?.();
  }
}
