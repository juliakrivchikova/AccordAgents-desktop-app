import { confirmNativeProcessClosed, isSupervisedNativeProcess } from "../../nativeProcess";
import {
  capturePosixDescendants, capturePosixDescendantsFromTable, capturePosixProcessIdentity, hasLiveCapturedPosixProcesses,
  readPosixProcessTableAsync, readPosixProcessTableSync, terminateCapturedPosixProcesses, terminateProcessTreeIfRunning,
  type CapturedPosixProcess
} from "../../processTermination";
import type { WarmAgentEntry } from "../types";
import { waitForProcessClose } from "./warmKeys";
import type { CliModules } from "../modules";

const WARM_AGENT_KILL_GRACE_MS = 1500;
const WINDOWS_WARM_AGENT_KILL_GRACE_MS = 750;
const CLAUDE_BACKGROUND_PROCESS_CAPTURE_INTERVAL_MS = 100;

// Background work now outlives the reply that started it and can run for hours
// (a dev server, a watcher). Descendants appear while a step runs or right
// after a task event; between those, a slower sample keeps the captured tree
// current without spawning `ps` ten times a second.
const CLAUDE_BACKGROUND_PROCESS_IDLE_CAPTURE_INTERVAL_MS = 2_000;

const CLAUDE_BACKGROUND_CLOSE_GRACE_MS = 3_000;

/** Closes a member's CLI process and everything it started. */
export class WarmAgentClose {
  readonly closingWarmAgents = new Map<WarmAgentEntry, Promise<void>>();
  private claudeBackgroundCaptureTimer?: NodeJS.Timeout;
  private claudeBackgroundCaptureRunning = false;
  /** Overridable in tests so sampler shutdown can be observed without polling OS state. */
  private readClaudeBackgroundProcessTable = readPosixProcessTableAsync;
  /** Overridable in tests so stale root PID handling can be verified safely. */
  readPosixProcessTableForTermination = readPosixProcessTableSync;
  private claudeBackgroundCaptureLastAt = 0;
  /** Overridable in tests; see CLAUDE_BACKGROUND_CLOSE_GRACE_MS. */
  private claudeBackgroundCloseGraceMs = CLAUDE_BACKGROUND_CLOSE_GRACE_MS;
  readonly failedWarmClosures = new Set<WarmAgentEntry>();

  constructor(private readonly cli: Pick<CliModules, "cliRuns" | "warmAgents">) {}

  closeWarmAgent(entry: WarmAgentEntry, reason: string): Promise<void> {
    const existingClose = this.closingWarmAgents.get(entry);
    if (existingClose) {
      return existingClose;
    }
    if (entry.closed && !this.failedWarmClosures.has(entry)) {
      return Promise.resolve();
    }
    entry.closed = true;
    if (this.cli.warmAgents.entries.get(entry.key) === entry) this.cli.warmAgents.entries.delete(entry.key);
    this.cli.warmAgents.clearWarmIdleTimer(entry);
    this.maybeStopClaudeBackgroundProcessCapture();
    void this.cli.cliRuns.writeDebugLog("cli-agent-warm-closed", {
      providerKind: entry.providerKind,
      reason
    });
    const close = this.closeWarmAgentProcess(entry).then(() => {
      this.failedWarmClosures.delete(entry);
    }, error => {
      // closed prevents reuse; it is not a successful process-closure receipt.
      // Keep the entry so retries and the idle gate cannot forget its children.
      this.failedWarmClosures.add(entry);
      throw error;
    }).finally(() => {
      this.closingWarmAgents.delete(entry);
    });
    this.closingWarmAgents.set(entry, close);
    return close;
  }

