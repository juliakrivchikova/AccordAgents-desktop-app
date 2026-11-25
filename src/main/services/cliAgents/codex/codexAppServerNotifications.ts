import type { ParticipantConfig } from "../../../../shared/types";
import { codexContextFromEvent } from "../../cliContextUsage";
import { codexFileChangeActivity } from "../../cliToolActivity";
import {
  codexAppServerThreadId, codexAppServerToolSummary, codexAppServerTurnId, codexNativeGoalStatus, codexNativeGoalStatusLabel,
  settleCodexNativeGoal
} from "./appServerEvents";
import {
  appendCodexAppServerAgentText, appendCodexAppServerAgentTextDelta, codexAppServerCompletedActivityDetail,
  codexAppServerCompletedActivityOutput, codexAppServerFileChanges, codexAppServerFileChangesDetail, codexAppServerFinalContent,
  codexAppServerSubagentDetail, flushCodexAppServerAgentText, normalizeCodexAppServerCompleteText, textWithAgentMessageBoundary
} from "./appServerText";
import { codexContextUsage } from "./execOutput";
import type { CodexAppServerPendingTurn } from "./types";
import { emitLiveOutput } from "../runs/outputText";
import { asRecord, findStringField, stringField } from "../runs/records";
import type { CliDependencies } from "../dependencies";

/** What a live codex app-server says while it works. */
export class CodexAppServerNotifications {
  constructor(private readonly deps: Pick<CliDependencies, "debugLogs">) {}

