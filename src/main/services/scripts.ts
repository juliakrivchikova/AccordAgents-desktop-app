import { randomUUID } from "node:crypto";
import { homedir, uptime } from "node:os";
import path from "node:path";
import {
  describeScriptSchedule,
  nextCronRun,
  nextScriptDueAt,
  scriptLateGraceMs,
  validateScriptSchedule
} from "../../shared/scriptSchedule";
import {
  SCRIPT_DEFAULT_MAX_WAKEUPS_PER_HOUR,
  SCRIPT_DEFAULT_TIMEOUT_SECONDS,
  SCRIPT_MAX_CHATS,
  SCRIPT_MAX_HELD_MESSAGES,
  SCRIPT_MAX_MESSAGES_PER_HOUR,
  SCRIPT_MAX_MESSAGES_PER_RUN,
  SCRIPT_MAX_TIMEOUT_SECONDS,
  SCRIPT_MAX_WAKEUPS_PER_HOUR,
  SCRIPT_MESSAGE_MAX_CHARS,
  SCRIPT_MIN_TIMEOUT_SECONDS,
  SCRIPT_OUTPUT_TAIL_CHARS,
  SCRIPT_SECRET_NAME_PATTERN,
  isReservedScriptSecretName,
  type ChatScriptChangeRequest,
  type ScheduledScriptSummary,
  type ScriptApiPostMessageRequest,
  type ScriptApiPostMessageResult,
  type ScriptChangeToolRequest,
  type ScriptFile,
  type ScriptHealth,
  type ScriptPermissions,
  type ScriptRevisionContent,
  type ScriptRunRow,
  type ScriptRunStatus,
  type ScriptSchedule
} from "../../shared/scripts";
import { CommandError, commandEnvironment, runCommand } from "./command";
import {
  newScriptId,
  scriptContentHash,
  validateScriptFiles,
  type ScriptRateState,
  type ScriptRecord,
  type ScriptRevision,
  type ScriptSecretStore,
  type ScriptStore
} from "./scriptStore";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_RETENTION_MS = 7 * DAY_MS;
const UNAPPROVED_PROPOSAL_TTL_MS = 7 * DAY_MS;
const HISTORY_MAX_ROWS = 500;
const HISTORY_OUTPUT_TAILS = 20;
const DEFAULT_TICK_MS = 15_000;
const STOP_WAIT_MS = 3000;
const SECRET_MAX_CHARS = 8192;
const MAX_SECRETS = 16;
const MAX_MENTIONS = 10;
const NAME_MAX_CHARS = 80;
const DESCRIPTION_MAX_CHARS = 600;
const REASON_MAX_CHARS = 500;
/** An interval script must fail twice in a row before the User is told, so a
 *  network blip right after waking from sleep is not reported. */
const INTERVAL_FAILURES_BEFORE_NOTICE = 2;
/** At most one "is failing" notice per script per hour, however it flaps. */
const FAILING_NOTICE_MIN_GAP_MS = HOUR_MS;

export class ScriptApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ScriptApiError";
  }
}

export interface ScriptChatParticipant {
  id: string;
  handle: string;
}

export interface ScriptChatInfo {
  id: string;
  title: string;
  archived: boolean;
  participants: ScriptChatParticipant[];
}

/** What the script service needs from the chat side. */
export interface ScriptChatGateway {
  describeChat(chatId: string): Promise<ScriptChatInfo | undefined>;
  postScriptMessage(input: {
    conversationId: string;
    scriptId: string;
    scriptName: string;
    content: string;
    participantIds: string[];
  }): Promise<{ messageId: string }>;
}

/** The local script API's tokens, served by AppMcpService. */
export interface ScriptApiTokenIssuer {
  scriptApiUrl(): string | undefined;
  issueScriptToken(context: { scriptId: string; runId: string }): string;
  revokeScriptToken(token: string): void;
}

export interface ScriptServiceOptions {
  store: ScriptStore;
  secrets: ScriptSecretStore;
  hostId: string;
  hostLabel: string;
  /** The host inside a sentence, e.g. "this Mac". */
  hostPhrase: string;
  tokens: ScriptApiTokenIssuer;
  chat: ScriptChatGateway;
  /** How to start a `node` script: `node` from the User's PATH on the
   *  desktop (the packaged app cannot run as Node), the Node running the
   *  machine runtime on a machine. */
  node: { command: string; env: Record<string, string> };
  bash?: string;
  now?: () => number;
  tickMs?: number;
  bootAt?: () => number;
  /** Start time of a live process, for checking a recorded pid before a kill. */
  processStartedAt?: (pid: number) => Promise<number | undefined>;
  debugLog?: (event: string, payload: Record<string, unknown>) => void;
  onChanged?: () => void;
}

export interface ProposeScriptChangeInput {
  conversationId: string;
  requesterParticipantId: string;
  requesterLabel: string;
  request: unknown;
}

export type ProposeScriptChangeResult =
  | { kind: "approval"; request: ChatScriptChangeRequest; summary: string; missingSecretNames: string[] }
  | { kind: "ran"; scriptId: string; name: string };

