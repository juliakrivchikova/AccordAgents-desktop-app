import type { ChatAgentActivityKind, ParticipantConfig } from "../../../../shared/types";
import { codexContextFromEvent } from "../../cliContextUsage";
import {
  codexCommandActivity, codexFileChangeActivity, codexMcpActivity, codexWebSearchActivity, type CodexCommandAction
} from "../../cliToolActivity";
import {
  codexAppServerFileChanges, codexAppServerFileChangesDetail, codexAppServerFinalContent, codexAppServerReadableJson
} from "./appServerText";
import { codexContextUsage } from "./execOutput";
import type { CodexAppServerPendingCompact, CodexAppServerPendingTurn, CodexNativeGoalStatus } from "./types";
import { asRecord, findStringField, stringField } from "../runs/records";

export function handleCodexAppServerCompactNotification(
  record: Record<string, unknown>,
  participant: ParticipantConfig,
  pending: CodexAppServerPendingCompact | undefined,
  cleanupPending: () => CodexAppServerPendingCompact | undefined,
  rejectPending: (error: Error) => void
): boolean {
  if (!pending) {
    return false;
  }
  const eventNames = codexAppServerEventNames(record);
  if (eventNames.length === 0) {
    return false;
  }
  const params = asRecord(record.params) ?? asRecord(record.msg) ?? asRecord(record.event) ?? asRecord(record.payload) ?? record;
  const threadIdFromEvent = findStringField(record, ["threadId", "thread_id"]);
  if (threadIdFromEvent && threadIdFromEvent !== pending.threadId) {
    return false;
  }
  if (eventNames.some((name) => isCodexAppServerTokenUsageEventName(name))) {
    pending.contextUsage = codexContextUsage(codexContextFromEvent(record), participant) ?? pending.contextUsage;
    return true;
  }
  // Newer codex builds (>= 0.139) signal a completed compaction with a normal
  // turn lifecycle rather than a dedicated thread/compacted event. Track the
  // compaction turn id so the matching turn/completed resolves the operation.
  if (eventNames.some((name) => isCodexAppServerTurnStartedEventName(name))) {
    const turnId = codexAppServerTurnId(record, params);
    pending.sawCompactTurn = true;
    if (turnId) {
      pending.compactTurnId = turnId;
    }
    return true;
  }
  const compactComplete = eventNames.some((name) => isCodexAppServerCompactCompleteEventName(name));
  const turnCompleted = eventNames.some((name) => isCodexAppServerTurnCompletedEventName(name));
  if (turnCompleted && !compactComplete) {
    // Ignore unrelated turn completions that are not the compaction turn.
    const turnId = codexAppServerTurnId(record, params);
    if (pending.compactTurnId && turnId && turnId !== pending.compactTurnId) {
      return true;
    }
    if (!pending.sawCompactTurn && !pending.compactTurnId) {
      // We have not yet observed the compaction turn starting; ignore stray
      // completions from a prior turn to avoid resolving too early.
      return true;
    }
    const turn = asRecord(params.turn) ?? asRecord(record.turn);
    const status = stringField(turn ?? {}, "status");
    if (status && status !== "completed") {
      const error = asRecord(turn?.error) ?? asRecord(params.error);
      rejectPending(new Error(stringField(error ?? {}, "message") ?? `codex app-server compact turn ${status}`));
      return true;
    }
  }
  if (compactComplete || turnCompleted) {
    const current = cleanupPending();
    current?.resolve({
      participant,
      ok: true,
      sessionId: current.threadId,
      contextUsage: current.contextUsage,
      providerNative: true
    });
    return true;
  }
  if (eventNames.some((name) => isCodexAppServerErrorEventName(name))) {
    const error = asRecord(params.error) ?? asRecord(record.error);
    rejectPending(new Error(stringField(error ?? {}, "message") ?? "codex app-server reported an error"));
    return true;
  }
  return false;
}

export function codexAppServerTurnId(record: Record<string, unknown>, params: Record<string, unknown>): string | undefined {
  const turn = asRecord(params.turn) ?? asRecord(record.turn);
  return (
    stringField(turn ?? {}, "id") ??
    findStringField(params, ["turnId", "turn_id"]) ??
    findStringField(record, ["turnId", "turn_id"])
  );
}

export function codexAppServerThreadId(record: Record<string, unknown>, params: Record<string, unknown>): string | undefined {
  return (
    findStringField(params, ["threadId", "thread_id"]) ??
    findStringField(record, ["threadId", "thread_id"])
  );
}

function codexAppServerEventNames(record: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    const entry = asRecord(value);
    if (!entry) {
      return;
    }
    for (const key of ["method", "type"]) {
      const name = stringField(entry, key);
      if (name?.trim()) {
        names.add(name.trim());
      }
    }
  };
  add(record);
  add(record.params);
  add(record.msg);
  add(record.event);
  add(record.payload);
  return Array.from(names);
}

