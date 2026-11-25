import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { SCRIPT_OUTPUT_TAIL_CHARS, type ScriptRunStatus } from "../../../../shared/scripts";
import { CommandError, commandEnvironment, runCommand } from "../../command";
import type { MachineHostAdmission } from "../../machineHostPower";
import { scriptContentHash, type ScriptRecord } from "../../scriptStore";
import { HISTORY_MAX_ROWS, HISTORY_OUTPUT_TAILS, HISTORY_RETENTION_MS } from "../constants";
import { errorMessage, iso, lastMeaningfulLine, redactedTail, redactScriptOutput } from "../scriptText";
import type { RunningScript } from "../types";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** Runs a script and records what it did. */
export class ScriptRuns {
  readonly running = new Map<string, RunningScript>();
  /** Scripts whose run is being prepared: the slot is taken before the
   *  first await, so two starts can never both pass the check. */
  readonly starting = new Set<string>();

  constructor(
    private readonly scripts: Pick<ScriptModules, "scheduler" | "scriptHealth" | "scriptHost" | "scriptRecords">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options">
  ) {}

  // ---------------------------------------------------------------- runs

  /** Start one run now. Throws when it cannot start. */
  async runNow(id: string): Promise<void> {
    const record = await this.scripts.scriptRecords.requireRecord(id);
    if (this.scripts.scheduler.stopped) throw new Error(`Scheduled tasks on ${this.scripts.scriptHost.hostPhrase()} are stopping; try again in a moment.`);
    if (!record.approvedHash) throw new Error("Approve the task before running it.");
    if (this.running.has(id) || this.starting.has(id)) throw new Error("The task is already running.");
    this.launch(id, "Started by hand.");
  }

  /** Reserve the run slot synchronously, then prepare and run. */
  launch(id: string, detail: string | undefined): void {
    if (this.scripts.scheduler.stopped || this.running.has(id) || this.starting.has(id)) return;
    this.starting.add(id);
    void this.execute(id, detail)
      .catch((error) => {
        this.scripts.scriptHost.log("scripts.run.error", { scriptId: id, message: errorMessage(error) });
      })
      .finally(() => {
        this.starting.delete(id);
      });
  }