  handleCodexAppServerNotification(
    record: Record<string, unknown>,
    participant: ParticipantConfig,
    pending: CodexAppServerPendingTurn | undefined,
    cleanupPending: () => CodexAppServerPendingTurn | undefined,
    rejectPending: (error: Error) => void,
    rejectPendingGuardianApprovals: (error: Error) => void = () => undefined
  ): void {
    if (!pending) {
      return;
    }
    const method = stringField(record, "method");
    const params = asRecord(record.params);
    if (!method || !params) {
      return;
    }
    this.logCodexAppServerNotificationSummary(method, params, pending);
    const eventTurnId = codexAppServerTurnId(record, params);
    const eventThreadId = codexAppServerThreadId(record, params);
    if (eventThreadId && eventThreadId !== pending.threadId) {
      if (method === "error") {
        void this.deps.debugLogs?.write("cli.codex-app-server.child-thread-error-dropped", {
          threadId: eventThreadId,
          expectedThreadId: pending.threadId,
          turnId: eventTurnId,
          message: stringField(asRecord(params.error) ?? {}, "message")
        });
      }
      return;
    }
    // Current app-server notifications always identify their thread. Keep the
    // turn-id fallback for older/experimental events that do not. A goal can
    // replace the root turn id while continuing in the same thread, whereas a
    // native subagent runs in a different thread.
    if (!eventThreadId && !pending.nativeGoal && pending.turnId && eventTurnId && eventTurnId !== pending.turnId) {
      return;
    }
    if (method === "turn/started" || method === "turn/completed" || method.startsWith("item/")) {
      pending.acceptedByProvider = true;
    }
    if (method === "turn/started") {
      pending.turnId = eventTurnId ?? pending.turnId;
      if (pending.nativeGoal) {
        pending.nativeGoal.turnCompleted = false;
      }
      return;
    }
    if (method === "thread/goal/updated" && pending.nativeGoal) {
      const goal = asRecord(params.goal);
      const status = codexNativeGoalStatus(stringField(goal ?? {}, "status"));
      if (status) {
        pending.nativeGoal.status = status;
        if (status !== "active") {
          emitLiveOutput(pending.onOutput, "tool", `Native goal ${codexNativeGoalStatusLabel(status)}\n`, undefined, {
            activityKind: "status",
            activityStatus: status === "complete" ? "completed" : "failed",
            activityDetail: `Codex native goal status: ${status}`
          });
        }
      }
      if (pending.nativeGoal.turnCompleted && status && status !== "active") {
        settleCodexNativeGoal(participant, cleanupPending, status);
      }
      return;
    }
    if (method === "thread/goal/cleared" && pending.nativeGoal) {
      pending.nativeGoal.status = "cleared";
      if (pending.nativeGoal.turnCompleted) {
        settleCodexNativeGoal(participant, cleanupPending, "cleared");
      }
      return;
    }
    if (method === "item/autoApprovalReview/started") {
      emitLiveOutput(pending.onOutput, "tool", "Auto-reviewing approval request\n", undefined, {
        activityKind: "approval",
        activityStatus: "started"
      });
      return;
    }
    if (method === "item/autoApprovalReview/completed") {
      const review = asRecord(params.review);
      const status = stringField(review ?? {}, "status");
      const label = status === "approved"
        ? "Auto Review approved the request"
        : status === "denied"
          ? "Auto Review denied the request"
          : status === "timedOut"
            ? "Auto Review timed out"
            : status === "aborted"
              ? "Auto Review stopped"
              : "Auto Review completed";
      emitLiveOutput(pending.onOutput, "tool", `${label}\n`, undefined, {
        activityKind: "approval",
        activityStatus: status === "approved" ? "completed" : "failed",
        ...(stringField(review ?? {}, "rationale") ? { activityDetail: stringField(review ?? {}, "rationale") } : {})
      });
      return;
    }
    if (method === "item/started") {
      const item = asRecord(params.item);
      const itemType = stringField(item ?? {}, "type");
      if (itemType === "agentMessage" && pending.streamedText.trim()) {
        pending.nextAgentMessageStartsBlock = true;
      }
      const summary = codexAppServerToolSummary(item, false, pending.cwd);
      const activityItemId = stringField(item ?? {}, "id");
      if (summary) {
        if (
          activityItemId &&
          (itemType === "commandExecution" || itemType === "mcpToolCall" || itemType === "fileChange")
        ) {
          pending.activityItems.set(activityItemId, { ...summary, ...(item ? { item } : {}) });
        }
        emitLiveOutput(pending.onOutput, "tool", `${summary.label}\n`, undefined, {
          activityKind: summary.kind,
          activityStatus: "started",
          ...(activityItemId ? { activityItemId } : {}),
          ...(summary.detail ? { activityDetail: summary.detail } : {})
        });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = stringField(params, "delta");
      if (delta) {
        appendCodexAppServerAgentTextDelta(pending, delta);
      }
      return;
    }
    if (
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta" ||
      method === "item/mcpToolCall/progress"
    ) {
      // The dedicated Codex CLI keeps raw tool output out of the assistant
      // transcript. Item activity carries the user-visible tool state instead.
      return;
    }
    if (method === "item/fileChange/patchUpdated") {
      const detail = codexAppServerFileChangesDetail(params.changes);
      if (detail) {
        const activityItemId = stringField(params, "itemId");
        // A patch updated while it runs is proposed, not applied yet.
        const summary = codexFileChangeActivity(codexAppServerFileChanges(params.changes), pending.cwd, detail, false);
        if (activityItemId) {
          const prior = pending.activityItems.get(activityItemId)?.item;
          pending.activityItems.set(activityItemId, { ...summary, item: { ...(prior ?? { id: activityItemId, type: "fileChange" }), changes: params.changes } });
        }
        emitLiveOutput(pending.onOutput, "tool", `${summary.label}\n`, undefined, {
          activityKind: "file-edit",
          activityStatus: "started",
          ...(activityItemId ? { activityItemId } : {}),
          activityDetail: detail
        });
      }
      return;
    }
    if (method === "item/completed") {
      const item = asRecord(params.item);
      const itemType = stringField(item ?? {}, "type");
      const itemId = stringField(item ?? {}, "id");
      if (itemType === "agentMessage") {
        flushCodexAppServerAgentText(pending);
        const text = stringField(item ?? {}, "text");
        if (text) {
          const normalizedText = normalizeCodexAppServerCompleteText(text);
          pending.finalMessage = normalizedText;
          pending.completedAgentMessages.push(normalizedText);
          if (!pending.streamedText.trimEnd().endsWith(normalizedText.trimEnd())) {
            pending.streamedText = textWithAgentMessageBoundary(
              pending.streamedText,
              normalizedText,
              { fencedBlockEndsBlock: true }
            );
            pending.streamedText += normalizedText;
            appendCodexAppServerAgentText(pending, normalizedText, true);
          }
        }
      } else if (itemType === "subAgentActivity") {
        const detail = codexAppServerSubagentDetail(item);
        emitLiveOutput(pending.onOutput, "tool", "Using subagent\n", undefined, {
          activityKind: "tool",
          activityStatus: "completed",
          activityItemId: itemId ?? "subAgentActivity",
          ...(detail ? { activityDetail: detail } : {})
        });
      } else if (
        itemType === "commandExecution" ||
        itemType === "mcpToolCall" ||
        itemType === "fileChange"
      ) {
        const priorSummary = itemId ? pending.activityItems.get(itemId) : undefined;
        // What the item said as it started, with what its completion says.
        const finishedItem = priorSummary?.item && item ? { ...priorSummary.item, ...item } : item;
        const completedSummary = codexAppServerToolSummary(finishedItem, true, pending.cwd);
        const itemStatus = stringField(finishedItem ?? {}, "status");
        // The row takes the CLI's finished words ("Ran …", "Called …"); a
        // step that failed or was declined ends failed.
        const summary = completedSummary
          ? {
            ...completedSummary,
            kind: priorSummary?.kind ?? completedSummary.kind
          }
          : priorSummary;
        if (summary) {
          const invocation = completedSummary?.detail ?? priorSummary?.detail;
          const detail = itemType === "fileChange"
            ? invocation
            : codexAppServerCompletedActivityDetail(
              invocation,
              codexAppServerCompletedActivityOutput(finishedItem)
            );
          emitLiveOutput(pending.onOutput, "tool", `${summary.label}\n`, undefined, {
            activityKind: summary.kind,
            activityStatus: itemStatus === "failed" || itemStatus === "declined" ? "failed" : "completed",
            ...(itemId ? { activityItemId: itemId } : {}),
            ...(detail ? { activityDetail: detail } : {})
          });
        }
        if (itemId) {
          pending.activityItems.delete(itemId);
        }
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      pending.contextUsage = codexContextUsage(codexContextFromEvent(record), participant) ?? pending.contextUsage;
      return;
    }
    if (method === "error") {
      const error = asRecord(params.error);
      const failure = new Error(stringField(error ?? {}, "message") ?? "codex app-server reported an error");
      rejectPendingGuardianApprovals(failure);
      rejectPending(failure);
      return;
    }
    if (method !== "turn/completed") {
      return;
    }
    const turn = asRecord(params.turn);
    const completedTurnId = stringField(turn ?? {}, "id") ?? eventTurnId;
    if (!pending.nativeGoal && completedTurnId && pending.turnId && completedTurnId !== pending.turnId) {
      void this.deps.debugLogs?.write("cli.codex-app-server.turn-completed-ignored", {
        threadId: pending.threadId,
        expectedTurnId: pending.turnId,
        eventTurnId: completedTurnId
      });
      return;
    }
    const status = stringField(turn ?? {}, "status");
    flushCodexAppServerAgentText(pending);
    // Where the thread stands when the reply ends (a goal's last turn).
    if (completedTurnId) pending.lastCompletedTurnId = completedTurnId;
    if (status !== "completed") {
      rejectPendingGuardianApprovals(new Error(`Codex Guardian approval expired because the provider turn ${status ?? "failed"}.`));
      const current = cleanupPending();
      if (!current) {
        return;
      }
      const error = asRecord(turn?.error);
      current.reject(new Error(stringField(error ?? {}, "message") ?? `codex app-server turn ${status ?? "failed"}`));
      return;
    }
    if (pending.nativeGoal) {
      pending.nativeGoal.turnCompleted = true;
      if (pending.nativeGoal.status && pending.nativeGoal.status !== "active") {
        settleCodexNativeGoal(participant, cleanupPending, pending.nativeGoal.status);
      }
      return;
    }
    const current = cleanupPending();
    if (!current) {
      return;
    }
    const content = codexAppServerFinalContent(current);
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
  }

  private logCodexAppServerNotificationSummary(
    method: string,
    params: Record<string, unknown>,
    pending: CodexAppServerPendingTurn
  ): void {
    const item = asRecord(params.item);
    const delta = stringField(params, "delta");
    const itemType = stringField(item ?? {}, "type");
    const text = stringField(item ?? {}, "text");
    const turn = asRecord(params.turn);
    void this.deps.debugLogs?.write("cli.codex-app-server.event-summary", {
      method,
      itemType,
      itemId: stringField(item ?? {}, "id"),
      turnId: stringField(turn ?? {}, "id") ?? findStringField(params, ["turnId", "turn_id"]) ?? pending.turnId,
      deltaLength: delta?.length,
      completedTextLength: text?.length
    });
  }
}
