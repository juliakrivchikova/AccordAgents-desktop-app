import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  ChatAgentPermissions,
  ChatAppToolApprovalScope,
  ChatPermissionChangeRequest,
  ChatPermissionRequestToolResult
} from "../../shared/types";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import type { ChatAppToolApprovalDecisionEvent, ChatService } from "./chat";

const DEFAULT_APPLY_LIMIT = 200;

export type RemoteRunSpoolRecordKind =
  | "lifecycle"
  | "output_text"
  | "permission_pending"
  | "permission_decision"
  | "terminal_state";

interface RemoteRunRecordBase {
  id: string;
  conversationId: string;
  runId: string;
  seq: number;
  createdAt: string;
}

export interface RemoteRunLifecycleRecord extends RemoteRunRecordBase {
  kind: "lifecycle";
  state: "started" | "connected" | "disconnected" | "reconnecting";
  message?: string;
}

export interface RemoteRunOutputTextRecord extends RemoteRunRecordBase {
  kind: "output_text";
  participantId: string;
  content: string;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export interface RemoteRunPermissionPendingRecord extends RemoteRunRecordBase {
  kind: "permission_pending";
  participantId: string;
  roleConfigVersion?: number;
  triggerMessageId?: string;
  requestId?: string;
  request: ChatPermissionChangeRequest;
  runPermissions?: ChatAgentPermissions;
}

export interface RemoteRunPermissionDecisionRecord extends RemoteRunRecordBase {
  kind: "permission_decision";
  requestId: string;
  status: "approved" | "denied";
  approvalScope?: ChatAppToolApprovalScope;
  approvalUpdatedAt?: string;
  error?: string;
}

export interface RemoteRunTerminalStateRecord extends RemoteRunRecordBase {
  kind: "terminal_state";
  status: "completed" | "cancelled" | "failed";
  reason?: string;
}

export type RemoteRunReplayRecord =
  | RemoteRunLifecycleRecord
  | RemoteRunOutputTextRecord
  | RemoteRunPermissionPendingRecord
  | RemoteRunPermissionDecisionRecord
  | RemoteRunTerminalStateRecord;

type RemoteRunRecordInput =
  | Omit<RemoteRunLifecycleRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunOutputTextRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunPermissionPendingRecord, "id" | "seq" | "createdAt" | "requestId"> & { requestId?: string }
  | Omit<RemoteRunPermissionDecisionRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunTerminalStateRecord, "id" | "seq" | "createdAt">;

export interface RemoteRunApplyRecordResult {
  applied: boolean;
  runId: string;
  seq: number;
  cursorSeq: number;
  permissionResult?: ChatPermissionRequestToolResult;
}

export interface RemoteRunServiceOptions {
  spoolRoot?: string;
  applyLimit?: number;
}

export interface RemoteRunStartRequest {
  conversationId: string;
  runId?: string;
}

export interface RemoteRunPermissionRequest {
  conversationId: string;
  runId: string;
  participantId: string;
  roleConfigVersion?: number;
  triggerMessageId?: string;
  request: ChatPermissionChangeRequest;
  runPermissions?: ChatAgentPermissions;
}

export interface RemoteRunOutputTextRequest {
  conversationId: string;
  runId: string;
  participantId: string;
  content: string;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export class RemoteRunService {
  private readonly spoolRoot: string;
  private readonly applyLimit: number;
  private readonly connectedRuns = new Map<string, boolean>();
  private readonly appliedSeqByRun = new Map<string, number>();
  private readonly seqByRun = new Map<string, number>();
  private readonly appendChainByRun = new Map<string, Promise<unknown>>();

  constructor(
    private readonly chat: Pick<ChatService, "applyRemoteRunReplayRecord" | "onAppToolApprovalDecision" | "getRemoteRunCursorSeq">,
    options: RemoteRunServiceOptions = {}
  ) {
    this.spoolRoot = options.spoolRoot ?? path.join(app.getPath("userData"), "remote-runs");
    this.applyLimit = Math.max(1, Math.floor(options.applyLimit ?? DEFAULT_APPLY_LIMIT));
    this.chat.onAppToolApprovalDecision((event) => this.appendPermissionDecision(event));
  }

  async startSimulatedRun(request: RemoteRunStartRequest): Promise<string> {
    const runId = request.runId?.trim() || randomUUID();
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId: request.conversationId,
      runId,
      state: "started"
    });
    return runId;
  }

  async setConnected(runId: string, connected: boolean): Promise<RemoteRunApplyRecordResult[]> {
    this.connectedRuns.set(runId, connected);
    if (!connected) {
      await this.appendSpoolRecordForKnownRun(runId, "disconnected");
      return [];
    }
    await this.appendSpoolRecordForKnownRun(runId, "connected");
    return this.applyFromCursor(runId);
  }