  private async execute(id: string, detail: string | undefined): Promise<void> {
    const startedAt = this.deps.now();
    let record: ScriptRecord | undefined;
    let secretValues: Record<string, string> = {};
    let entryPath: string;
    let stateDir: string;
    let apiUrl: string;
    try {
      record = await this.deps.options.store.readRecord(id);
      if (!record?.approvedHash) return;
      const files = await this.deps.options.store.readInstalledFiles(id);
      if (scriptContentHash(record.runtime, record.entry, files) !== record.approvedHash) {
        await this.scripts.scriptHealth.block(id, "Its files changed after you approved them, so it will not run until a new version is approved.");
        await this.recordRun(id, { status: "blocked", at: startedAt, messagesSent: 0, detail: "Files changed since approval." });
        this.scripts.scriptHost.changed();
        return;
      }
      secretValues = await this.deps.options.secrets.values(id, record.secretNames);
      const missing = record.secretNames.filter((name) => secretValues[name] === undefined);
      if (missing.length > 0) {
        await this.recordRun(id, { status: "blocked", at: startedAt, messagesSent: 0, detail: `Waiting for keys: ${missing.join(", ")}.` });
        this.scripts.scriptHost.changed();
        return;
      }
      const url = this.deps.options.tokens.scriptApiUrl();
      if (!url) throw new Error("The app's local API is not running.");
      apiUrl = url;
      stateDir = this.deps.options.store.stateDir(id);
      entryPath = path.join(this.deps.options.store.filesDir(id), ...record.entry.split("/"));
    } catch (error) {
      // Nothing ran, but the User must see why (an unreadable key store, a
      // missing file): record it like a failed run.
      if (record) {
        const message = errorMessage(error);
        await this.recordRun(id, { status: "failed", at: startedAt, messagesSent: 0, detail: `Could not start: ${message}` }).catch(() => undefined);
        await this.scripts.scriptHealth.applyHealthTransition(id, record, "failed", `Could not start: ${message}`).catch(() => undefined);
        this.scripts.scriptHost.changed();
      }
      return;
    }
    if (this.scripts.scheduler.stopped) return;
    if (this.deps.options.admit) {
      // A host that cannot say whether it is staying awake does not start
      // work; the run is recorded either way, never dropped in silence.
      const admission = await Promise.resolve(this.deps.options.admit(`the scheduled task "${record.name}"`))
        .catch((error): MachineHostAdmission => ({ admitted: false, reason: `This machine could not admit new work: ${errorMessage(error)}` }));
      if (!admission.admitted) {
        await this.recordRun(id, { status: "skipped", at: startedAt, messagesSent: 0, detail: admission.reason });
        this.scripts.scriptHost.changed();
        return;
      }
    }
    // Switched off or deleted while the run was being prepared.
    const latest = await this.deps.options.store.readRecord(id).catch(() => undefined);
    if (!latest?.approvedHash || (!latest.enabled && detail !== "Started by hand.")) return;
    const runId = randomUUID();
    const controller = new AbortController();
    const token = this.deps.options.tokens.issueScriptToken({ scriptId: id, runId });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const secretList = Object.values(secretValues);
    const run: RunningScript = { runId, controller, token, messagesSent: 0, messagesInFlight: 0, secretValues: secretList, done };
    this.running.set(id, run);
    this.scripts.scriptHost.changed();
    // Keys first, the fixed variables after: a key can never replace them.
    const env: Record<string, string> = {
      ...secretValues,
      ...(record.runtime === "node" ? this.deps.options.node.env : {}),
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
    const command = record.runtime === "node" ? this.deps.options.node.command : (this.deps.options.bash ?? "/bin/bash");
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
            pidWrite = this.deps.options.store.writePid(id, { pid, runId, bootAt: this.scripts.scriptHost.bootAt(), startedAt: iso(this.deps.now()) }).catch(() => undefined);
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
        this.deps.options.tokens.revokeScriptToken(token);
        if (this.running.get(id)?.runId === runId) this.running.delete(id);
        // The pid file is written in the background; wait for it, so the
        // clear below cannot land first and leave a stale pid behind.
        await pidWrite;
        await this.deps.options.store.clearPid(id).catch(() => undefined);
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
        endedAt: this.deps.now(),
        exitCode,
        messagesSent: run.messagesSent,
        outputTail: outputTail || undefined,
        detail: [detail, redactedFailure].filter(Boolean).join(" ") || undefined
      });
      await this.scripts.scriptHealth.applyHealthTransition(id, record, status, redactedFailure);
    } finally {
      resolveDone();
      this.scripts.scriptHost.changed();
    }
  }

  async recordRun(id: string, run: {
    status: ScriptRunStatus;
    at: number;
    endedAt?: number;
    exitCode?: number | null;
    messagesSent: number;
    outputTail?: string;
    detail?: string;
  }): Promise<void> {
    await this.deps.options.store.withScript(id, async () => {
      const record = await this.deps.options.store.readRecord(id);
      if (!record) return;
      const rows = await this.deps.options.store.readRuns(id);
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
      const cutoff = this.deps.now() - HISTORY_RETENTION_MS;
      const kept = rows.filter((row) => Date.parse(row.lastAt) >= cutoff).slice(-HISTORY_MAX_ROWS);
      kept.forEach((row, index) => {
        if (index < kept.length - HISTORY_OUTPUT_TAILS) delete row.outputTail;
      });
      await this.deps.options.store.writeRuns(id, kept);
      if (run.status !== "skipped" && run.status !== "missed") {
        const runtime = await this.deps.options.store.readRuntime(id);
        runtime.lastRunAt = at;
        runtime.lastRunStatus = run.status;
        await this.deps.options.store.writeRuntime(id, runtime);
      }
    });
  }

  stopRun(id: string): void {
    const run = this.running.get(id);
    if (run) {
      run.stopReason = "stopped";
      run.controller.abort();
    }
  }
}
