/** The provider's parent survives an app crash long enough to terminate and
 * verify its process tree. One bounded IPC channel carries each session's
 * stdio and ownership messages. This file is a separate executable. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Writable, type Duplex } from "node:stream";
import { NativeProcessRegistry, type NativeProcessLease } from "./nativeProcessRegistry";
import { openMachinePowerStore } from "./machinePowerStore";
import { nativeHostIdentity, verifiedNativeHostReboot, type NativeHostIdentity } from "./nativeHostIdentity";
import {
  capturePosixDescendantsFromTable, capturePosixProcessIdentity, hasLiveCapturedPosixProcesses,
  readPosixProcessTableAsync, terminateCapturedPosixProcesses,
  type CapturedPosixProcess, type PosixProcessRow
} from "./processTermination";

export interface NativeSupervisorStart {
  type: "start";
  id: string;
  scope: string;
  dbPath: string;
  sqliteExecutable: string;
  command: string;
  args: string[];
  cwd?: string;
  electronRunAsNode?: string;
  endInputWithoutStopping?: boolean;
  maintenancePowerDbPath?: string;
  env: NodeJS.ProcessEnv;
}

interface SessionIO {
  stdout: Writable;
  stderr: Writable;
  stop: () => void;
  stopRequested: boolean;
  input?: (data: Buffer, sequence: number) => void;
  inputEnd?: () => void;
  resumeOutput(stream: string, sequence: number): void;
  report(message: object): Promise<void>;
}

export /** How long a guardian keeps trying to release its power hold after closure
 *  is already durable. Past this the hold is left for recovery to release,
 *  because a guardian that never exits is a machine that never sleeps. */
const MAINTENANCE_RELEASE_RETRY_MS = 30_000;