  private async closeWarmAgentProcess(entry: WarmAgentEntry): Promise<void> {
    if (isSupervisedNativeProcess(entry.process)) {
      const exitedOnItsOwn = entry.process.exitCode !== null || entry.process.signalCode !== null;
      await confirmNativeProcessClosed(entry.process);
      if (exitedOnItsOwn && entry.hasLiveBackgroundWork?.()) {
        // The provider died with background work running; its supervisor saw
        // it go and cannot clean up after it. Finish what was captured live.
        terminateCapturedPosixProcesses(
          this.capturedWarmAgentDescendants(entry),
          "SIGKILL",
          this.readPosixProcessTableForTermination
        );
      }
      return;
    }
    if (entry.providerKind === "codex-cli" && process.platform !== "win32") {
      await this.closeCodexProcessTree(entry);
      return;
    }
    if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
      // A detached Claude process can exit while provider-owned background work
      // remains in its process group. With no live group leader left to close
      // stdin gracefully, terminate that recorded work immediately.
      if (entry.hasLiveBackgroundWork?.()) {
        terminateCapturedPosixProcesses(
          this.capturedWarmAgentDescendants(entry),
          "SIGKILL",
          this.readPosixProcessTableForTermination
        );
        this.terminateWarmAgentRoot(entry, "SIGKILL");
      }
      return;
    }
    if (process.platform === "win32") {
      // taskkill must enumerate the tree while its root still exists; waiting
      // for stdin EOF can reparent a helper first. This synchronous forced tree
      // kill also completes before an updater-driven app exit can return.
      if (entry.hasLiveBackgroundWork?.()) {
        this.terminateWarmAgentRoot(entry, "SIGKILL");
        return;
      }
      try {
        entry.process.stdin.end();
      } catch {
        // The provider may have already closed stdin; escalation remains below.
      }
    } else if (entry.hasLiveBackgroundWork?.()) {
      // Claude kills its own background tasks when stdin closes; SIGTERM alone
      // may leave their shells running in separate process groups. Snapshot the
      // provider-owned tree before EOF reparents any survivors, then escalate
      // those exact process identities if Claude does not clean them up.
      const capturedBackgroundProcesses = this.capturedWarmAgentDescendants(entry);
      try {
        entry.process.stdin.end();
      } catch {
        // Already closed; escalation below still applies.
      }
      await waitForProcessClose(entry.process, this.claudeBackgroundCloseGraceMs);
      if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
        // The provider may exit on stdin EOF without cleaning up a task that
        // ignores its own graceful shutdown. Finish every process identity
        // captured before EOF, including tasks in a separate process group.
        if (entry.hasLiveBackgroundWork?.()) {
          terminateCapturedPosixProcesses(
            capturedBackgroundProcesses,
            "SIGKILL",
            this.readPosixProcessTableForTermination
          );
          this.terminateWarmAgentRoot(entry, "SIGKILL");
        }
        return;
      }
      terminateCapturedPosixProcesses(
        capturedBackgroundProcesses,
        "SIGTERM",
        this.readPosixProcessTableForTermination
      );
      this.terminateWarmAgentRoot(entry, "SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          terminateCapturedPosixProcesses(
            capturedBackgroundProcesses,
            "SIGKILL",
            this.readPosixProcessTableForTermination
          );
          this.terminateWarmAgentRoot(entry, "SIGKILL");
          resolve();
        }, WARM_AGENT_KILL_GRACE_MS);
        timer.unref();
        entry.process.once("close", () => {
          if (hasLiveCapturedPosixProcesses(
            capturedBackgroundProcesses,
            this.readPosixProcessTableForTermination
          )) {
            return;
          }
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    } else {
      // Preserve the established macOS/POSIX shutdown behavior exactly.
      this.terminateWarmAgentRoot(entry, "SIGTERM");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (entry.process.exitCode === null && entry.process.signalCode === null) {
          this.terminateWarmAgentRoot(entry, "SIGKILL");
        }
        resolve();
      }, process.platform === "win32" ? WINDOWS_WARM_AGENT_KILL_GRACE_MS : WARM_AGENT_KILL_GRACE_MS);
      timer.unref();
      entry.process.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  capturedWarmAgentDescendants(entry: WarmAgentEntry): CapturedPosixProcess[] {
    const rootIdentity = entry.processIdentity?.();
    return capturePosixDescendants(
      rootIdentity?.pid,
      entry.capturedBackgroundProcesses?.() ?? [],
      rootIdentity,
      this.readPosixProcessTableForTermination
    );
  }

  private async closeCodexProcessTree(entry: WarmAgentEntry): Promise<void> {
    let captured = this.capturedWarmAgentDescendants(entry);
    let root = entry.processIdentity?.();
    const startedAt = Date.now();
    let escalated = false;
    let signaled = false;
    // A root close event is insufficient: detached children may still be alive.
    // Keep the turn pending until their identities disappear, including after
    // SIGKILL; never acknowledge Stop merely because a signal was sent.
    while (true) {
      const rows = await readPosixProcessTableAsync();
      if (rows) {
        const rootAlive = entry.process.exitCode === null && entry.process.signalCode === null;
        if (rootAlive) root ??= capturePosixProcessIdentity(entry.process.pid, () => rows);
        captured = capturePosixDescendantsFromTable(root?.pid, rows, captured, root);
        if (!rootAlive && !hasLiveCapturedPosixProcesses(captured, () => rows)) {
          return;
        }
        if (!signaled) {
          signaled = true;
          terminateCapturedPosixProcesses(captured, "SIGTERM", () => rows);
          this.terminateWarmAgentRoot(entry, "SIGTERM");
        }
        if (Date.now() - startedAt >= WARM_AGENT_KILL_GRACE_MS) {
          if (!escalated) {
            escalated = true;
            void this.cli.cliRuns.writeDebugLog("cli.codex-stop.escalating", { capturedProcessCount: captured.length });
          }
          terminateCapturedPosixProcesses(captured, "SIGKILL", () => rows);
          this.terminateWarmAgentRoot(entry, "SIGKILL");
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  terminateWarmAgentRoot(entry: WarmAgentEntry, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      terminateProcessTreeIfRunning(entry.process, signal);
      return;
    }
    const identity = entry.processIdentity?.();
    if (identity) {
      terminateCapturedPosixProcesses([identity], signal, this.readPosixProcessTableForTermination);
      return;
    }
    if (entry.process.exitCode === null && entry.process.signalCode === null) {
      entry.process.kill(signal);
    }
  }

  ensureClaudeBackgroundProcessCapture(): void {
    if (this.claudeBackgroundCaptureTimer) {
      return;
    }
    const capture = (): void => {
      if (this.claudeBackgroundCaptureRunning) {
        return;
      }
      const entries = Array.from(this.cli.warmAgents.entries.values()).filter((entry) => (
        !entry.closed && entry.hasLiveBackgroundWork?.() && entry.refreshCapturedBackgroundProcesses
      ));
      if (entries.length === 0) {
        this.stopClaudeBackgroundProcessCapture();
        return;
      }
      const now = Date.now();
      if (!entries.some((entry) => entry.captureUrgent?.() !== false)
        && now - this.claudeBackgroundCaptureLastAt < CLAUDE_BACKGROUND_PROCESS_IDLE_CAPTURE_INTERVAL_MS) {
        return;
      }
      this.claudeBackgroundCaptureLastAt = now;
      this.claudeBackgroundCaptureRunning = true;
      void this.readClaudeBackgroundProcessTable()
        .then((rows) => {
          if (!rows) {
            return;
          }
          for (const entry of entries) {
            if (!entry.closed && entry.hasLiveBackgroundWork?.()) {
              entry.refreshCapturedBackgroundProcesses?.(rows);
            }
          }
        })
        .finally(() => {
          this.claudeBackgroundCaptureRunning = false;
        });
    };
    capture();
    this.claudeBackgroundCaptureTimer = setInterval(capture, CLAUDE_BACKGROUND_PROCESS_CAPTURE_INTERVAL_MS);
    this.claudeBackgroundCaptureTimer.unref();
  }

  maybeStopClaudeBackgroundProcessCapture(): void {
    const hasLiveBackgroundWork = Array.from(this.cli.warmAgents.entries.values()).some((entry) => (
      !entry.closed && entry.hasLiveBackgroundWork?.()
    ));
    if (!hasLiveBackgroundWork) {
      this.stopClaudeBackgroundProcessCapture();
    }
  }

  stopClaudeBackgroundProcessCapture(): void {
    if (this.claudeBackgroundCaptureTimer) {
      clearInterval(this.claudeBackgroundCaptureTimer);
      this.claudeBackgroundCaptureTimer = undefined;
    }
  }
}
