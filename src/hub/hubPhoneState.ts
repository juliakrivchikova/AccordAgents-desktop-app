import { HUB_FEED_WAIT_MAX_MS, hubTurnRunId, type HubCard } from "../shared/hubOps";
import type { HubDevice, HubMachineWakeRequest, HubMachineStatus, HubPhoneScope } from "../shared/hubProtocol";
import { decodeMachineProgress, type MachineProgressFrame } from "../shared/machineProgress";
import { machineWakeRequest, webCryptoMachineWake, type MachineWakeSubtleCrypto } from "../shared/machineWakeRequest";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation, ReviewProgress } from "../shared/types";
import type { HubNotice } from "../main/services/hubStorage";
import type { StorageService } from "../main/services/storage";

/**
 * What the hub works out for the phone, so that the phone needs no other
 * device to be awake: each running member's live progress, the notices a
 * phone is rung for, and the machines it can wake. The cards waiting for the
 * User are the server's own (hub_cards, HubOps).
 */

/** A run's live progress as the hub folded it from its author's frames. */
interface LiveRun {
  conversationId: string;
  streamId: string;
  sequence: number;
  progress: ReviewProgress;
  updatedAt: number;
}

/** Runs the hub keeps live progress for; the oldest are forgotten first. */
const LIVE_RUNS_MAX = 200;
/** A run that says nothing for this long is no longer shown as live. */
const LIVE_RUN_IDLE_MS = 30 * 60_000;
/** Text the phone is sent of a run's answer so far (its end). */
const LIVE_TEXT_TAIL_CHARS = 12_000;

export class HubProgress {
  private readonly runs = new Map<string, LiveRun>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A progress frame, as the computer or a machine posted it. */
  noteFrame(frame: MachineProgressFrame): void {
    if (!frame || typeof frame.runId !== "string" || typeof frame.streamId !== "string" || typeof frame.conversationId !== "string" ||
        !Number.isSafeInteger(frame.sequence)) return;
    const current = this.runs.get(frame.runId);
    // Another stream of the same run (a restarted author) starts again from
    // its own first frame; a frame out of turn waits for the next base.
    const base = current && current.streamId === frame.streamId && frame.sequence === current.sequence + 1 ? current.progress : undefined;
    if (current && current.streamId === frame.streamId && frame.sequence <= current.sequence) return;
    let progress: ReviewProgress;
    try {
      progress = decodeMachineProgress(base, frame);
    } catch {
      // A frame whose base the hub missed: shown again from the next frame
      // that carries its whole text.
      return;
    }
    this.runs.delete(frame.runId);
    this.runs.set(frame.runId, { conversationId: frame.conversationId, streamId: frame.streamId, sequence: frame.sequence, progress, updatedAt: this.now() });
    while (this.runs.size > LIVE_RUNS_MAX) {
      const [oldest] = this.runs.keys();
      this.runs.delete(oldest);
    }
  }

  /** The run ended (its message settled in the hub's copy). */
  settle(runId: string): void {
    this.runs.delete(runId);
  }

  /** The live runs of one chat, newest progress each. */
  forConversation(conversationId: string): ReviewProgress[] {
    const now = this.now();
    const found: ReviewProgress[] = [];
    for (const [runId, run] of this.runs) {
      if (now - run.updatedAt > LIVE_RUN_IDLE_MS) {
        this.runs.delete(runId);
        continue;
      }
      if (run.conversationId === conversationId) found.push(run.progress);
    }
    return found;
  }
}

/** The pending row a live run shows on the phone, built from the hub's copy
 *  and the progress the desktop and the machines report. */
