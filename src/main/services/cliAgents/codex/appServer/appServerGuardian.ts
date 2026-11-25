import {
  CODEX_GUARDIAN_DENIED_APPROVAL_METHOD, CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD, codexGuardianAssessmentEvent,
  type CodexServerRequestDelivery
} from "../../../codexApprovals";
import { emitLiveOutput, errorText } from "../../runs/outputText";
import { asRecord, stringField } from "../../runs/records";
import type { AppServerModules } from "./modules";
import type { AppServerLaunch } from "./launch";

interface CodexAppServerPendingGuardianApproval {
  key: string;
  controller: AbortController;
  threadId: string;
  turnId: string;
  reviewId: string;
  targetItemId: string | null;
}

/** Codex's own Guardian reviews of an action it refused. */
export class AppServerGuardian {
  private readonly pendingGuardianApprovals = new Map<string, CodexAppServerPendingGuardianApproval>();
  private readonly seenGuardianReviewKeys = new Set<string>();

  constructor(
    private readonly server: Pick<AppServerModules, "connection" | "thread" | "turns">,
    private readonly launch: Pick<AppServerLaunch, "child" | "debugLogs">
  ) {}

  rejectPendingGuardianApprovals(error: Error): void {
    for (const approval of this.pendingGuardianApprovals.values()) {
      approval.controller.abort(error);
    }
    this.pendingGuardianApprovals.clear();
  }

  handleGuardianReviewCompleted(record: Record<string, unknown>): void {
    if (stringField(record, "method") !== "item/autoApprovalReview/completed") {
      return;
    }
    const params = asRecord(record.params);
    const review = asRecord(params?.review);
    const reviewId = stringField(params ?? {}, "reviewId");
    const notificationThreadId = stringField(params ?? {}, "threadId");
    const notificationTurnId = stringField(params ?? {}, "turnId");
    const status = stringField(review ?? {}, "status");
    const targetItemId = params?.targetItemId === null
      ? null
      : stringField(params ?? {}, "targetItemId");
    if (
      !params || !review || !reviewId || !notificationThreadId || !notificationTurnId ||
      (params.targetItemId !== null && !targetItemId) ||
      (status !== "denied" && status !== "timedOut" && status !== "approved" && status !== "aborted")
    ) {
      return;
    }
    const turn = this.server.turns.pendingTurn;
    if (
      !turn?.onCodexServerRequest ||
      notificationThreadId !== turn.threadId ||
      (turn.turnId && notificationTurnId !== turn.turnId)
    ) {
      return;
    }
    if (!turn.turnId) turn.turnId = notificationTurnId;
    const key = `${notificationThreadId}:${notificationTurnId}:${reviewId}:${targetItemId ?? "<none>"}`;
    if (this.seenGuardianReviewKeys.has(key)) return;
    if (this.seenGuardianReviewKeys.size >= 512) {
      const oldest = this.seenGuardianReviewKeys.values().next().value;
      if (typeof oldest === "string") this.seenGuardianReviewKeys.delete(oldest);
    }
    this.seenGuardianReviewKeys.add(key);
    turn.acceptedByProvider = true;
    if (status === "approved" || status === "aborted") return;
    if (status === "timedOut") {
      void turn.onCodexServerRequest({
        id: `guardian-timeout:${reviewId}`,
        method: CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD,
        params,
        signal: new AbortController().signal,
        responseDelivered: Promise.resolve({ turnActive: true })
      }).catch((error) => {
        void this.launch.debugLogs?.write("cli.codex-app-server.guardian-timeout-projection-failed", {
          threadId: notificationThreadId,
          turnId: notificationTurnId,
          reviewId,
          message: errorText(error)
        });
      });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = codexGuardianAssessmentEvent(params);
    } catch (error) {
      const message = `Codex Auto Review denial could not be prepared for approval: ${errorText(error)}`;
      emitLiveOutput(turn.onOutput, "tool", `${message}\n`, undefined, {
        activityKind: "approval",
        activityStatus: "failed",
        activityDetail: message
      });
      void this.launch.debugLogs?.write("cli.codex-app-server.guardian-approval-invalid", {
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        reviewId,
        message: errorText(error)
      });
      return;
    }
    const controller = new AbortController();
    const approval: CodexAppServerPendingGuardianApproval = {
      key,
      controller,
      threadId: notificationThreadId,
      turnId: notificationTurnId,
      reviewId,
      targetItemId: targetItemId ?? null
    };
    this.pendingGuardianApprovals.set(key, approval);
    let resolveDelivery!: (delivery: CodexServerRequestDelivery) => void;
    let rejectDelivery!: (error: Error) => void;
    const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    void responseDelivered.catch(() => undefined);
    // A Guardian denial never blocks the turn that raised it. Codex applies
    // the User's decision inside that turn while it is still running and only
    // records it in the thread history once the turn has ended, so the
    // receipt tells the chat whether a continuation is needed at all.
    void turn.onCodexServerRequest({
      id: `guardian:${reviewId}`,
      method: CODEX_GUARDIAN_DENIED_APPROVAL_METHOD,
      params,
      signal: controller.signal,
      responseDelivered
    }).then(async (result) => {
      if (this.pendingGuardianApprovals.get(key) !== approval || controller.signal.aborted) {
        throw new Error("The Guardian approval is no longer active.");
      }
      // Sample the turn state synchronously, as the decision is handed over,
      // before any `await`. Reading it after `await sendRequest` is unsafe:
      // Codex's acknowledgement and the turn's `turn/completed` can arrive in
      // one stdout chunk, so the completion handler clears `pendingTurn`
      // before the post-await read runs — reporting `turnActive:false` for a
      // retry Codex already applied in-turn, which would run it a second time.
      const turnActive = this.server.turns.pendingTurn === turn;
      const decision = stringField(asRecord(result) ?? {}, "decision");
      if (decision !== "approveRetry") {
        resolveDelivery({ turnActive });
        return;
      }
      if (this.server.connection.closed || this.launch.child.exitCode !== null || this.launch.child.killed || this.server.thread.threadId !== notificationThreadId) {
        throw new Error("The Codex app-server session for this Guardian denial is no longer active.");
      }
      await this.server.connection.sendRequest("thread/approveGuardianDeniedAction", {
        threadId: notificationThreadId,
        event
      }, 10_000);
      void this.launch.debugLogs?.write("cli.codex-app-server.guardian-approval-sent", {
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        reviewId,
        turnActive
      });
      emitLiveOutput(turn.onOutput, "tool", "Recorded User approval for the Auto Review denial\n", undefined, {
        activityKind: "approval",
        activityStatus: "completed",
        activityDetail: turnActive
          ? "The User approved one retry. Codex received it inside the running response."
          : "The User approved one retry. AccordAgents will continue the participant with it."
      });
      resolveDelivery({ turnActive });
    }).catch((error) => {
      const deliveryError = error instanceof Error ? error : new Error(String(error));
      rejectDelivery(deliveryError);
      if (controller.signal.aborted) {
        return;
      }
      const message = errorText(deliveryError);
      emitLiveOutput(turn.onOutput, "tool", `Could not approve the Auto Review retry: ${message}\n`, undefined, {
        activityKind: "approval",
        activityStatus: "failed",
        activityDetail: message
      });
      void this.launch.debugLogs?.write("cli.codex-app-server.guardian-approval-failed", {
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        reviewId,
        message
      });
    }).finally(() => {
      if (this.pendingGuardianApprovals.get(key) === approval) {
        this.pendingGuardianApprovals.delete(key);
      }
    });
  }
}