  async appendOutputText(request: RemoteRunOutputTextRequest): Promise<RemoteRunOutputTextRecord> {
    const appended = await this.appendSpoolRecord({
      kind: "output_text",
      ...request
    });
    return appended.record as RemoteRunOutputTextRecord;
  }

  async requestPermission(request: RemoteRunPermissionRequest): Promise<RemoteRunPermissionPendingRecord> {
    const requestId = randomUUID();
    const appended = await this.appendSpoolRecord({
      kind: "permission_pending",
      ...request,
      requestId
    });
    return appended.record as RemoteRunPermissionPendingRecord;
  }

  async markTerminal(
    conversationId: string,
    runId: string,
    status: RemoteRunTerminalStateRecord["status"],
    reason?: string
  ): Promise<RemoteRunTerminalStateRecord> {
    const appended = await this.appendSpoolRecord({
      kind: "terminal_state",
      conversationId,
      runId,
      status,
      reason
    });
    return appended.record as RemoteRunTerminalStateRecord;
  }

  async applyFromCursor(runId: string): Promise<RemoteRunApplyRecordResult[]> {
    await this.ensureCursorSeeded(runId);
    const afterSeq = this.appliedSeqByRun.get(runId) ?? 0;
    const records = await this.readRecords(runId, { afterSeq, limit: this.applyLimit });
    const results: RemoteRunApplyRecordResult[] = [];
    for (const record of records) {
      const result = await this.chat.applyRemoteRunReplayRecord(record);
      this.appliedSeqByRun.set(runId, result.cursorSeq);
      results.push(result);
    }
    return results;
  }

  // On the first drain in this process, seed the in-memory cursor from the
  // durable cursorSeq ChatService persisted. Without this a restarted service
  // (or a second instance over the same spool) rescans from seq 0 and would
  // re-apply records whose ids have aged out of the bounded applied-id window,
  // duplicating messages on a long run after reconnect.
  private async ensureCursorSeeded(runId: string): Promise<void> {
    if (this.appliedSeqByRun.has(runId)) {
      return;
    }
    const head = await this.readRecords(runId, { limit: 1 });
    const conversationId = head[0]?.conversationId;
    if (!conversationId) {
      this.appliedSeqByRun.set(runId, 0);
      return;
    }
    const persisted = await this.chat.getRemoteRunCursorSeq(conversationId, runId);
    this.appliedSeqByRun.set(runId, persisted);
  }