function isCodexAppServerTokenUsageEventName(name: string): boolean {
  const normalized = normalizedCodexAppServerEventName(name);
  // The CLI-style event the app-server notification mirrors (`token_count`,
  // or `codex/event/token_count` with it in `params.msg`).
  return normalized === "thread_tokenusage_updated" || normalized === "token_count" || normalized.endsWith("_token_count");
}

function isCodexAppServerCompactCompleteEventName(name: string): boolean {
  const normalized = normalizedCodexAppServerEventName(name);
  return [
    "thread_compacted",
    "context_compacted",
    "thread_compact_completed",
    "thread_compact_complete",
    "thread_compact_finished",
    "compact_completed",
    "compact_complete",
    "compact_finished"
  ].includes(normalized);
}

function isCodexAppServerTurnStartedEventName(name: string): boolean {
  return normalizedCodexAppServerEventName(name) === "turn_started";
}

function isCodexAppServerTurnCompletedEventName(name: string): boolean {
  return normalizedCodexAppServerEventName(name) === "turn_completed";
}

function isCodexAppServerErrorEventName(name: string): boolean {
  return normalizedCodexAppServerEventName(name) === "error";
}

function normalizedCodexAppServerEventName(name: string): string {
  return name.trim().toLowerCase().replace(/[/-]/g, "_");
}

export function codexNativeGoalStatus(status: string | undefined): CodexNativeGoalStatus | undefined {
  return status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "usageLimited" ||
    status === "budgetLimited" ||
    status === "complete"
    ? status
    : undefined;
}

export function codexNativeGoalStatusLabel(status: CodexNativeGoalStatus): string {
  if (status === "usageLimited") {
    return "usage limited";
  }
  if (status === "budgetLimited") {
    return "budget limited";
  }
  return status;
}

export function settleCodexNativeGoal(
  participant: ParticipantConfig,
  cleanupPending: () => CodexAppServerPendingTurn | undefined,
  status: Exclude<CodexNativeGoalStatus, "active"> | "cleared"
): void {
  const current = cleanupPending();
  if (!current) {
    return;
  }
  const content = codexAppServerFinalContent(current);
  if (status === "complete" || status === "cleared") {
    current.resolve({
      participant,
      ok: true,
      content,
      durationMs: Date.now() - current.startedAt,
      sessionId: current.threadId,
      roleRuntime: undefined,
      contextUsage: current.contextUsage,
      ...(current.lastCompletedTurnId ? { sessionCut: current.lastCompletedTurnId } : {})
    });
    return;
  }
  const label = codexNativeGoalStatusLabel(status);
  current.resolve({
    participant,
    ok: false,
    content,
    error: `Codex native goal is ${label}.`,
    durationMs: Date.now() - current.startedAt,
    sessionId: current.threadId,
    roleRuntime: undefined,
    contextUsage: current.contextUsage
  });
}

/** A Codex item's row in the words of Codex's TUI (cliToolActivity.ts):
 *  what it says while the item runs, or once it is `finished`. */
export function codexAppServerToolSummary(
  item: Record<string, unknown> | undefined,
  finished: boolean,
  cwd: string | undefined
): { label: string; kind: ChatAgentActivityKind; detail?: string } | undefined {
  if (!item) {
    return undefined;
  }
  const type = stringField(item, "type");
  if (type === "commandExecution") {
    const actions = Array.isArray(item.commandActions)
      ? item.commandActions.map((action) => asRecord(action) ?? {}) as CodexCommandAction[]
      : undefined;
    return codexCommandActivity(stringField(item, "command"), actions, finished, stringField(item, "status"));
  }
  if (type === "mcpToolCall") {
    return codexMcpActivity(stringField(item, "server"), stringField(item, "tool"), item.arguments, finished);
  }
  if (type === "dynamicToolCall") {
    return codexMcpActivity(stringField(item, "namespace"), stringField(item, "tool"), item.arguments, finished);
  }
  if (type === "collabAgentToolCall") {
    const tool = stringField(item, "tool");
    const label = tool === "spawnAgent"
      ? "Spawning subagent"
      : tool === "sendInput"
        ? "Messaging subagent"
        : tool === "wait"
          ? "Waiting for subagent"
          : "Using subagent";
    const detail = stringField(item, "prompt") ?? codexAppServerReadableJson(item.agentsStates);
    return { label, kind: "tool", detail };
  }
  if (type === "webSearch") {
    return codexWebSearchActivity(stringField(item, "query"), finished);
  }
  if (type === "imageView") {
    return { label: "Viewing image", kind: "tool", detail: stringField(item, "path") };
  }
  if (type === "fileChange") {
    return codexFileChangeActivity(codexAppServerFileChanges(item.changes), cwd, codexAppServerFileChangesDetail(item.changes), finished, stringField(item, "status"));
  }
  return undefined;
}
