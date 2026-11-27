import { codexAppServerMessageKind } from "../appServerErrors";
import { handleCodexAppServerCompactNotification } from "../appServerEvents";
import { MAX_CLI_ERROR_CHARS } from "../../constants";
import { truncateText } from "../../runs/outputText";
import { asRecord, stringField } from "../../runs/records";
import type { CodexAppServerPendingRequest } from "../../types";
import type { AppServerModules } from "./modules";
import type { AppServerLaunch } from "./launch";
import { runsOnOwnSignIn } from "../../../cliPlanUsage";

/** The app-server process's own lines: requests sent to it, its answers, and its end. */
export class AppServerConnection {
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderr = "";
  closed = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, CodexAppServerPendingRequest>();

  constructor(
    private readonly server: Pick<AppServerModules, "approvals" | "guardian" | "turns">,
    private readonly launch: Pick<AppServerLaunch, "child" | "cli" | "options" | "participant">
  ) {}

  sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed || this.launch.child.exitCode !== null || this.launch.child.killed) {
      return Promise.reject(new Error("codex app-server process is not running"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        this.pendingRequests.delete(id);
        callback();
      };
      const resolveRequest = (result: unknown): void => settle(() => resolve(result));
      const rejectRequest = (error: Error): void => settle(() => reject(error));
      this.pendingRequests.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          rejectRequest(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }
      this.launch.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (error) {
          rejectRequest(error);
        }
      });
    });
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = typeof record.id === "number" ? record.id : undefined;
    if (id === undefined) {
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(id);
    const error = asRecord(record.error);
    if (error) {
      pending.reject(new Error(stringField(error, "message") ?? `${pending.method} failed`));
      return;
    }
    pending.resolve(record.result);
  }

  writeServerMessage(message: Record<string, unknown>): Promise<void> {
    if (this.closed || this.launch.child.exitCode !== null || this.launch.child.killed) {
      return Promise.reject(new Error("codex app-server process is not running"));
    }
    return new Promise<void>((resolve, reject) => {
      this.launch.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private handleLine(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const record = asRecord(event);
    if (!record) {
      return;
    }
    const messageKind = codexAppServerMessageKind(record);
    if (messageKind === "server-request") {
      this.server.approvals.handleServerRequest(record);
      return;
    }
    if (messageKind === "response") {
      this.handleResponse(record);
      return;
    }
    if (this.server.approvals.handleServerRequestResolved(record)) {
      return;
    }
    // Pushed with every model response: the account's plan usage (on the
    // CLI's own sign-in only; an added provider has no plan).
    if (record.method === "account/rateLimits/updated" && runsOnOwnSignIn(this.launch.participant, this.launch.options.agentEnv)) {
      this.launch.cli.planUsage.noteCodexRateLimitsUpdated(record.params);
    }
    this.server.approvals.handleFileChangePatchUpdated(record);
    this.server.approvals.handleItemCompletedApprovalRetirement(record);
    if (handleCodexAppServerCompactNotification(record, this.launch.participant, this.server.turns.pendingCompact, () => this.server.turns.cleanupPendingCompact(), (error) => this.server.turns.rejectPendingCompact(error))) {
      return;
    }
    this.server.guardian.handleGuardianReviewCompleted(record);
    this.launch.cli.codexAppServerNotifications.handleCodexAppServerNotification(
      record,
      this.launch.participant,
      this.server.turns.pendingTurn,
      () => this.server.turns.cleanupPendingTurn(),
      (error) => this.server.turns.rejectPendingTurn(error),
      (error) => this.server.guardian.rejectPendingGuardianApprovals(error)
    );
  }

  private handleData(chunk: string, stream: "stdout" | "stderr"): void {
    if (stream === "stderr") {
      this.stderr = truncateText(`${this.stderr}${chunk}`, MAX_CLI_ERROR_CHARS);
      this.stderrBuffer += chunk;
    } else {
      this.stdoutBuffer += chunk;
    }
    let buffer = stream === "stderr" ? this.stderrBuffer : this.stdoutBuffer;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
      newline = buffer.indexOf("\n");
    }
    if (stream === "stderr") {
      this.stderrBuffer = buffer;
    } else {
      this.stdoutBuffer = buffer;
    }
  }

  listen(): void {
  this.launch.child.stdout.on("data", (chunk: string) => this.handleData(chunk, "stdout"));
  this.launch.child.stderr.on("data", (chunk: string) => this.handleData(chunk, "stderr"));
  this.launch.child.stdin.on("error", (error) => {
    this.closed = true;
    this.server.turns.rejectPendingTurn(error);
    this.server.turns.rejectPendingCompact(error);
    this.server.guardian.rejectPendingGuardianApprovals(error);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  });
  this.launch.child.on("error", (error) => {
    this.closed = true;
    this.server.turns.rejectPendingTurn(error);
    this.server.turns.rejectPendingCompact(error);
    this.server.guardian.rejectPendingGuardianApprovals(error);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  });
  this.launch.child.on("close", (exitCode, signal) => {
    this.closed = true;
    const exitDetail = signal
      ? ` after signal ${signal}`
      : exitCode === null
        ? ""
        : ` with code ${exitCode}`;
    const error = new Error(`codex app-server process exited${exitDetail}${!signal && this.stderr ? `: ${this.stderr}` : ""}`);
    this.server.turns.rejectPendingTurn(error);
    this.server.turns.rejectPendingCompact(error);
    this.server.guardian.rejectPendingGuardianApprovals(error);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  });
  }
}