export function liveTimelineEvents(conversation: Conversation, runs: ReviewProgress[]): Array<Record<string, unknown>> {
  const byRun = new Map(runs.map((progress) => [progress.runId, progress]));
  const events: Array<Record<string, unknown>> = [];
  for (const message of conversation.messages) {
    if (message.role !== "participant" || message.status !== "pending") continue;
    const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : undefined;
    const progress = runId ? byRun.get(runId) : undefined;
    const agent = progress?.agentProgress;
    const partial = agent?.partialContent?.trim();
    const content = (partial ? partial.slice(-LIVE_TEXT_TAIL_CHARS) : undefined) ||
      agent?.remoteRunStatus?.label?.trim() || agent?.activity?.trim() ||
      (message.participantLabel ? `${message.participantLabel} is running...` : "Running...");
    const mobileEventId = typeof message.metadata?.mobileEventId === "string" ? message.metadata.mobileEventId : undefined;
    const sourceMessageId = typeof message.metadata?.sourceMessageId === "string" && message.metadata.sourceMessageId ? message.metadata.sourceMessageId : undefined;
    events.push({
      id: message.id,
      role: "participant",
      ...(message.participantLabel ? { participantLabel: message.participantLabel } : {}),
      // With the run id, what a Stop names the turn on the server by.
      ...(message.participantId ? { participantId: message.participantId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      content,
      status: "pending",
      createdAt: message.createdAt,
      ...(runId ? { runId } : {}),
      messageId: message.id,
      ...(mobileEventId ? { mobileEventId } : {})
    });
  }
  return events;
}

/** Whether a phone's scope covers a chat. */
export function scopeCovers(scope: HubPhoneScope | undefined, conversationId: string): boolean {
  if (!scope) return false;
  return scope.scope === "device" || scope.conversationId === conversationId;
}

/** A member's reply settled in the hub's copy: the notice a phone is shown. */
export function replyNotice(conversation: Conversation, message: ChatMessage): Omit<HubNotice, "seq"> {
  // Who, not what: the notification names the chat and the member; the text
  // is read in the app.
  const who = message.participantLabel?.trim() || "A member";
  return {
    conversationId: conversation.id,
    kind: "reply",
    title: conversation.title || "Chat",
    body: message.status === "error" ? `${who} stopped.` : `${who} replied.`,
    createdAt: new Date().toISOString()
  };
}

/** A card raised on the server for the User: the notice a phone is shown.
 *  Who asks, not what: the card is read in the app. */
export function cardNotice(conversation: Conversation, card: HubCard): Omit<HubNotice, "seq"> {
  const approval = (card.card as { approval?: ChatAppToolApproval }).approval;
  const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as ChatParticipant[] : [];
  const handle = approval?.requesterHandle || participants.find((participant) => participant?.id === card.participantId)?.handle;
  const who = handle ? `@${handle.replace(/^@/, "")}` : "A member";
  return {
    conversationId: conversation.id,
    kind: "approval",
    title: conversation.title || "Chat",
    body: `${who} is waiting for your answer.`,
    createdAt: new Date().toISOString()
  };
}

type WakeConfig = HubMachineWakeRequest["machines"][number];

/** The turns a User's message asks of members on machines: which machine
 *  each runs on, and the turn's id (hubTurnRunId), by which the server tells
 *  whether the machine took it. */
export function phoneMessageWork(conversation: Conversation, message: ChatMessage): Array<{ machineId: string; runId: string }> {
  const targets = message.metadata && Array.isArray((message.metadata as { deliveryTargets?: unknown }).deliveryTargets)
    ? (message.metadata as { deliveryTargets: unknown[] }).deliveryTargets.filter((id): id is string => typeof id === "string")
    : [];
  const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as ChatParticipant[] : [];
  return [...new Set(targets)].flatMap((id) => {
    const home = participants.find((participant) => participant?.id === id)?.homeMachineId;
    return typeof home === "string" && home ? [{ machineId: home, runId: hubTurnRunId(message.id, id) }] : [];
  });
}

/** How long a machine may leave work unread before the hub wakes it. */
export const HUB_WAKE_AFTER_MS = 30_000;
/** One start request per machine this often at most. */
const WAKE_MIN_INTERVAL_MS = 5 * 60_000;
/** AWS refused a start because the instance is still stopping: asked again
 *  this soon, and not counted as a try for this long after the first such
 *  answer (an instance stuck stopping, or gone, then shows its error). */
const WAKE_WHILE_STOPPING_RETRY_MS = 30_000;
const WAKE_WHILE_STOPPING_GRACE_MS = 10 * 60_000;
/** Work a machine read but did not take is stranded only when the machine
 *  went away this soon after reading it (it was stopping). One that went on
 *  reading turned it down for a reason a start does not change: forgotten,
 *  as read work always was. */
const READ_UNTAKEN_STRANDED_WITHIN_MS = 2 * 60_000;
/** A machine that read its work is not reading any more once this long has
 *  passed without a read: longer than one long wait of the feed and what
 *  it applies after. */
const READ_UNTAKEN_SILENCE_MS = 2 * HUB_FEED_WAIT_MAX_MS + 10_000;
/** A Wake from the phone is answered this often at most. */
const MANUAL_WAKE_MIN_INTERVAL_MS = 60_000;
/** Automatic starts for one piece of waiting work, at most, and how long
 *  work is waited for at all. */
const HUB_WAKES_PER_WORK_MAX = 3;
const HUB_WORK_WAIT_MAX_MS = 2 * 60 * 60_000;
const WAKE_CHECK_MS = 10_000;

/**
 * Starts a stopped AWS machine when work waits for it: work for one of its
 * members is on the server and the machine has not read its feed for a while.
 * The hub holds a key that can only start the User's tagged instances, given
 * by the owner desktop; the phone holds none and asks the hub instead.
 */
export class HubWaker {
  /** Work waiting per machine: since when, where in the feed, and how
   *  many times the hub started the machine for it. */
  private readonly waiting = new Map<string, { since: number; hubSeq: number; wakes: number; runIds: Set<string>; cardIds: Set<string>; readAt?: number }>();
  private readonly attempts = new Map<string, { at: number; manual: boolean; result: string; ok: boolean; stopping?: boolean; stoppingSince?: number }>();
  private checking = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    storage: StorageService;
    fetchImpl?: typeof fetch;
    /** Local QA only: where the EC2 API is reached instead of AWS. */
    endpointOverride?: string;
    subtle?: MachineWakeSubtleCrypto;
    now?: () => number;
    log?: (event: string, payload: Record<string, unknown>) => void;
    /** Whether any of these is still not taken: a turn still requested, a
     *  card's answer not yet applied. */
    untaken?: (work: { runIds: string[]; cardIds: string[] }) => Promise<boolean>;
  }) {}

  start(): void {
    this.timer ??= setInterval(() => { void this.check().catch((error) => this.options.log?.("hub.wake.check-error", { message: error instanceof Error ? error.message : String(error) })); }, WAKE_CHECK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Work for a member homed on `machineId` landed at `hubSeq`: a turn
   *  (`runId`) or a card's answer (`cardId`) it is to take. */
  noteWork(machineId: string, hubSeq: number, item: { runId?: string; cardId?: string } = {}): void {
    let current = this.waiting.get(machineId);
    if (!current) {
      current = { since: this.now(), hubSeq, wakes: 0, runIds: new Set(), cardIds: new Set() };
      this.waiting.set(machineId, current);
    } else if (hubSeq > current.hubSeq) {
      // New work tries again: its own wait, its own starts.
      Object.assign(current, { since: this.now(), hubSeq, wakes: 0, readAt: undefined });
    }
    if (item.runId) current.runIds.add(item.runId);
    if (item.cardId) current.cardIds.add(item.cardId);
  }

  private async configs(): Promise<Map<string, WakeConfig>> {
    const rows = await this.options.storage.hub().machineWake();
    const configs = new Map<string, WakeConfig>();
    for (const row of rows) {
      try {
        const config = JSON.parse(row.configJson) as WakeConfig;
        if (config.machineId === row.machineId) configs.set(row.machineId, config);
      } catch { /* an unreadable key is no key */ }
    }
    return configs;
  }

  private async machineDevices(): Promise<Map<string, HubDevice>> {
    return new Map((await this.options.storage.hub().devices())
      .filter((device) => device.role === "machine" && device.machineId)
      .map((device) => [device.machineId as string, device]));
  }

  /** Wakes the machines whose work has waited; forgets work they have read. */
  async check(): Promise<void> {
    // One pass at a time: a pass waits on AWS, and two would start a
    // machine twice.
    if (this.waiting.size === 0 || this.checking) return;
    this.checking = true;
    try {
      await this.checkNow();
    } finally {
      this.checking = false;
    }
  }

  private async checkNow(): Promise<void> {
    const devices = await this.machineDevices();
    // Where each machine read the server's feed (its work is placed there).
    const cursors = await this.options.storage.hubOps().cursorTimes();
    const configs = await this.configs();
    for (const [machineId, work] of [...this.waiting]) {
      const device = devices.get(machineId);
      const cursor = device ? cursors.get(device.deviceId) : undefined;
      const lastRead = cursor ? Date.parse(cursor.updatedAt) : 0;
      if (cursor && cursor.hubSeq >= work.hubSeq) {
        // Read past the work: the machine is awake and has it, unless it
        // read it and did not take it.
        if (!await this.untaken(work)) {
          this.waiting.delete(machineId);
          continue;
        }
        work.readAt ??= this.now();
        if (this.now() - lastRead < READ_UNTAKEN_SILENCE_MS) {
          // Still reading: it went on after it read the work, so it turned
          // it down for its own reason. Forgotten, as read work always was.
          if (this.now() - work.readAt > READ_UNTAKEN_STRANDED_WITHIN_MS) this.waiting.delete(machineId);
          continue;
        }
        // It stopped reading right after it read the work (it was
        // stopping): the work is stranded, and the machine is started for it.
      } else if (this.now() - work.since < HUB_WAKE_AFTER_MS || this.now() - lastRead < HUB_WAKE_AFTER_MS) continue;
      const config = configs.get(machineId);
      // A machine started this often for the same work that still does not
      // read it (an older runtime, a crash at start) is not started again
      // and again at the User's cost: new work, or the phone's Wake, tries.
      if (!config || work.wakes >= HUB_WAKES_PER_WORK_MAX || this.now() - work.since > HUB_WORK_WAIT_MAX_MS) {
        if (config) this.options.log?.("hub.wake.given-up", { machineId, wakes: work.wakes });
        this.waiting.delete(machineId);
        continue;
      }
      const result = await this.wake(config, false);
      if (result.attempted && !result.stopping) work.wakes += 1;
    }
  }

  private async untaken(work: { runIds: Set<string>; cardIds: Set<string> }): Promise<boolean> {
    if (!this.options.untaken || (work.runIds.size === 0 && work.cardIds.size === 0)) return false;
    try {
      // The newest few: a machine that took none of a long run of them is
      // woken for the newest as surely as for all.
      return await this.options.untaken({ runIds: [...work.runIds].slice(-100), cardIds: [...work.cardIds].slice(-100) });
    } catch {
      return false;
    }
  }

  /** The phone's Wake button: asks AWS now, unless it was just asked. */
  async wakeNow(machineId: string): Promise<{ ok: boolean; message: string }> {
    const config = (await this.configs()).get(machineId);
    if (!config) return { ok: false, message: "This server has no key to start that machine. Open Settings → Machines on your computer." };
    const { ok, message } = await this.wake(config, true);
    return { ok, message };
  }

  private async wake(config: WakeConfig, manual: boolean): Promise<{ ok: boolean; message: string; attempted: boolean; stopping?: boolean }> {
    const last = this.attempts.get(config.machineId);
    const interval = last?.stopping && !manual ? WAKE_WHILE_STOPPING_RETRY_MS : manual ? MANUAL_WAKE_MIN_INTERVAL_MS : WAKE_MIN_INTERVAL_MS;
    if (last && this.now() - last.at < interval) return { ok: last.ok, message: last.result, attempted: false };
    const at = this.now();
    let ok = false;
    let stopping = false;
    let stoppingSince: number | undefined;
    let message: string;
    try {
      const subtle = this.options.subtle ?? (globalThis.crypto?.subtle as unknown as MachineWakeSubtleCrypto);
      const signed = await machineWakeRequest({ action: "start", instanceId: config.instanceId, credentials: config.credentials, crypto: webCryptoMachineWake(subtle) });
      const url = this.options.endpointOverride ? this.options.endpointOverride : signed.url;
      const { host: _host, ...headers } = signed.headers;
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        method: signed.method,
        // The host is the URL's: fetch sets it, and it is what was signed.
        headers,
        body: signed.body,
        signal: AbortSignal.timeout(15_000)
      });
      const text = await response.text().catch(() => "");
      ok = response.ok;
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      // Still stopping (it stopped itself a moment ago): started once it
      // has, for a while; past that it is an error like any other, for as
      // long as AWS gives this answer.
      // An episode is answers in a row: one from long before starts anew.
      const episode = last?.stoppingSince !== undefined && at - last.at <= WAKE_WHILE_STOPPING_GRACE_MS ? last.stoppingSince : at;
      stoppingSince = !response.ok && code === "IncorrectInstanceState" ? episode : undefined;
      stopping = stoppingSince !== undefined && at - stoppingSince <= WAKE_WHILE_STOPPING_GRACE_MS;
      message = response.ok ? "Starting the machine."
        : stopping ? (manual ? "The machine is still stopping. Press Wake again in a minute." : "The machine is still stopping; it is started once it has stopped.")
          : `AWS refused to start the machine (${response.status}${code ? `: ${code}` : ""}).`;
    } catch (error) {
      message = `The machine could not be started: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.attempts.set(config.machineId, { at, manual, result: message, ok, ...(stopping ? { stopping } : {}), ...(stoppingSince !== undefined ? { stoppingSince } : {}) });
    await this.options.storage.hub().noteMachineWakeAttempt(config.machineId, new Date(at).toISOString(), message).catch(() => undefined);
    this.options.log?.("hub.wake.attempt", { machineId: config.machineId, manual, ok, message });
    return { ok, message, attempted: true, ...(stopping ? { stopping } : {}) };
  }

  /** What the phone shows about each machine. */
  async status(): Promise<HubMachineStatus[]> {
    const devices = await this.machineDevices();
    // When each machine last read the server's feed.
    const cursors = await this.options.storage.hubOps().cursorTimes();
    const configs = await this.configs();
    return [...devices.entries()].map(([machineId, device]) => {
      const cursor = cursors.get(device.deviceId);
      const attempt = this.attempts.get(machineId);
      const work = this.waiting.get(machineId);
      // Still stopping counts: it is started once it has stopped.
      const waking = Boolean(work && attempt && (attempt.ok || attempt.stopping) && attempt.at >= work.since && (!cursor || Date.parse(cursor.updatedAt) < attempt.at));
      return {
        machineId,
        name: device.name,
        ...(cursor ? { lastSeenAt: cursor.updatedAt } : {}),
        waking,
        ...(attempt && !attempt.ok && !attempt.stopping ? { wakeError: attempt.result } : {}),
        canWake: configs.has(machineId)
      };
    });
  }
}