interface RunningScript {
  runId: string;
  controller: AbortController;
  token: string;
  messagesSent: number;
  /** Posts accepted by the per-run check but not finished yet. */
  messagesInFlight: number;
  secretValues: string[];
  stopReason?: "stopped" | "interrupted";
  done: Promise<void>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmedString(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (!text) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} is at most ${max} characters.`);
  return text;
}

function boundedInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function normalizeSchedule(value: unknown): ScriptSchedule {
  const candidate = value as Partial<ScriptSchedule> | undefined;
  if (!candidate || typeof candidate !== "object") throw new Error("schedule is required.");
  if (candidate.kind !== "interval" && candidate.kind !== "cron") throw new Error("schedule.kind is \"interval\" or \"cron\".");
  const schedule: ScriptSchedule = candidate.kind === "interval"
    ? { kind: "interval", everySeconds: (candidate as { everySeconds?: number }).everySeconds as number }
    : { kind: "cron", expression: String((candidate as { expression?: string }).expression ?? ""), timeZone: String((candidate as { timeZone?: string }).timeZone ?? "") };
  validateScriptSchedule(schedule);
  return schedule;
}

function normalizeSecretNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("secretNames must be a list of names.");
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !SCRIPT_SECRET_NAME_PATTERN.test(item)) {
      throw new Error(`Key name "${String(item)}" must be UPPER_SNAKE_CASE, like SLACK_BOT_TOKEN.`);
    }
    if (isReservedScriptSecretName(item)) {
      throw new Error(`Key name ${item} is reserved: it would change how the script starts. Use another name, like MY_${item}.`);
    }
    names.add(item);
  }
  if (names.size > MAX_SECRETS) throw new Error(`A script has at most ${MAX_SECRETS} keys.`);
  return [...names].sort();
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? (last.length > 240 ? `${last.slice(0, 239)}…` : last) : undefined;
}

/** Replace every key value the script was given with •••. */
export function redactScriptOutput(text: string, secretValues: readonly string[]): string {
  let result = text;
  for (const value of [...secretValues].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join("•••");
  }
  return result;
}

/** Redact, then keep the last `maxChars`; a key cut by the start of the tail
 *  is masked too, so no fragment of a value survives truncation. */
export function redactedTail(text: string, secretValues: readonly string[], maxChars: number): string {
  let tail = redactScriptOutput(text, secretValues);
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  for (const value of secretValues.filter((item) => item.length >= 4)) {
    for (let length = Math.min(value.length - 1, tail.length); length >= 4; length -= 1) {
      if (tail.startsWith(value.slice(-length))) {
        tail = `•••${tail.slice(length)}`;
        break;
      }
    }
  }
  return tail;
}

function humanTime(ms: number, timeZone?: string): string {
  try {
    return new Date(ms).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso(ms);
  }
}

/** Start time of a live process via ps, or undefined when it is gone. */
async function psStartedAt(pid: number): Promise<number | undefined> {
  try {
    const result = await runCommand("ps", ["-p", String(pid), "-o", "lstart="], { timeoutMs: 5000, primeLoginShellEnv: false, env: { LC_ALL: "C", LANG: "C" } });
    const parsed = Date.parse(result.stdout.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Scheduled scripts on one host: proposal, approval, schedule, runs, and
 *  the script API's message path. */
export class ScriptService {
  private readonly running = new Map<string, RunningScript>();
  /** Scripts whose run is being prepared: the slot is taken before the
   *  first await, so two starts can never both pass the check. */
  private readonly starting = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  /** Timers arm only after start(); runs are refused only after stop(). */
  private started = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly tickMs: number;

  constructor(private readonly options: ScriptServiceOptions) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  private log(event: string, payload: Record<string, unknown>): void {
    try {
      this.options.debugLog?.(event, payload);
    } catch {
      // Debug logging never breaks a run.
    }
  }

  private changed(): void {
    try {
      this.options.onChanged?.();
    } catch {
      // A listener failure must not break the script that changed.
    }
  }

  private bootAt(): number {
    return this.options.bootAt?.() ?? Date.now() - uptime() * 1000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.started = true;
    for (const id of await this.options.store.listIds()) {
      await this.recoverLeftoverRun(id).catch((error) => {
        this.log("scripts.recover.error", { scriptId: id, message: errorMessage(error) });
      });
    }
    this.schedule(0);
  }

  /** Stop the scheduler and every running script; their runs are recorded
   *  as interrupted. Bounded: quitting never waits on a slow tick. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());
    if (this.ticking) await Promise.race([this.ticking.catch(() => undefined), wait(STOP_WAIT_MS)]);
    const runs = [...this.running.values()];
    for (const run of runs) {
      run.stopReason = "interrupted";
      run.controller.abort();
    }
    await Promise.race([Promise.allSettled(runs.map((run) => run.done)), wait(STOP_WAIT_MS)]);
  }

  /** A run that was going when the host crashed: kill what is left of its
   *  process group, but only after proving the pid is still that run's
   *  process (same boot, same start time), and record it, before any new run
   *  of that script can start. */
  private async recoverLeftoverRun(id: string): Promise<void> {
    const pid = await this.options.store.readPid(id);
    if (!pid) return;
    const valid = Number.isInteger(pid.pid) && pid.pid > 1 && process.platform !== "win32";
    const sameBoot = Math.abs(pid.bootAt - this.bootAt()) < 120_000;
    if (valid && sameBoot) {
      const startedAt = await (this.options.processStartedAt ?? psStartedAt)(pid.pid);
      const recordedAt = Date.parse(pid.startedAt);
      // ps reports whole seconds; a reused pid started at another time.
      if (startedAt !== undefined && Number.isFinite(recordedAt) && Math.abs(startedAt - recordedAt) < 3000) {
        try {
          process.kill(-pid.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await this.options.store.clearPid(id);
    await this.recordRun(id, {
      status: "interrupted",
      at: this.now(),
      messagesSent: 0,
      detail: "The app quit or crashed while this run was going."
    });
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  /** Run whatever is due now. Also called on wake from sleep. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const work = this.tickOnce().finally(() => {
      this.ticking = undefined;
    });
    this.ticking = work;
    return work;
  }

  private async tickOnce(): Promise<void> {
    let nextDelay = this.tickMs;
    try {
      const now = this.now();
      for (const id of await this.options.store.listIds()) {
        // One broken script (a corrupt file, a full disk) must not stop the others.
        try {
          const nextAt = await this.tickScript(id, now);
          if (nextAt !== undefined) nextDelay = Math.min(nextDelay, Math.max(250, nextAt - now));
        } catch (error) {
          this.log("scripts.tick.script-error", { scriptId: id, message: errorMessage(error) });
        }
      }
    } catch (error) {
      this.log("scripts.tick.error", { message: errorMessage(error) });
    } finally {
      this.schedule(nextDelay);
    }
  }

  /** Handle one script at `now`; returns when it is next due, if it is scheduled. */
  private async tickScript(id: string, now: number): Promise<number | undefined> {
    const record = await this.options.store.readRecord(id);
    if (!record) return undefined;
    if (!record.approvedHash) {
      if (now - Date.parse(record.createdAt) > UNAPPROVED_PROPOSAL_TTL_MS) {
        // Never approved and the card is long gone: drop it with its keys.
        await this.deleteScript(id).catch(() => undefined);
      }
      return undefined;
    }
    if (!record.enabled) return undefined;
    const due = await this.options.store.withScript(id, async () => {
      const runtime = await this.options.store.readRuntime(id);
      let dueAt = runtime.nextDueAt ? Date.parse(runtime.nextDueAt) : Number.NaN;
      if (!Number.isFinite(dueAt)) {
        dueAt = this.firstDueAt(record.schedule, now);
        runtime.nextDueAt = iso(dueAt);
        await this.options.store.writeRuntime(id, runtime);
      }
      if (dueAt > now) return { run: false as const, nextAt: dueAt };
      const next = nextScriptDueAt(record.schedule, dueAt, now);
      runtime.nextDueAt = iso(next);
      await this.options.store.writeRuntime(id, runtime);
      return { run: true as const, dueAt, nextAt: next };
    });
    if (!due.run) return due.nextAt;
    const lateBy = now - due.dueAt;
    if (lateBy > scriptLateGraceMs(record.schedule)) {
      await this.recordRun(id, { status: "missed", at: now, messagesSent: 0, detail: "The host was asleep or the app was closed when it was due." });
      this.changed();
      return due.nextAt;
    }
    if (this.running.has(id) || this.starting.has(id)) {
      await this.recordRun(id, { status: "skipped", at: now, messagesSent: 0, detail: "The previous run was still going." });
      this.changed();
      return due.nextAt;
    }
    this.launch(id, lateBy > 60_000 ? `Started ${Math.round(lateBy / 60_000)} min late.` : undefined);
    return due.nextAt;
  }

  private firstDueAt(schedule: ScriptSchedule, now: number): number {
    return schedule.kind === "interval" ? now : nextCronRun(schedule.expression, schedule.timeZone, now);
  }

  // ---------------------------------------------------------------- runs

  /** Start one run now. Throws when it cannot start. */
  async runNow(id: string): Promise<void> {
    const record = await this.requireRecord(id);
    if (!record.approvedHash) throw new Error("Approve the script before running it.");
    if (this.running.has(id) || this.starting.has(id)) throw new Error("The script is already running.");
    this.launch(id, "Started by hand.");
  }

  /** Reserve the run slot synchronously, then prepare and run. */
  private launch(id: string, detail: string | undefined): void {
    if (this.stopped || this.running.has(id) || this.starting.has(id)) return;
    this.starting.add(id);
    void this.execute(id, detail)
      .catch((error) => {
        this.log("scripts.run.error", { scriptId: id, message: errorMessage(error) });
      })
      .finally(() => {
        this.starting.delete(id);
      });
  }

  private async execute(id: string, detail: string | undefined): Promise<void> {
    const startedAt = this.now();
    let record: ScriptRecord | undefined;
    let secretValues: Record<string, string> = {};
    let entryPath: string;
    let stateDir: string;
    let apiUrl: string;
    try {
      record = await this.options.store.readRecord(id);
      if (!record?.approvedHash) return;
      const files = await this.options.store.readInstalledFiles(id);
      if (scriptContentHash(record.runtime, record.entry, files) !== record.approvedHash) {
        await this.block(id, "Its files changed after you approved them, so it will not run until a new version is approved.");
        await this.recordRun(id, { status: "blocked", at: startedAt, messagesSent: 0, detail: "Files changed since approval." });
        this.changed();
        return;
      }
      secretValues = await this.options.secrets.values(id, record.secretNames);
      const missing = record.secretNames.filter((name) => secretValues[name] === undefined);
      if (missing.length > 0) {
        await this.recordRun(id, { status: "blocked", at: startedAt, messagesSent: 0, detail: `Waiting for keys: ${missing.join(", ")}.` });
        this.changed();
        return;
      }
      const url = this.options.tokens.scriptApiUrl();
      if (!url) throw new Error("The app's local API is not running.");
      apiUrl = url;
      stateDir = this.options.store.stateDir(id);
      entryPath = path.join(this.options.store.filesDir(id), ...record.entry.split("/"));
    } catch (error) {
      // Nothing ran, but the User must see why (an unreadable key store, a
      // missing file): record it like a failed run.
      if (record) {
        const message = errorMessage(error);
        await this.recordRun(id, { status: "failed", at: startedAt, messagesSent: 0, detail: `Could not start: ${message}` }).catch(() => undefined);
        await this.applyHealthTransition(id, record, "failed", `Could not start: ${message}`).catch(() => undefined);
        this.changed();
      }
      return;
    }
    if (this.stopped) return;
    // Switched off or deleted while the run was being prepared.
    const latest = await this.options.store.readRecord(id).catch(() => undefined);
    if (!latest?.approvedHash || (!latest.enabled && detail !== "Started by hand.")) return;
    const runId = randomUUID();
    const controller = new AbortController();
    const token = this.options.tokens.issueScriptToken({ scriptId: id, runId });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const secretList = Object.values(secretValues);
    const run: RunningScript = { runId, controller, token, messagesSent: 0, messagesInFlight: 0, secretValues: secretList, done };
    this.running.set(id, run);
    this.changed();
    // Keys first, the fixed variables after: a key can never replace them.
    const env: Record<string, string> = {
      ...secretValues,
      ...(record.runtime === "node" ? this.options.node.env : {}),
      PATH: commandEnvironment({}).PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: homedir(),
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ACCORD_API_URL: apiUrl,
      ACCORD_SCRIPT_TOKEN: token,
      ACCORD_STATE_DIR: stateDir,
      ACCORD_SCRIPT_ID: id,
      ACCORD_RUN_ID: runId
    };
    const command = record.runtime === "node" ? this.options.node.command : (this.options.bash ?? "/bin/bash");
    const keepChars = SCRIPT_OUTPUT_TAIL_CHARS + secretList.reduce((max, value) => Math.max(max, value.length), 0) + 64;
    let status: ScriptRunStatus = "ok";
    let exitCode: number | null | undefined;
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    let pidWrite: Promise<void> | undefined;
    try {
      try {
        const result = await runCommand(command, [entryPath], {
          cwd: stateDir,
          env,
          exactEnv: true,
          killProcessGroup: true,
          killGroupOnExit: true,
          primeLoginShellEnv: false,
          timeoutMs: record.timeoutSeconds * 1000,
          maxOutputChars: keepChars,
          signal: controller.signal,
          onSpawn: (pid) => {
            pidWrite = this.options.store.writePid(id, { pid, runId, bootAt: this.bootAt(), startedAt: iso(this.now()) }).catch(() => undefined);
          }
        });
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        if (error instanceof CommandError) {
          exitCode = error.result.exitCode;
          stdout = error.result.stdout;
          stderr = error.result.stderr;
          if (controller.signal.aborted) {
            status = run.stopReason ?? "stopped";
          } else if (error.result.timedOut) {
            status = "timeout";
            failure = `It ran longer than ${record.timeoutSeconds} s and was stopped.`;
          } else {
            status = "failed";
            failure = lastMeaningfulLine(redactedTail(stderr, secretList, keepChars))
              ?? lastMeaningfulLine(redactedTail(stdout, secretList, keepChars))
              ?? `It exited with code ${String(exitCode)}.`;
          }
        } else {
          status = "failed";
          failure = errorMessage(error);
        }
        if (status === "failed" && /\bENOENT\b/.test(`${failure ?? ""} ${stderr}`)) {
          failure = record.runtime === "node"
            ? "Node.js was not found on this computer. Install Node.js, or ask for a bash script instead."
            : "bash was not found on this computer.";
        }
      } finally {
        this.options.tokens.revokeScriptToken(token);
        if (this.running.get(id)?.runId === runId) this.running.delete(id);
        // The pid file is written in the background; wait for it, so the
        // clear below cannot land first and leave a stale pid behind.
        await pidWrite;
        await this.options.store.clearPid(id).catch(() => undefined);
      }
      // Each stream is redacted on its own first: either may start inside a
      // key where the output limit cut it.
      const cleanOut = redactedTail(stdout, secretList, keepChars);
      const cleanErr = redactedTail(stderr, secretList, keepChars);
      const combined = cleanErr.trim() ? `${cleanOut}${cleanOut.endsWith("\n") || !cleanOut ? "" : "\n"}[stderr]\n${cleanErr}` : cleanOut;
      const outputTail = combined.length > SCRIPT_OUTPUT_TAIL_CHARS ? combined.slice(-SCRIPT_OUTPUT_TAIL_CHARS) : combined;
      const redactedFailure = failure ? redactScriptOutput(failure, secretList) : undefined;
      await this.recordRun(id, {
        status,
        at: startedAt,
        endedAt: this.now(),
        exitCode,
        messagesSent: run.messagesSent,
        outputTail: outputTail || undefined,
        detail: [detail, redactedFailure].filter(Boolean).join(" ") || undefined
      });
      await this.applyHealthTransition(id, record, status, redactedFailure);
    } finally {
      resolveDone();
      this.changed();
    }
  }

  private async recordRun(id: string, run: {
    status: ScriptRunStatus;
    at: number;
    endedAt?: number;
    exitCode?: number | null;
    messagesSent: number;
    outputTail?: string;
    detail?: string;
  }): Promise<void> {
    await this.options.store.withScript(id, async () => {
      const record = await this.options.store.readRecord(id);
      if (!record) return;
      const rows = await this.options.store.readRuns(id);
      const at = iso(run.endedAt ?? run.at);
      const last = rows[rows.length - 1];
      const mergeable = last
        && last.status === run.status
        && last.messagesSent === 0
        && run.messagesSent === 0
        && (last.exitCode ?? null) === (run.exitCode ?? null)
        && (last.detail ?? "") === (run.detail ?? "");
      if (mergeable) {
        last.count += 1;
        last.lastAt = at;
        if (run.outputTail !== undefined) last.outputTail = run.outputTail;
      } else {
        rows.push({
          id: randomUUID(),
          status: run.status,
          count: 1,
          firstAt: iso(run.at),
          lastAt: at,
          ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
          messagesSent: run.messagesSent,
          ...(run.outputTail !== undefined ? { outputTail: run.outputTail } : {}),
          ...(run.detail ? { detail: run.detail } : {})
        });
      }
      const cutoff = this.now() - HISTORY_RETENTION_MS;
      const kept = rows.filter((row) => Date.parse(row.lastAt) >= cutoff).slice(-HISTORY_MAX_ROWS);
      kept.forEach((row, index) => {
        if (index < kept.length - HISTORY_OUTPUT_TAILS) delete row.outputTail;
      });
      await this.options.store.writeRuns(id, kept);
      if (run.status !== "skipped" && run.status !== "missed") {
        const runtime = await this.options.store.readRuntime(id);
        runtime.lastRunAt = at;
        runtime.lastRunStatus = run.status;
        await this.options.store.writeRuntime(id, runtime);
      }
    });
  }

  private async block(id: string, reason: string): Promise<void> {
    const notify = await this.options.store.withScript(id, async () => {
      if (!await this.options.store.readRecord(id)) return false;
      const runtime = await this.options.store.readRuntime(id);
      const first = runtime.blockedReason !== reason;
      runtime.blockedReason = reason;
      await this.options.store.writeRuntime(id, runtime);
      return first;
    });
    if (notify) await this.notice(id, `Blocked: ${reason}`);
  }

  /** Failing and recovered notices, debounced: an interval script must fail
   *  twice in a row, a new "is failing" notice goes out at most once an hour
   *  however the script flaps, and a recovery is announced only when the
   *  failure was. */
  private async applyHealthTransition(id: string, record: ScriptRecord, status: ScriptRunStatus, failure: string | undefined): Promise<void> {
    if (status !== "ok" && status !== "failed" && status !== "timeout") return;
    const transition = await this.options.store.withScript(id, async () => {
      // Deleted while it ran: nothing to record, and writing would recreate its directory.
      if (!await this.options.store.readRecord(id)) return undefined;
      const runtime = await this.options.store.readRuntime(id);
      const now = this.now();
      if (status === "ok") {
        if (!runtime.failingSince && !runtime.failingAnnounced) return undefined;
        const announced = runtime.failingAnnounced === true;
        runtime.failingSince = undefined;
        runtime.failureCount = 0;
        runtime.lastError = undefined;
        runtime.failingAnnounced = false;
        await this.options.store.writeRuntime(id, runtime);
        return announced ? "recovered" as const : undefined;
      }
      runtime.lastError = failure;
      runtime.failingSince = runtime.failingSince ?? iso(now);
      runtime.failureCount = (runtime.failureCount ?? 0) + 1;
      const threshold = record.schedule.kind === "interval" ? INTERVAL_FAILURES_BEFORE_NOTICE : 1;
      const lastNotice = runtime.lastFailingNoticeAt ? Date.parse(runtime.lastFailingNoticeAt) : undefined;
      const announce = runtime.failingAnnounced !== true
        && runtime.failureCount >= threshold
        && (lastNotice === undefined || now - lastNotice >= FAILING_NOTICE_MIN_GAP_MS);
      if (announce) {
        runtime.failingAnnounced = true;
        runtime.lastFailingNoticeAt = iso(now);
      }
      await this.options.store.writeRuntime(id, runtime);
      return announce ? "failing" as const : undefined;
    });
    if (transition === "failing") {
      await this.notice(id, `Failing: ${failure ?? "its last run did not succeed"}. Its history is in Settings → Scripts.`);
    } else if (transition === "recovered") {
      await this.notice(id, "Working again.");
    }
  }

  /** A message from the script itself about its own state, posted into the
   *  chat it was set up in. It mentions nobody, so it starts nobody. The
   *  script's name is already the author, so the text does not repeat it. */
  private async notice(id: string, text: string): Promise<void> {
    const record = await this.options.store.readRecord(id);
    if (!record) return;
    const chatId = record.permissions.chatIds.includes(record.createdInChatId)
      ? record.createdInChatId
      : record.permissions.chatIds[0] ?? record.createdInChatId;
    try {
      await this.options.chat.postScriptMessage({
        conversationId: chatId,
        scriptId: id,
        scriptName: record.name,
        content: text,
        participantIds: []
      });
    } catch (error) {
      this.log("scripts.notice.error", { scriptId: id, message: errorMessage(error) });
    }
  }

  // ------------------------------------------------------------ script API

  /** `POST /script-api/messages` from a running script. */
  async postFromScript(context: { scriptId: string; runId: string }, body: unknown): Promise<ScriptApiPostMessageResult> {
    const run = this.running.get(context.scriptId);
    if (!run || run.runId !== context.runId) throw new ScriptApiError(403, "This run has ended; its token is no longer valid.");
    const record = await this.options.store.readRecord(context.scriptId);
    if (!record?.approvedHash) throw new ScriptApiError(403, "The script is not approved.");
    const request = (body ?? {}) as Partial<ScriptApiPostMessageRequest>;
    if (typeof request.chatId !== "string" || !record.permissions.chatIds.includes(request.chatId)) {
      throw new ScriptApiError(403, "This script may not post to that chat.");
    }
    if (typeof request.text !== "string" || !request.text.trim()) throw new ScriptApiError(400, "text is required.");
    if (request.text.length > SCRIPT_MESSAGE_MAX_CHARS) throw new ScriptApiError(400, `text is at most ${SCRIPT_MESSAGE_MAX_CHARS} characters.`);
    const mentions = request.mentions ?? [];
    if (!Array.isArray(mentions) || mentions.length > MAX_MENTIONS || mentions.some((item) => typeof item !== "string")) {
      throw new ScriptApiError(400, `mentions is a list of at most ${MAX_MENTIONS} member handles.`);
    }
    const idempotencyKey = request.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200)) {
      throw new ScriptApiError(400, "idempotencyKey is text of at most 200 characters.");
    }
    if (idempotencyKey) {
      const rate = await this.options.store.readRate(context.scriptId);
      const previous = rate.idempotency[idempotencyKey];
      if (previous && this.now() - Date.parse(previous.at) < DAY_MS) {
        return { ok: true, status: "duplicate", ...(previous.messageId ? { messageId: previous.messageId } : {}) };
      }
    }
    if (run.messagesSent + run.messagesInFlight >= SCRIPT_MAX_MESSAGES_PER_RUN) {
      throw new ScriptApiError(429, `A run may post at most ${SCRIPT_MAX_MESSAGES_PER_RUN} messages; batch what you found into one message.`);
    }
    // Counted before the first await, so concurrent posts cannot all pass.
    run.messagesInFlight += 1;
    try {
      const result = await this.postFromScriptAccepted(context, run, record, request as Partial<ScriptApiPostMessageRequest> & { chatId: string; text: string }, mentions as string[], idempotencyKey);
      if (result.status === "posted") run.messagesSent += 1;
      return result;
    } finally {
      run.messagesInFlight -= 1;
    }
  }

  private async postFromScriptAccepted(
    context: { scriptId: string; runId: string },
    run: RunningScript,
    record: ScriptRecord,
    request: Partial<ScriptApiPostMessageRequest> & { chatId: string; text: string },
    mentions: string[],
    idempotencyKey: string | undefined
  ): Promise<ScriptApiPostMessageResult> {
    const chat = await this.options.chat.describeChat(request.chatId);
    if (!chat) throw new ScriptApiError(404, "That chat no longer exists.");
    if (chat.archived) throw new ScriptApiError(409, "That chat is archived.");
    const participantIds = this.resolveMentions(record, chat, mentions);
    // A key value never reaches a chat through the script's own message.
    const text = redactScriptOutput(request.text.trim(), run.secretValues);

    // Reserve under the lock; post outside it, so one slow chat save never
    // holds this script's queue (or the scheduler waiting on it).
    const reservation = await this.options.store.withScript(context.scriptId, async () => {
      const now = this.now();
      const rate = await this.options.store.readRate(context.scriptId);
      this.pruneRate(rate, now);
      if (idempotencyKey && rate.idempotency[idempotencyKey]) {
        const previous = rate.idempotency[idempotencyKey]!;
        return { kind: "duplicate" as const, messageId: previous.messageId };
      }
      const overWakeups = participantIds.length > 0 && rate.wakeups.length >= record.permissions.maxWakeupsPerHour;
      const overMessages = rate.posts.length >= SCRIPT_MAX_MESSAGES_PER_HOUR;
      if (overWakeups || overMessages) {
        const held = await this.options.store.readHeld(context.scriptId);
        if (held.length >= SCRIPT_MAX_HELD_MESSAGES) {
          return { kind: "full" as const };
        }
        held.push({ id: randomUUID(), chatId: chat.id, text, participantIds, createdAt: iso(now) });
        await this.options.store.writeHeld(context.scriptId, held);
        if (idempotencyKey) rate.idempotency[idempotencyKey] = { status: "held", at: iso(now) };
        await this.options.store.writeRate(context.scriptId, rate);
        return { kind: "held" as const, heldCount: held.length, first: held.length === 1, overWakeups };
      }
      rate.posts.push(iso(now));
      if (participantIds.length > 0) rate.wakeups.push(iso(now));
      if (idempotencyKey) rate.idempotency[idempotencyKey] = { status: "posting", at: iso(now) };
      await this.options.store.writeRate(context.scriptId, rate);
      return { kind: "post" as const, at: iso(now) };
    });
    if (reservation.kind === "duplicate") {
      return { ok: true, status: "duplicate", ...(reservation.messageId ? { messageId: reservation.messageId } : {}) };
    }
    if (reservation.kind === "full") {
      throw new ScriptApiError(429, `${SCRIPT_MAX_HELD_MESSAGES} messages are already held for the User; nothing more is accepted until they are released or discarded.`);
    }
    if (reservation.kind === "held") {
      if (reservation.first) {
        void this.notice(context.scriptId, reservation.overWakeups
          ? `Holding messages: it reached its limit of ${record.permissions.maxWakeupsPerHour} wake-ups per hour. Release or discard them in Settings → Scripts.`
          : `Holding messages: it reached its limit of ${SCRIPT_MAX_MESSAGES_PER_HOUR} messages per hour. Release or discard them in Settings → Scripts.`);
      }
      this.changed();
      return { ok: true, status: "held", heldCount: reservation.heldCount };
    }
    let posted: { messageId: string };
    try {
      posted = await this.options.chat.postScriptMessage({
        conversationId: chat.id,
        scriptId: record.id,
        scriptName: record.name,
        content: text,
        participantIds
      });
    } catch (error) {
      // Undo the reservation, so a retry is not refused as a duplicate.
      await this.options.store.withScript(context.scriptId, async () => {
        const rate = await this.options.store.readRate(context.scriptId);
        rate.posts = rate.posts.filter((at) => at !== reservation.at);
        if (participantIds.length > 0) {
          const index = rate.wakeups.indexOf(reservation.at);
          if (index >= 0) rate.wakeups.splice(index, 1);
        }
        if (idempotencyKey) delete rate.idempotency[idempotencyKey];
        await this.options.store.writeRate(context.scriptId, rate);
      }).catch(() => undefined);
      throw new ScriptApiError(409, errorMessage(error));
    }
    if (idempotencyKey) {
      await this.options.store.withScript(context.scriptId, async () => {
        const rate = await this.options.store.readRate(context.scriptId);
        rate.idempotency[idempotencyKey] = { messageId: posted.messageId, status: "posted", at: reservation.at };
        await this.options.store.writeRate(context.scriptId, rate);
      }).catch(() => undefined);
    }
    return { ok: true, status: "posted", messageId: posted.messageId };
  }

  private resolveMentions(record: ScriptRecord, chat: ScriptChatInfo, mentions: readonly string[]): string[] {
    const ids: string[] = [];
    for (const raw of mentions) {
      const key = raw.trim().replace(/^@/, "").toLowerCase();
      const participant = chat.participants.find((item) => item.id === raw.trim() || item.handle.toLowerCase() === key);
      if (!participant) throw new ScriptApiError(403, `@${key} is not a member of that chat.`);
      if (!record.permissions.participantIds.includes(participant.id)) {
        throw new ScriptApiError(403, `This script may not mention @${participant.handle}.`);
      }
      if (!ids.includes(participant.id)) ids.push(participant.id);
    }
    return ids;
  }

  private pruneRate(rate: ScriptRateState, now: number): void {
    rate.wakeups = rate.wakeups.filter((at) => now - Date.parse(at) < HOUR_MS);
    rate.posts = rate.posts.filter((at) => now - Date.parse(at) < HOUR_MS);
    for (const [key, entry] of Object.entries(rate.idempotency)) {
      if (now - Date.parse(entry.at) >= DAY_MS) delete rate.idempotency[key];
    }
  }

  /** Post the held messages in order. Each leaves the held list only once it
   *  is posted; one that cannot be posted (its member left the chat) stays
   *  held, the rest still go out, and the failures are reported. */
  async releaseHeld(id: string): Promise<void> {
    const record = await this.requireRecord(id);
    const held = await this.options.store.readHeld(id);
    const failures: string[] = [];
    try {
      for (const item of held) {
        if (this.now() - Date.parse(item.createdAt) >= DAY_MS) {
          await this.removeHeld(id, item.id);
          continue;
        }
        try {
          await this.options.chat.postScriptMessage({
            conversationId: item.chatId,
            scriptId: id,
            scriptName: record.name,
            content: item.text,
            participantIds: item.participantIds
          });
        } catch (error) {
          failures.push(errorMessage(error));
          continue;
        }
        await this.removeHeld(id, item.id);
      }
    } finally {
      this.changed();
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} held ${failures.length === 1 ? "message" : "messages"} could not be posted and stay held: ${failures[0]}`);
    }
  }

  private async removeHeld(id: string, heldId: string): Promise<void> {
    await this.options.store.withScript(id, async () => {
      const rows = await this.options.store.readHeld(id);
      await this.options.store.writeHeld(id, rows.filter((row) => row.id !== heldId));
    });
  }

  async discardHeld(id: string): Promise<void> {
    await this.requireRecord(id);
    await this.options.store.withScript(id, () => this.options.store.writeHeld(id, []));
    this.changed();
  }

  // ---------------------------------------------------- proposal & approval

  /** True when a script belongs to this chat: an agent may see and act on
   *  only the scripts of the chat it is in. */
  private belongsToChat(record: ScriptRecord, conversationId: string): boolean {
    return record.createdInChatId === conversationId || record.permissions.chatIds.includes(conversationId);
  }

  private async requireChatScript(id: string, conversationId: string): Promise<ScriptRecord> {
    const record = await this.requireRecord(id);
    if (!this.belongsToChat(record, conversationId)) throw new Error("That scheduled script does not belong to this chat.");
    return record;
  }

  async proposeChange(input: ProposeScriptChangeInput): Promise<ProposeScriptChangeResult> {
    const request = (input.request ?? {}) as Partial<ScriptChangeToolRequest>;
    const op = request.op;
    const reason = trimmedString(request.reason, "reason", REASON_MAX_CHARS, false);
    if (op === "run_now") {
      const record = await this.requireChatScript(String(request.scriptId ?? ""), input.conversationId);
      if (!record.enabled) throw new Error("The script is switched off; ask the User to switch it on first.");
      await this.runNow(record.id);
      return { kind: "ran", scriptId: record.id, name: record.name };
    }
    if (op === "create" || op === "update") return this.proposeRevision(input, request, op, reason);
    if (op === "delete" || op === "enable" || op === "disable") {
      const record = await this.requireChatScript(String(request.scriptId ?? ""), input.conversationId);
      if (!record.approvedHash && op !== "delete") throw new Error("The script has not been approved yet.");
      const changeRequest = this.changeRequestFromRecord(record, op, reason);
      const verb = op === "delete" ? "Delete" : op === "enable" ? "Switch on" : "Switch off";
      return { kind: "approval", request: changeRequest, summary: `${verb} the scheduled script "${record.name}"`, missingSecretNames: [] };
    }
    throw new Error("op must be create, update, delete, enable, disable or run_now.");
  }

  private async proposeRevision(
    input: ProposeScriptChangeInput,
    request: Partial<ScriptChangeToolRequest>,
    op: "create" | "update",
    reason: string | undefined
  ): Promise<ProposeScriptChangeResult> {
    const current = op === "update" ? await this.requireChatScript(String(request.scriptId ?? ""), input.conversationId) : undefined;
    const name = trimmedString(request.name, "name", NAME_MAX_CHARS, !current) ?? current!.name;
    const description = trimmedString(request.description, "description", DESCRIPTION_MAX_CHARS, !current) ?? current!.description;
    let runtime = request.runtime ?? current?.runtime;
    let entry = request.entry ?? current?.entry;
    let files: ScriptFile[] | undefined = request.files;
    if (!files) {
      if (!current?.approvedHash) throw new Error("files are required.");
      files = await this.options.store.readInstalledFiles(current.id);
      if (scriptContentHash(current.runtime, current.entry, files) !== current.approvedHash) {
        throw new Error("The installed files were changed outside the app; send the files you want to run.");
      }
      runtime = runtime ?? current.runtime;
      entry = entry ?? current.entry;
    }
    const validated = validateScriptFiles(runtime, entry, files);
    const schedule = request.schedule !== undefined ? normalizeSchedule(request.schedule) : current?.schedule ?? normalizeSchedule(undefined);
    const timeoutSeconds = boundedInteger(request.timeoutSeconds, "timeoutSeconds", SCRIPT_MIN_TIMEOUT_SECONDS, SCRIPT_MAX_TIMEOUT_SECONDS, current?.timeoutSeconds ?? SCRIPT_DEFAULT_TIMEOUT_SECONDS);
    const secretNames = request.secretNames !== undefined ? normalizeSecretNames(request.secretNames) : current?.secretNames ?? [];
    const permissions = await this.resolvePermissions(input, request, current);
    const id = current?.id ?? newScriptId();
    const contentHash = scriptContentHash(validated.runtime, validated.entry, validated.files);
    const revision: ScriptRevision = {
      version: 1,
      revisionId: randomUUID(),
      scriptId: id,
      createdAt: iso(this.now()),
      name,
      description,
      runtime: validated.runtime,
      entry: validated.entry,
      schedule,
      timeoutSeconds,
      secretNames,
      permissions: permissions.permissions,
      chatLabels: permissions.chatLabels,
      participantLabels: permissions.participantLabels,
      files: validated.files,
      contentHash
    };
    await this.options.store.withScript(id, async () => {
      const nowIso = iso(this.now());
      const record: ScriptRecord = current
        ? { ...(await this.options.store.readRecord(id))!, updatedAt: nowIso }
        : {
            version: 1,
            id,
            name,
            description,
            hostId: this.options.hostId,
            runtime: validated.runtime,
            entry: validated.entry,
            schedule,
            timeoutSeconds,
            secretNames,
            permissions: permissions.permissions,
            chatLabels: permissions.chatLabels,
            participantLabels: permissions.participantLabels,
            enabled: false,
            createdByParticipantId: input.requesterParticipantId,
            createdByLabel: input.requesterLabel,
            createdInChatId: input.conversationId,
            createdAt: nowIso,
            updatedAt: nowIso
          };
      if (record.pendingRevisionId) {
        await this.options.store.deleteRevision(id, record.pendingRevisionId);
      }
      record.pendingRevisionId = revision.revisionId;
      record.pendingApprovalId = undefined;
      await this.options.store.writeRevision(revision);
      await this.options.store.writeRecord(record);
    });
    const saved = await this.options.secrets.savedNames(id);
    const missingSecretNames = secretNames.filter((item) => !saved.includes(item));
    const changeRequest: ChatScriptChangeRequest = {
      kind: "script-change",
      op,
      scriptId: id,
      revisionId: revision.revisionId,
      contentHash,
      name,
      description,
      hostId: this.options.hostId,
      hostLabel: this.options.hostLabel,
      hostPhrase: this.options.hostPhrase,
      runtime: validated.runtime,
      entry: validated.entry,
      schedule,
      scheduleText: describeScriptSchedule(schedule),
      timeoutSeconds,
      secretNames,
      permissions: permissions.permissions,
      chatLabels: permissions.chatLabels,
      participantLabels: permissions.participantLabels,
      fileCount: validated.files.length,
      totalBytes: validated.totalBytes,
      ...(reason ? { reason } : {})
    };
    this.changed();
    const verb = op === "create" ? "Add" : "Update";
    const members = permissions.permissions.participantIds.map((pid) => permissions.participantLabels[pid] ?? pid);
    const summary = `${verb} the scheduled script "${name}": ${describeScriptSchedule(schedule).toLowerCase()} on ${this.options.hostPhrase}`
      + (members.length > 0 ? `, may wake ${members.join(", ")}` : "")
      + (secretNames.length > 0 ? `; needs keys ${secretNames.join(", ")}` : "")
      + ". Review the code and approve it on the desktop";
    return { kind: "approval", request: changeRequest, summary, missingSecretNames };
  }

  private async resolvePermissions(
    input: ProposeScriptChangeInput,
    request: Partial<ScriptChangeToolRequest>,
    current: ScriptRecord | undefined
  ): Promise<{ permissions: ScriptPermissions; chatLabels: Record<string, string>; participantLabels: Record<string, string> }> {
    const chatIds = request.chatIds !== undefined
      ? (Array.isArray(request.chatIds) ? request.chatIds.map((item) => String(item).trim()).filter(Boolean) : [])
      : current?.permissions.chatIds ?? [input.conversationId];
    if (chatIds.length === 0 || chatIds.length > SCRIPT_MAX_CHATS) throw new Error(`chatIds lists from 1 to ${SCRIPT_MAX_CHATS} existing chats.`);
    const chats: ScriptChatInfo[] = [];
    for (const chatId of [...new Set(chatIds)]) {
      const chat = await this.options.chat.describeChat(chatId);
      if (!chat) throw new Error(`Chat ${chatId} does not exist. In this version a script can post only into existing chats.`);
      chats.push(chat);
    }
    const chatLabels = Object.fromEntries(chats.map((chat) => [chat.id, chat.title]));
    const memberRefs = request.members !== undefined
      ? (Array.isArray(request.members) ? request.members.map((item) => String(item).trim()).filter(Boolean) : [])
      : undefined;
    const participantLabels: Record<string, string> = {};
    let participantIds: string[];
    if (memberRefs === undefined) {
      participantIds = current?.permissions.participantIds ?? [];
      for (const pid of participantIds) participantLabels[pid] = current?.participantLabels[pid] ?? pid;
    } else {
      participantIds = [];
      for (const ref of memberRefs) {
        const key = ref.replace(/^@/, "").toLowerCase();
        const found = chats.flatMap((chat) => chat.participants).find((item) => item.id === ref || item.handle.toLowerCase() === key);
        if (!found) throw new Error(`@${key} is not a member of the script's chats.`);
        if (!participantIds.includes(found.id)) participantIds.push(found.id);
        participantLabels[found.id] = `@${found.handle}`;
      }
    }
    const maxWakeupsPerHour = boundedInteger(
      request.maxWakeupsPerHour,
      "maxWakeupsPerHour",
      1,
      SCRIPT_MAX_WAKEUPS_PER_HOUR,
      current?.permissions.maxWakeupsPerHour ?? SCRIPT_DEFAULT_MAX_WAKEUPS_PER_HOUR
    );
    return { permissions: { chatIds: chats.map((chat) => chat.id), participantIds, maxWakeupsPerHour }, chatLabels, participantLabels };
  }

  private changeRequestFromRecord(record: ScriptRecord, op: ChatScriptChangeRequest["op"], reason: string | undefined): ChatScriptChangeRequest {
    return {
      kind: "script-change",
      op,
      scriptId: record.id,
      name: record.name,
      description: record.description,
      hostId: record.hostId,
      hostLabel: this.options.hostLabel,
      hostPhrase: this.options.hostPhrase,
      runtime: record.runtime,
      entry: record.entry,
      schedule: record.schedule,
      scheduleText: describeScriptSchedule(record.schedule),
      timeoutSeconds: record.timeoutSeconds,
      secretNames: record.secretNames,
      permissions: record.permissions,
      chatLabels: record.chatLabels,
      participantLabels: record.participantLabels,
      fileCount: 0,
      totalBytes: 0,
      ...(reason ? { reason } : {})
    };
  }

  async attachApproval(scriptId: string, approvalId: string, revisionId: string | undefined): Promise<void> {
    await this.options.store.withScript(scriptId, async () => {
      const record = await this.options.store.readRecord(scriptId);
      if (!record) return;
      if (revisionId && record.pendingRevisionId !== revisionId) return;
      record.pendingApprovalId = approvalId;
      await this.options.store.writeRecord(record);
    });
    this.changed();
  }

  /** True when this proposal's files are already the approved ones: an
   *  approval that was applied but whose card could not be saved. */
  private alreadyApplied(record: ScriptRecord, request: ChatScriptChangeRequest): boolean {
    return (request.op === "create" || request.op === "update")
      && Boolean(request.revisionId)
      && record.appliedRevisionId === request.revisionId;
  }

  /** Throws a person-readable reason when this proposal cannot be approved
   *  now; the approval stays pending. */
  async assertApprovable(request: ChatScriptChangeRequest): Promise<void> {
    const record = await this.requireRecord(request.scriptId);
    if (request.op !== "create" && request.op !== "update") return;
    if (this.alreadyApplied(record, request)) return;
    if (!request.revisionId || record.pendingRevisionId !== request.revisionId) {
      throw new Error("This proposal was replaced by a newer one or already handled.");
    }
    const revision = await this.options.store.readRevision(record.id, request.revisionId);
    if (!revision || revision.contentHash !== request.contentHash) {
      throw new Error("The proposed files are no longer what the card shows; ask for the script again.");
    }
    const saved = await this.options.secrets.savedNames(record.id);
    const missing = revision.secretNames.filter((name) => !saved.includes(name));
    if (missing.length > 0) {
      throw new Error(`Enter the ${missing.length === 1 ? "key" : "keys"} ${missing.join(", ")} on the desktop first.`);
    }
  }

  async applyApproved(request: ChatScriptChangeRequest): Promise<string> {
    await this.assertApprovable(request);
    const id = request.scriptId;
    if (request.op === "delete") {
      await this.deleteScript(id);
      return `Deleted the scheduled script "${request.name}".`;
    }
    if (request.op === "disable") {
      await this.setEnabled(id, false);
      return `Switched off the scheduled script "${request.name}".`;
    }
    if (request.op === "enable") {
      await this.setEnabled(id, true);
      return `Switched on the scheduled script "${request.name}". ${request.scheduleText}.`;
    }
    await this.options.store.withScript(id, async () => {
      const record = await this.options.store.readRecord(id);
      if (!record) throw new Error("That scheduled script does not exist.");
      if (this.alreadyApplied(record, request)) return;
      // Re-checked under the lock: a newer proposal may have replaced this one.
      if (record.pendingRevisionId !== request.revisionId) throw new Error("This proposal was replaced by a newer one or already handled.");
      const revision = await this.options.store.readRevision(id, request.revisionId!);
      if (!revision || revision.contentHash !== request.contentHash) throw new Error("The proposed files are no longer what the card shows; ask for the script again.");
      const nowMs = this.now();
      // Computed before anything is written: a schedule that cannot fire
      // must not leave a half-approved script behind.
      const firstDue = this.firstDueAt(revision.schedule, nowMs);
      await this.options.store.installFiles(id, revision.files);
      const next: ScriptRecord = {
        ...record,
        name: revision.name,
        description: revision.description,
        runtime: revision.runtime,
        entry: revision.entry,
        schedule: revision.schedule,
        timeoutSeconds: revision.timeoutSeconds,
        secretNames: revision.secretNames,
        permissions: revision.permissions,
        chatLabels: revision.chatLabels,
        participantLabels: revision.participantLabels,
        enabled: true,
        approvedHash: revision.contentHash,
        approvedAt: iso(nowMs),
        appliedRevisionId: revision.revisionId,
        pendingRevisionId: undefined,
        pendingApprovalId: undefined,
        updatedAt: iso(nowMs)
      };
      const runtime = await this.options.store.readRuntime(id);
      runtime.nextDueAt = iso(firstDue);
      runtime.blockedReason = undefined;
      runtime.failingSince = undefined;
      runtime.failureCount = 0;
      runtime.failingAnnounced = false;
      runtime.lastError = undefined;
      await this.options.store.writeRuntime(id, runtime);
      await this.options.store.writeRecord(next);
      await this.options.store.deleteRevision(id, revision.revisionId);
    });
    this.changed();
    this.schedule(0);
    const record = (await this.options.store.readRecord(id))!;
    const runtime = await this.options.store.readRuntime(id);
    const nextRun = runtime.nextDueAt ? Date.parse(runtime.nextDueAt) : undefined;
    const when = nextRun === undefined ? "soon" : nextRun <= this.now() + 1000 ? "now" : humanTime(nextRun, record.schedule.kind === "cron" ? record.schedule.timeZone : undefined);
    return `${request.op === "create" ? "Added" : "Updated"} the scheduled script "${record.name}": ${describeScriptSchedule(record.schedule).toLowerCase()}, first run ${when}.`;
  }

  /** The User declined the card: drop the proposal; a script that was never
   *  approved is removed with its keys. If the proposal had in fact been
   *  applied (its card could not be saved), declining undoes it as far as
   *  possible: a new script is removed, a changed one is switched off. */
  async rejectPending(request: ChatScriptChangeRequest): Promise<void> {
    if (request.op !== "create" && request.op !== "update") return;
    const record = await this.options.store.readRecord(request.scriptId).catch(() => undefined);
    if (!record) return;
    if (this.alreadyApplied(record, request)) {
      if (request.op === "create") await this.deleteScript(record.id);
      else await this.setEnabled(record.id, false);
      return;
    }
    if (record.pendingRevisionId !== request.revisionId) return;
    if (!record.approvedHash) {
      await this.deleteScript(record.id);
      return;
    }
    await this.options.store.withScript(record.id, async () => {
      await this.options.store.deleteRevision(record.id, request.revisionId!);
      const current = await this.options.store.readRecord(record.id);
      if (current) await this.options.store.writeRecord({ ...current, pendingRevisionId: undefined, pendingApprovalId: undefined });
    });
    this.changed();
  }

  // ------------------------------------------------------- direct controls

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = await this.requireRecord(id);
    if (!record.approvedHash) throw new Error("Approve the script first.");
    await this.options.store.withScript(id, async () => {
      const current = (await this.options.store.readRecord(id))!;
      const runtime = await this.options.store.readRuntime(id);
      runtime.nextDueAt = enabled ? iso(this.firstDueAt(current.schedule, this.now())) : undefined;
      if (enabled) runtime.blockedReason = undefined;
      await this.options.store.writeRuntime(id, runtime);
      await this.options.store.writeRecord({ ...current, enabled, updatedAt: iso(this.now()) });
    });
    if (!enabled) this.stopRun(id);
    this.changed();
    this.schedule(0);
  }

  private stopRun(id: string): void {
    const run = this.running.get(id);
    if (run) {
      run.stopReason = "stopped";
      run.controller.abort();
    }
  }

  async deleteScript(id: string): Promise<void> {
    await this.requireRecord(id);
    const run = this.running.get(id);
    this.stopRun(id);
    if (run) await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())]);
    await this.options.store.withScript(id, () => this.options.store.deleteScript(id));
    await this.options.secrets.deleteScript(id);
    this.changed();
  }

  async setSecret(id: string, name: string, value: string): Promise<void> {
    const record = await this.requireRecord(id);
    const names = new Set(record.secretNames);
    if (record.pendingRevisionId) {
      const revision = await this.options.store.readRevision(id, record.pendingRevisionId);
      revision?.secretNames.forEach((item) => names.add(item));
    }
    if (!names.has(name)) throw new Error(`The script does not use a key named ${name}.`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error("A key value cannot be empty.");
    if (trimmed.length > SECRET_MAX_CHARS) throw new Error(`A key value is at most ${SECRET_MAX_CHARS} characters.`);
    await this.options.secrets.set(id, name, trimmed);
    this.changed();
  }

  async deleteSecret(id: string, name: string): Promise<void> {
    await this.requireRecord(id);
    await this.options.secrets.delete(id, name);
    this.changed();
  }

  // ----------------------------------------------------------------- reads

  private async requireRecord(id: string): Promise<ScriptRecord> {
    let record: ScriptRecord | undefined;
    try {
      record = await this.options.store.readRecord(id);
    } catch {
      record = undefined;
    }
    if (!record) throw new Error("That scheduled script does not exist.");
    return record;
  }

  async list(): Promise<ScheduledScriptSummary[]> {
    const savedByScript = await this.options.secrets.savedNamesByScript();
    const summaries: ScheduledScriptSummary[] = [];
    for (const id of await this.options.store.listIds()) {
      const summary = await this.summary(id, savedByScript[id] ?? []).catch(() => undefined);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async summary(id: string, savedNames?: string[]): Promise<ScheduledScriptSummary> {
    const record = await this.requireRecord(id);
    const runtime = await this.options.store.readRuntime(id);
    const saved = savedNames ?? await this.options.secrets.savedNames(id);
    const held = await this.options.store.readHeld(id);
    let pending: ScriptRevision | undefined;
    if (record.pendingRevisionId) pending = await this.options.store.readRevision(id, record.pendingRevisionId);
    const shown = !record.approvedHash && pending ? { ...record, ...pending, id: record.id } : record;
    const neededSecrets = new Set([...record.secretNames, ...(pending?.secretNames ?? [])]);
    const missing = [...neededSecrets].filter((name) => !saved.includes(name));
    let health: ScriptHealth;
    if (!record.approvedHash) health = "needs-approval";
    else if (record.secretNames.some((name) => !saved.includes(name))) health = "waiting-for-keys";
    else if (!record.enabled) health = "off";
    else if (runtime.blockedReason) health = "blocked";
    else if (held.length > 0) health = "holding-messages";
    else if (runtime.failingSince) health = "failing";
    else if (runtime.lastRunAt) health = "ok";
    else health = "never-run";
    const lastError = runtime.blockedReason
      ?? runtime.lastError
      ?? (missing.length > 0 && record.approvedHash ? `Waiting for keys: ${missing.join(", ")}.` : undefined);
    return {
      id: record.id,
      name: shown.name,
      description: shown.description,
      hostId: record.hostId,
      hostLabel: this.options.hostLabel,
      hostPhrase: this.options.hostPhrase,
      runtime: shown.runtime,
      entry: shown.entry,
      schedule: shown.schedule,
      scheduleText: describeScriptSchedule(shown.schedule),
      timeoutSeconds: shown.timeoutSeconds,
      secretNames: [...neededSecrets].sort(),
      savedSecretNames: saved.filter((name) => neededSecrets.has(name)),
      permissions: shown.permissions,
      chatLabels: shown.chatLabels,
      participantLabels: shown.participantLabels,
      enabled: record.enabled,
      approved: Boolean(record.approvedHash),
      ...(record.approvedAt ? { approvedAt: record.approvedAt } : {}),
      ...(record.pendingApprovalId ? { pendingApprovalId: record.pendingApprovalId } : {}),
      createdByParticipantId: record.createdByParticipantId,
      ...(record.createdByLabel ? { createdByLabel: record.createdByLabel } : {}),
      createdInChatId: record.createdInChatId,
      health,
      ...(runtime.lastRunAt ? { lastRunAt: runtime.lastRunAt } : {}),
      ...(runtime.lastRunStatus ? { lastRunStatus: runtime.lastRunStatus } : {}),
      ...(record.enabled && record.approvedHash && runtime.nextDueAt ? { nextRunAt: runtime.nextDueAt } : {}),
      running: this.running.has(id) || this.starting.has(id),
      heldMessageCount: held.length,
      ...(lastError ? { lastError } : {})
    };
  }

  /** Run history, newest first. With a chat id, only that chat's scripts. */
  async runs(id: string, conversationId?: string, limit?: number): Promise<ScriptRunRow[]> {
    if (conversationId) await this.requireChatScript(id, conversationId);
    else await this.requireRecord(id);
    const rows = [...(await this.options.store.readRuns(id))].reverse();
    return limit === undefined ? rows : rows.slice(0, Math.min(Math.max(limit, 1), 100));
  }

  async revisionContent(id: string, revisionId?: string): Promise<ScriptRevisionContent> {
    const record = await this.requireRecord(id);
    if (revisionId) {
      const revision = await this.options.store.readRevision(id, revisionId);
      if (!revision) throw new Error("That proposal is no longer available.");
      return { scriptId: id, revisionId, runtime: revision.runtime, entry: revision.entry, files: revision.files, contentHash: revision.contentHash };
    }
    if (!record.approvedHash) throw new Error("The script has not been approved yet.");
    const files = await this.options.store.readInstalledFiles(id);
    return { scriptId: id, runtime: record.runtime, entry: record.entry, files, contentHash: scriptContentHash(record.runtime, record.entry, files) };
  }

  /** Read-only view for agents in one chat: that chat's scripts only, no
   *  file contents, no key values. */
  async listForAgent(conversationId: string): Promise<Array<Record<string, unknown>>> {
    const visible: ScheduledScriptSummary[] = [];
    for (const item of await this.list()) {
      if (item.createdInChatId === conversationId || item.permissions.chatIds.includes(conversationId)) visible.push(item);
    }
    return visible.map((item) => ({
      scriptId: item.id,
      name: item.name,
      description: item.description,
      host: item.hostLabel,
      schedule: item.scheduleText,
      status: item.health,
      enabled: item.enabled,
      approved: item.approved,
      lastRunAt: item.lastRunAt,
      lastRunStatus: item.lastRunStatus,
      nextRunAt: item.nextRunAt,
      lastError: item.lastError,
      keys: item.secretNames.map((name) => ({ name, saved: item.savedSecretNames.includes(name) })),
      chats: item.permissions.chatIds.map((chatId) => ({ chatId, title: item.chatLabels[chatId] })),
      members: item.permissions.participantIds.map((pid) => item.participantLabels[pid] ?? pid),
      maxWakeupsPerHour: item.permissions.maxWakeupsPerHour,
      heldMessages: item.heldMessageCount
    }));
  }
}