async function supervise(config: NativeSupervisorStart, io: SessionIO): Promise<void> {
  const rows = await processTable();
  const supervisor = capturePosixProcessIdentity(process.pid, () => rows);
  const parent = capturePosixProcessIdentity(process.ppid, () => rows);
  if (!supervisor || !parent || !process.connected) throw new Error("The native supervisor cannot establish its process owner.");
  await mkdir(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const registry = new NativeProcessRegistry(config.dbPath, config.sqliteExecutable);
  await registry.init();
  const host = await hostIdentity;
  if (!host) throw new Error("The OS host and boot identities are unavailable; native process ownership cannot be established.");
  await awaitPreviousSupervisor(registry, config.scope, host);
  const acquired = await registry.acquire({ scope: config.scope, token: randomUUID(), supervisor, parent, host, launchGate: 1 });
  if (!acquired) throw new Error("This participant session already has a native executor.");
  let lease: NativeProcessLease = acquired;
  let stopping = !process.connected || io.stopRequested;
  let stoppedAt = stopping ? Date.now() : undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let gate: Duplex | undefined;
  let gateOpened = false;
  let stdinClosed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const power = config.maintenancePowerDbPath ? openMachinePowerStore(config.maintenancePowerDbPath, config.sqliteExecutable) : undefined;
  const stop = (): void => {
    io.stopRequested = true;
    if (!stopping) { stopping = true; stoppedAt = Date.now(); }
    if (!gateOpened) gate?.end();
    if (!process.connected && child) {
      child.stdout.unpipe(io.stdout); child.stdout.resume();
      child.stderr.unpipe(io.stderr); child.stderr.resume();
      io.stdout.destroy(); io.stderr.destroy();
    }
  };
  io.stop = stop;
  io.stdout.on("error", stop);
  io.stderr.on("error", stop);
  if (!process.connected || io.stopRequested) stop();
  if (!stopping) {
    try {
      // The guardian already owns a durable native receipt. Its power hold can
      // therefore never be left with an ambiguous "not launched yet" owner.
      // A stop that won the race refuses this hold before any shell is spawned.
      if (power && !await power.acquireGuardedMaintenance({ leaseId: config.scope, scope: config.scope,
        owner: supervisor, host, registryPath: config.dbPath })) {
        throw new Error("The machine is already stopping; maintenance was not started.");
      }
      if (!process.connected || io.stopRequested) throw new Error("The maintenance controller disconnected before admission.");
      const env = { ...config.env };
      if (config.electronRunAsNode === undefined) delete env.ELECTRON_RUN_AS_NODE;
      else env.ELECTRON_RUN_AS_NODE = config.electronRunAsNode;
      // The tiny shell waits for a private fixed line, then exec replaces it
      // without changing pid/start identity. No resident helper per session and
      // no provider can exit or spawn work before its identity is recorded.
      child = spawn("/bin/sh", ["-c", 'IFS= read -r gate <&3 && [ "$gate" = accord-native-start ] && exec 3<&- && exec "$@"',
        "accord-native-gate", config.command, ...config.args], { cwd: config.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      gate = child.stdio[3] as Duplex;
      gate.on("error", stop); gate.resume();
      child.on("error", (error) => { void io.report({ type: "error", message: error.message }); stop(); });
      child.stdin.on("error", stop);
      child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; stop(); });
      child.stdout.pipe(io.stdout, { end: false });
      child.stderr.pipe(io.stderr, { end: false });
      // No input can reach the provider before the ownership receipt commits.
      const providerRows = await processTable(true);
      const provider = capturePosixProcessIdentity(child.pid, () => providerRows);
      if (!provider) {
        throw new Error("The provider process identity could not be recorded; no native input was sent.");
      }
      lease = { ...lease, phase: "running", provider };
      await registry.update(lease);
      if (!stopping) {
        gateOpened = true;
        await new Promise<void>((resolve, reject) => gate!.end("accord-native-start\n", (error?: Error | null) => error ? reject(error) : resolve()));
        io.input = (data, sequence) => {
          if (!child || stopping) { void io.report({ type: "inputAck", sequence, error: "The native process is closing." }); return; }
          child.stdin.write(data, (error) => { void io.report({ type: "inputAck", sequence, ...(error ? { error: error.message } : {}) }); });
        };
        io.inputEnd = () => {
          if (!config.endInputWithoutStopping) return;
          stdinClosed = true;
          child?.stdin.end();
        };
        void io.report({ type: "ready", provider, generation: lease.generation });
      }
    } catch (error) {
      // Once acquired, every startup failure must pass through the same
      // verified closure loop. Before the gate opens, EOF admits no provider;
      // afterwards the recorded identity fences termination and retry.
      stop();
      void io.report({ type: "error", message: text(error) });
    }
  }
  let lastError = "";
  // A failed ps / disk write is not proof of termination. Keep the guardian and
  // its exclusive lease alive until a fresh observation and receipt succeed.
  while (true) {
    const currentRows = await processTable(stopping);
    if (!currentRows) { await delay(100); continue; }
    const captured = captureOwned(lease, currentRows);
    const next: NativeProcessLease = { ...lease, descendants: captured };
    try {
      const changed = JSON.stringify(next.descendants) !== JSON.stringify(lease.descendants);
      lease = next;
      if (changed) await registry.update(lease);
      const providerAlive = Boolean(child?.pid && child.exitCode === null && child.signalCode === null) ||
        Boolean(lease.provider && hasLiveCapturedPosixProcesses([lease.provider], () => currentRows));
      if (stopping) {
        const identities = [...(lease.provider ? [lease.provider] : []), ...captured];
        // Closing stdin can make Claude exit and reparent a detached helper.
        // Snapshot and store that helper's identity while its parent exists.
        if (!stdinClosed) { stdinClosed = true; child?.stdin.end(); }
        if (!providerAlive && !hasLiveCapturedPosixProcesses(captured, () => currentRows)) {
          if (process.connected && child) {
            // Native exit can precede pipe drainage. Preserve a large final
            // provider record before publishing its close to the CLI parser.
            if ((!child.stdout.readableEnded && !child.stdout.destroyed) || (!child.stderr.readableEnded && !child.stderr.destroyed)) {
              await new Promise<void>((resolve) => child!.once("close", () => resolve()));
            }
            await Promise.all([flush(io.stdout), flush(io.stderr)]);
          }
          await registry.update({ ...lease, phase: "closed", shutdownReason: "processes-gone" });
          // Closure is durable first. A disk outage here keeps the power hold,
          // and retrying cleanup never re-executes work.
          //
          // The retry is bounded: the closure receipt is already stored, so a
          // store that stays unreadable is released by the next runtime's
          // maintenance recovery from that receipt. Retrying here forever
          // would leave a guardian process alive for the rest of the host's
          // life — an idle machine that can never be stopped again, which is
          // the opposite of what holding the lease is for.
          if (power) {
            const until = Date.now() + MAINTENANCE_RELEASE_RETRY_MS;
            for (;;) {
              try { await power.releaseMaintenance(config.scope, host.boot); break; }
              catch (error) {
                await io.report({ type: "error", message: text(error) });
                if (Date.now() >= until) {
                  await io.report({ type: "error", message: "The maintenance power hold could not be released; it stays held until this machine's next start recovers it from the stored closure." });
                  break;
                }
                await delay(500);
              }
            }
          }
          await io.report({ type: "closed", exitCode, signal: exitSignal });
          child?.stdout.unpipe(io.stdout);
          child?.stderr.unpipe(io.stderr);
          return;
        }
        const elapsed = Date.now() - (stoppedAt ?? Date.now());
        if (elapsed >= 300) terminateCapturedPosixProcesses(identities, elapsed >= 1800 ? "SIGKILL" : "SIGTERM", () => currentRows);
      }
      lastError = "";
    } catch (error) {
      stop();
      const message = text(error);
      if (message !== lastError) { void io.report({ type: "error", message }); lastError = message; }
      // Stop native work even when the disk is full; the old receipt remains
      // owned until the final close receipt can be committed.
      terminateCapturedPosixProcesses([...(lease.provider ? [lease.provider] : []), ...captured], "SIGKILL", () => currentRows);
    }
    await delay(stopping ? 50 : 250);
  }
}

async function awaitPreviousSupervisor(registry: NativeProcessRegistry, scope: string, host?: NativeHostIdentity): Promise<void> {
  const previous = await registry.get(scope);
  if (!previous || previous.phase === "closed") return;
  if (verifiedNativeHostReboot(previous.host, host)) {
    // A new kernel boot on this same host proves no old native process can
    // survive. It does not prove what a command did before the reboot.
    await registry.update({ ...previous, phase: "closed", shutdownReason: "host-rebooted" });
    return;
  }
  if (previous.host && (!host || previous.host.machine !== host.machine || previous.host.boot !== host.boot)) {
    throw new Error("The previous executor belongs to an unverified host/boot; its process ids cannot be used for recovery.");
  }
  const rows = await processTable(true);
  if (!rows) throw new Error("The previous native executor cannot be inspected.");
  if (previous.phase === "launching" && previous.launchGate === 1 && !hasLiveCapturedPosixProcesses([previous.supervisor], () => rows)) {
    await registry.update({ ...previous, phase: "closed", shutdownReason: "never-started" });
    return;
  }
  if (hasLiveCapturedPosixProcesses([previous.parent], () => rows)) throw new Error("This participant session is owned by another running app instance.");
  if (!hasLiveCapturedPosixProcesses([previous.supervisor], () => rows)) {
    throw new Error("The previous native supervisor disappeared before confirming shutdown; a new executor cannot be started safely.");
  }
  // Signal this one supervisor, never its group or any unrelated process. It
  // remains responsible for its provider tree and the final durable receipt.
  process.kill(previous.supervisor.pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await registry.get(scope);
    if (current?.token !== previous.token) throw new Error("Another app instance recovered this native executor.");
    if (current.phase === "closed") return;
    await delay(100);
  }
  throw new Error("The previous native executor has not confirmed shutdown yet.");
}

function captureOwned(lease: NativeProcessLease, rows: Map<number, PosixProcessRow>): CapturedPosixProcess[] {
  const captured = capturePosixDescendantsFromTable(lease.provider?.pid, rows, lease.descendants, lease.provider);
  // A shell may exit before the next sample, reparenting its child. A detached
  // provider owns its process group while any of its members still exist.
  // Never use a group after observing reuse of its original leader's pid.
  if (lease.provider && (!rows.has(lease.provider.pid) || rows.get(lease.provider.pid)?.startedAt === lease.provider.startedAt)) {
    const known = new Set(captured.map((item) => `${item.pid}:${item.startedAt}`));
    for (const row of rows.values()) if (row.pgid === lease.provider.pid && row.pid !== lease.provider.pid && !known.has(`${row.pid}:${row.startedAt}`)) {
      captured.push({ pid: row.pid, startedAt: row.startedAt });
    }
  }
  return captured;
}

function text(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function flush(stream: Writable): Promise<void> {
  return new Promise((resolve) => { if (stream.destroyed) resolve(); else stream.write("", () => resolve()); });
}

// All resident sessions share one guardian and one bounded ps sample. No
// per-token persistence and no additional Node process for each participant.
let cachedTable: Awaited<ReturnType<typeof readPosixProcessTableAsync>>;
const hostIdentity = nativeHostIdentity();
let tableAt = 0;
let readingTable: ReturnType<typeof readPosixProcessTableAsync> | undefined;
function processTable(fresh = false): ReturnType<typeof readPosixProcessTableAsync> {
  if (!fresh && cachedTable && Date.now() - tableAt < 200) return Promise.resolve(cachedTable);
  if (readingTable && !fresh) return readingTable;
  const reading = readPosixProcessTableAsync().then((rows) => { cachedTable = rows; tableAt = Date.now(); return rows; });
  readingTable = reading;
  void reading.finally(() => { if (readingTable === reading) readingTable = undefined; });
  return reading;
}

export function runNativeProcessSupervisor(): void {
  const sessions = new Map<string, SessionIO>();
  const send = (id: string, message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected) { resolve(); return; }
    process.send?.({ id, ...message }, (error) => error ? reject(error) : resolve());
  });
  const stopAll = (): void => {
    for (const io of sessions.values()) io.stop();
    if (!process.connected && sessions.size === 0) process.exit(0);
  };
  process.on("disconnect", stopAll);
  process.on("SIGTERM", stopAll);
  process.on("SIGINT", stopAll);
  process.on("message", (message: NativeSupervisorStart & { stream?: string; sequence?: number; data?: Buffer }) => {
    const existing = sessions.get(message.id);
    if (message.type !== "start") {
      if ((message.type as string) === "stop") existing?.stop();
      else if ((message.type as string) === "inputEnd") existing?.inputEnd?.();
      else if ((message.type as string) === "input" && message.data && typeof message.sequence === "number") existing?.input?.(message.data, message.sequence);
      else if ((message.type as string) === "outputAck" && message.stream && typeof message.sequence === "number") existing?.resumeOutput(message.stream, message.sequence);
      return;
    }
    if (existing) return;
    const pending = new Map<string, (error?: Error | null) => void>();
    let sequence = 0;
    const output = (stream: string): Writable => new Writable({
      highWaterMark: 64 * 1024,
      write(data: Buffer, _encoding, callback) {
        const number = ++sequence;
        pending.set(`${stream}:${number}`, callback);
        void send(message.id, { type: "data", stream, sequence: number, data }).catch((error: Error) => {
          if (pending.delete(`${stream}:${number}`)) callback(error);
        });
      },
      destroy(error, callback) {
        for (const [key, done] of pending) if (key.startsWith(`${stream}:`)) { pending.delete(key); done(error ?? new Error("The app disconnected.")); }
        callback(error);
      }
    });
    const io: SessionIO = {
      stdout: output("stdout"), stderr: output("stderr"),
      stopRequested: false,
      stop: () => { io.stopRequested = true; },
      resumeOutput(stream, number) { const key = `${stream}:${number}`; const callback = pending.get(key); pending.delete(key); callback?.(); },
      report: (value) => send(message.id, value).catch(() => undefined)
    };
    sessions.set(message.id, io);
    void supervise(message, io).catch(async (error) => {
      await io.report({ type: "error", message: text(error) });
      await io.report({ type: "abandoned" });
    }).finally(() => {
      sessions.delete(message.id);
      io.stdout.destroy(); io.stderr.destroy();
      if (!process.connected && sessions.size === 0) process.exit(0);
    });
    // The async bootstrap installs its stop callback before it spawns. A
    // disconnect during its disk/identity reads must remain observable there.
  });
}

if (require.main === module) runNativeProcessSupervisor();