  async readRecords(
    runId: string,
    options: { afterSeq?: number; limit?: number } = {}
  ): Promise<RemoteRunReplayRecord[]> {
    let body = "";
    try {
      body = await readFile(this.spoolPath(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
    const limit = Math.max(1, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER));
    const records: RemoteRunReplayRecord[] = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = this.normalizeRecord(parsed);
      if (!record || record.seq <= afterSeq) {
        continue;
      }
      records.push(record);
      if (records.length >= limit) {
        break;
      }
    }
    return records.sort((a, b) => a.seq - b.seq);
  }

  async queryPermissionDecision(
    runId: string,
    requestId: string
  ): Promise<RemoteRunPermissionDecisionRecord | undefined> {
    const records = await this.readRecords(runId);
    return records
      .filter((record): record is RemoteRunPermissionDecisionRecord =>
        record.kind === "permission_decision" && record.requestId === requestId
      )
      .at(-1);
  }

  private async appendSpoolRecord(
    input: RemoteRunRecordInput
  ): Promise<{ record: RemoteRunReplayRecord; applyResults: RemoteRunApplyRecordResult[] }> {
    return this.withRunAppend(input.runId, async () => {
      const seq = await this.nextSeq(input.runId);
      const record = {
        id: input.kind === "permission_pending" ? input.requestId ?? randomUUID() : randomUUID(),
        createdAt: new Date().toISOString(),
        ...input,
        seq
      } as RemoteRunReplayRecord;
      if (record.kind === "permission_pending" && !record.requestId) {
        record.requestId = record.id;
      }
      await mkdir(this.spoolRoot, { recursive: true });
      await appendFile(this.spoolPath(input.runId), `${JSON.stringify(record)}\n`, "utf8");
      const applyResults = this.connectedRuns.get(input.runId) === true
        ? await this.applyFromCursor(input.runId)
        : [];
      return { record, applyResults };
    });
  }

  // Serialize appends per run so monotonic seq allocation and the file write
  // are atomic. Without this, concurrent worker output and the decision
  // write-back (fired from the approval listener) can read the same max seq
  // and collide, breaking ordered replay.
  private async withRunAppend<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.appendChainByRun.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.appendChainByRun.set(runId, previous.then(() => gate));
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // In-memory monotonic seq per run, seeded once from the spool tail so a
  // restarted service (or a second instance over the same spool) continues the
  // sequence instead of restarting it. Called only inside withRunAppend.
  private async nextSeq(runId: string): Promise<number> {
    let current = this.seqByRun.get(runId);
    if (current === undefined) {
      const records = await this.readRecords(runId);
      current = records.reduce((max, record) => Math.max(max, record.seq), 0);
    }
    const next = current + 1;
    this.seqByRun.set(runId, next);
    return next;
  }

  private async appendSpoolRecordForKnownRun(
    runId: string,
    state: RemoteRunLifecycleRecord["state"]
  ): Promise<void> {
    const records = await this.readRecords(runId);
    const conversationId = records[0]?.conversationId;
    if (!conversationId) {
      return;
    }
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId,
      runId,
      state
    });
  }

  private async appendPermissionDecision(event: ChatAppToolApprovalDecisionEvent): Promise<void> {
    if (event.approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL || !event.approval.resumeContext?.runId) {
      return;
    }
    const runId = event.approval.resumeContext.runId;
    const records = await this.readRecords(runId);
    const hasRequest = records.some((record) =>
      record.kind === "permission_pending" &&
      (record.requestId ?? record.id) === event.approval.id
    );
    if (!hasRequest) {
      return;
    }
    const hasDecision = records.some((record) =>
      record.kind === "permission_decision" &&
      record.requestId === event.approval.id
    );
    if (hasDecision) {
      return;
    }
    await this.appendSpoolRecord({
      kind: "permission_decision",
      conversationId: event.conversationId,
      runId,
      requestId: event.approval.id,
      status: event.status,
      approvalScope: event.approval.approvalScope,
      approvalUpdatedAt: event.approval.updatedAt,
      error: event.approval.error
    });
  }

  private spoolPath(runId: string): string {
    return path.join(this.spoolRoot, `${this.safeRunId(runId)}.jsonl`);
  }

  private safeRunId(runId: string): string {
    return runId.replace(/[^A-Za-z0-9._-]/g, "_") || "run";
  }

  private normalizeRecord(value: unknown): RemoteRunReplayRecord | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Partial<RemoteRunReplayRecord>;
    if (
      typeof record.id !== "string" ||
      typeof record.conversationId !== "string" ||
      typeof record.runId !== "string" ||
      typeof record.seq !== "number" ||
      typeof record.createdAt !== "string" ||
      !this.isRecordKind(record.kind)
    ) {
      return undefined;
    }
    if (record.kind === "output_text") {
      return typeof record.participantId === "string" && typeof record.content === "string"
        ? record as RemoteRunOutputTextRecord
        : undefined;
    }
    if (record.kind === "permission_pending") {
      return typeof record.participantId === "string" && this.isPermissionChangeRequest(record.request)
        ? record as RemoteRunPermissionPendingRecord
        : undefined;
    }
    if (record.kind === "permission_decision") {
      return typeof record.requestId === "string" && (record.status === "approved" || record.status === "denied")
        ? record as RemoteRunPermissionDecisionRecord
        : undefined;
    }
    if (record.kind === "terminal_state") {
      return record.status === "completed" || record.status === "cancelled" || record.status === "failed"
        ? record as RemoteRunTerminalStateRecord
        : undefined;
    }
    return record as RemoteRunLifecycleRecord;
  }

  private isRecordKind(kind: unknown): kind is RemoteRunSpoolRecordKind {
    return kind === "lifecycle" ||
      kind === "output_text" ||
      kind === "permission_pending" ||
      kind === "permission_decision" ||
      kind === "terminal_state";
  }

  private isPermissionChangeRequest(value: unknown): value is ChatPermissionChangeRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Partial<ChatPermissionChangeRequest>;
    return record.kind === "portable" || record.kind === "shellRules" || record.kind === "providerNative";
  }
}

export class RemoteAppMcpRelay {
  constructor(private readonly remoteRuns: RemoteRunService, private readonly request: RemoteRunPermissionRequest) {}

  async callTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
      return {
        ok: false,
        status: "unsupported",
        error: `Remote App MCP relay does not support ${toolName} in PR-B.`
      };
    }
    const record = await this.remoteRuns.requestPermission({
      ...this.request,
      request: input as ChatPermissionChangeRequest
    });
    return {
      ok: true,
      status: "queued",
      requestId: record.requestId ?? record.id
    };
  }
}
