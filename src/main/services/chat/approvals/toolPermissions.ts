import {
  CLAUDE_EXIT_PLAN_MODE_TOOL, CLAUDE_PLAN_APPROVAL_TITLE, CLAUDE_PLAN_KEEP_PLANNING_ID, claudePlanApprovalFromToolInput,
  claudePlanApprovalOption, claudePlanRejectionMessage, isClaudePlanApprovalRequest
} from "../../../../shared/claudePlanApproval";
import { randomUUID } from "node:crypto";
import type { ChatAppToolApproval, ChatParticipant, Conversation, RespondToChatAppToolApprovalRequest } from "../../../../shared/types";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { CliAgentRunner } from "../../cliAgents";
import { APP_TOOL_PERMISSION_TOOL } from "../../appMcp";
import { APP_TOOL_PERMISSION_WAIT_MS } from "../../../../shared/appMcpToolContracts";
import {
  chatToolPermissionIsScoped, chatToolPermissionScopeSummary, normalizeChatToolPermissionScope
} from "../../../../shared/toolPermissionScope";
import {
  chatAppToolApprovals, isToolPermissionRequest, newAppToolApproval, upsertAppToolApproval, upsertAppToolApprovalPolicy
} from "./approvalRecords";
import {
  chatWorkingDirectory, prepareToolPermissionRequest, toolPermissionAllowed, toolPermissionApprovalForOccurrence,
  toolPermissionDecisionForApproval, toolPermissionPolicyFor
} from "./toolPermissionRules";
import type { PreparedToolPermission, ToolPermissionDecision } from "./types";
import { chatParticipants } from "../members/identity";
import { createChatMessage } from "../store/messages";
import type { ChatAppMcpActor, ChatApprovalExecutionGuard } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Why a plan approval answered without one of its rows (an older phone
 *  app's Allow or Deny) is refused. */
const CLAUDE_PLAN_ANSWER_NEEDS_UPDATE = "Update the phone app to answer this card.";

/** A permission card whose call ended before the User answered it. */
const TOOL_PERMISSION_ABANDONED = "Claude Code stopped waiting for this answer before it was given.";

const TOOL_PERMISSION_ORPHANED = "Nothing is waiting for this answer any more; the request ended before it was answered.";

/** The longest "No, keep planning" answer kept and sent to the CLI. */
const CLAUDE_PLAN_FEEDBACK_MAX_CHARS = 50_000;

type ToolPermissionRequestRoute = "created" | "policy" | "pending-replay" | "terminal-replay";

interface ToolPermissionRequestOutcome {
  prepared: PreparedToolPermission;
  route: ToolPermissionRequestRoute;
  approval?: ChatAppToolApproval;
  decision?: ToolPermissionDecision;
}

/** Permission prompts a member's CLI waits on while it works. */
export class ToolPermissions {
  private readonly toolPermissionResolvers = new Map<string, Set<(decision: ToolPermissionDecision) => void>>();
  /** Permission cards a member's call waits on now, with how many calls. */
  private readonly toolPermissionWaiters = new Map<string, number>();

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "approvalDecisions" | "claudeModes" | "host" | "store">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "storage">
  ) {}

  /** Claude Code's permission prompt (`--permission-prompt-tool`): a card
   *  the call waits on, up to APP_TOOL_PERMISSION_WAIT_MS (the CLI is told
   *  to wait that long, cliAgents claudeMcpConfigJson). `abandoned` aborts
   *  when the CLI gives up on the call (its connection closes): the card is
   *  then expired, so the User is never offered an answer nobody reads. */
  async requestToolPermissionFromTool(actor: ChatAppMcpActor, rawRequest: unknown, abandoned?: AbortSignal): Promise<Record<string, unknown>> {
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
      return { behavior: "deny", message: "This chat member is not allowed to request tool permissions." };
    }

    let outcome: ToolPermissionRequestOutcome;
    try {
      outcome = await this.chat.store.withChatMutation(conversation, async () => {
        const requester = chatParticipants(conversation)
          .find((participant) => participant.id === actor.participantId);
        if (!requester) {
          throw new Error("The requesting member is no longer in this chat.");
        }
        // The token captures the mode resolved for this exact run. Legacy tokens have
        // no mode, so fall back to the participant's current setting rather than a
        // persisted provider session that may still describe the previous turn.
        const agentMode = actor.agentMode
          ? normalizeChatAgentMode(actor.agentMode)
          : normalizeChatAgentMode(requester.agentMode);
        const prepared = prepareToolPermissionRequest(rawRequest, agentMode, chatWorkingDirectory(conversation));
        this.withClaudePlanApproval(prepared, conversation, requester);
        const existing = toolPermissionApprovalForOccurrence(
          conversation,
          requester.id,
          actor.runId,
          prepared.request.nativeOccurrenceId
        );
        if (existing) {
          const decision = toolPermissionDecisionForApproval(existing);
          return {
            prepared,
            route: decision ? "terminal-replay" : "pending-replay",
            approval: existing,
            decision
          };
        }

        // Claude Code asks about its plan every time: no rule answers it.
        const policy = prepared.request.agentMode === "auto" || prepared.request.planApproval
          ? undefined
          : toolPermissionPolicyFor(conversation, requester, prepared.request.toolName, prepared.toolInput);
        if (policy) {
          return {
            prepared,
            route: "policy",
            decision: { approve: true, scope: "chat", source: "policy" }
          };
        }
        // A once-only grant of file edits for this run: its next file edit
        // no rule answered, once (Claude Code's own modes; claudeOnceEditGrants).
        if (!prepared.request.planApproval && this.chat.claudeModes.takeClaudeOnceEdit(actor.runId, requester, prepared.request.toolName)) {
          return {
            prepared,
            route: "policy",
            decision: { approve: true, scope: "once", source: "policy" }
          };
        }

        const approval = newAppToolApproval(
          conversation,
          requester,
          APP_TOOL_PERMISSION_TOOL,
          "permissions.request",
          prepared.request,
          prepared.summary,
          "pending"
        );
        if (actor.runId && actor.triggerMessageId) {
          approval.resumeContext = {
            runId: actor.runId,
            triggerMessageId: actor.triggerMessageId,
            participantRequestBatchId: actor.participantRequestBatchId
          };
        }
        upsertAppToolApproval(conversation, approval);
        conversation.messages.push(createChatMessage(
          "system",
          `Tool approval needed for @${requester.handle}: ${prepared.summary}${/[.?!]$/.test(prepared.summary) ? "" : "."}`,
          undefined,
          { threadId: "system" }
        ));
        conversation.updatedAt = new Date().toISOString();
        // Waited on from before the card is shown: an answer is never taken
        // for one to a card nobody waits on.
        this.noteToolPermissionWaiter(approval.id, 1);
        try {
          await this.chat.store.saveConversation(conversation);
        } catch (error) {
          this.noteToolPermissionWaiter(approval.id, -1);
          throw error;
        }
        return { prepared, route: "created", approval };
      });
    } catch (error) {
      return { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
    }

    void this.deps.debugLogs.write("chat.claude.permission-prompt.invoked", {
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      runId: actor.runId,
      agentMode: outcome.prepared.request.agentMode,
      toolName: outcome.prepared.request.toolName,
      nativeOccurrenceIdPresent: Boolean(outcome.prepared.request.nativeOccurrenceId),
      route: outcome.route
    });

    if (outcome.decision?.approve) {
      this.logToolPermissionResolution(actor, outcome, outcome.decision);
      return toolPermissionAllowed(outcome.prepared.toolInput, outcome.decision);
    }
    if (outcome.decision) {
      this.logToolPermissionResolution(actor, outcome, outcome.decision);
      return {
        behavior: "deny",
        message: outcome.decision.reason ?? "User denied this tool request."
      };
    }

    const approval = outcome.approval;
    if (!approval) {
      return { behavior: "deny", message: "Tool permission request could not be created." };
    }
    if (outcome.route !== "created") {
      this.noteToolPermissionWaiter(approval.id, 1);
    }
    let decision: ToolPermissionDecision;
    try {
      decision = await this.waitForToolPermissionDecision(actor.conversationId, approval.id, actor.runId, abandoned);
    } finally {
      this.noteToolPermissionWaiter(approval.id, -1);
    }
    if (!decision.approve && decision.source !== "user" && this.toolPermissionWaiters.has(approval.id)) {
      // Another call (the same tool call asked again) still waits on this
      // card: it stays open for that one.
      this.logToolPermissionResolution(actor, outcome, decision);
      return { behavior: "deny", message: decision.reason ?? "Tool permission request did not receive approval." };
    }
    if (!decision.approve && decision.source === "abort" && abandoned?.aborted) {
      // Claude Code stopped waiting for this answer: the card can no longer
      // be answered, so it says so instead of taking a click that does nothing.
      await this.expirePendingToolPermissionApproval(actor.conversationId, approval.id, TOOL_PERMISSION_ABANDONED);
      this.logToolPermissionResolution(actor, outcome, { ...decision, reason: TOOL_PERMISSION_ABANDONED });
      return { behavior: "deny", message: TOOL_PERMISSION_ABANDONED };
    }
    if (!decision.approve) {
      if (decision.source !== "user") {
        await this.denyPendingToolPermissionApproval(
          actor.conversationId,
          approval.id,
          decision.reason ?? "Tool permission request did not receive approval."
        );
      }
      this.logToolPermissionResolution(actor, outcome, decision);
      return {
        behavior: "deny",
        message: decision.reason ?? "User denied this tool request."
      };
    }
    this.logToolPermissionResolution(actor, outcome, decision);
    return toolPermissionAllowed(outcome.prepared.toolInput, decision);
  }

  /** Claude Code's ExitPlanMode, from a member in its CLI's own mode: the
   *  CLI's own plan approval ("Ready to code?", claudePlanApproval.ts), in
   *  place of a tool permission card. The plan is kept on the card only
   *  until she answers it. */
  private withClaudePlanApproval(prepared: PreparedToolPermission, conversation: Conversation, requester: ChatParticipant): void {
    if (prepared.request.toolName !== CLAUDE_EXIT_PLAN_MODE_TOOL || requester.kind !== "claude-code" ||
      normalizeChatAgentPermissions(requester.permissions).cliApprovals !== true) {
      return;
    }
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeAutoModeAvailable">>;
    const autoModeAvailable = runner.memberClaudeAutoModeAvailable?.call(this.deps.cliRunner, conversation.id, requester.id) === true;
    const { toolInput: _preview, chatScope: _scope, ...request } = prepared.request;
    prepared.request = { ...request, planApproval: claudePlanApprovalFromToolInput(prepared.toolInput, autoModeAvailable) };
    prepared.summary = CLAUDE_PLAN_APPROVAL_TITLE;
  }

  async respondToToolPermissionApproval(
    request: RespondToChatAppToolApprovalRequest,
    execution?: ChatApprovalExecutionGuard
  ): Promise<Conversation | undefined> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return conversation;
    }
    let decidedApproval: ChatAppToolApproval | undefined;
    let decision: ToolPermissionDecision | undefined;
    let expired = false;
    await this.chat.store.withChatMutation(conversation, async () => {
      const approval = chatAppToolApprovals(conversation)
        .find((item) => item.id === request.approvalId);
      if (!approval || approval.toolName !== APP_TOOL_PERMISSION_TOOL || !isToolPermissionRequest(approval.request)) {
        throw new Error("App tool approval request was not found.");
      }
      if (approval.status !== "pending") {
        throw new Error("App tool approval request has already been answered.");
      }

      const now = new Date().toISOString();
      if (!this.toolPermissionWaiters.has(approval.id)) {
        // No call waits on it any more (its CLI stopped waiting, or the app
        // restarted): the card says so instead of taking an answer that
        // would do nothing, and the answer is refused (never "applied").
        upsertAppToolApproval(conversation, { ...approval, status: "expired", error: TOOL_PERMISSION_ORPHANED, updatedAt: now });
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
        expired = true;
        return;
      }
      const plan = isClaudePlanApprovalRequest(approval.request) ? approval.request.planApproval : undefined;
      if (plan) {
        // Claude Code's plan approval takes one of the rows it offered, as
        // the CLI's own dialog does. A Deny without one (Activity's Cancel,
        // an older phone's Deny) is "No, keep planning" with nothing typed,
        // as Esc declines it in the CLI; an Allow without one (an older
        // phone's) is refused, the card asked again.
        if (!request.planDecision && request.approve) {
          throw new Error(CLAUDE_PLAN_ANSWER_NEEDS_UPDATE);
        }
        const option = claudePlanApprovalOption(plan, request.planDecision?.optionId ?? CLAUDE_PLAN_KEEP_PLANNING_ID);
        if (!option || request.approve !== Boolean(option.mode)) {
          throw new Error("This answer is not one this card takes.");
        }
        await execution?.beforeApply(approval);
        const feedback = option.mode ? undefined : request.planDecision?.feedback?.trim().slice(0, CLAUDE_PLAN_FEEDBACK_MAX_CHARS) || undefined;
        // The plan stays in the CLI's session: the answered card keeps only
        // what she picked, so answered plans do not pile up in the chat.
        const { plan: _plan, ...asked } = plan;
        decidedApproval = {
          ...approval,
          request: { ...approval.request, planApproval: asked },
          status: option.mode ? "approved" : "denied",
          ...(option.mode ? { approvalScope: "once" as const } : {}),
          planDecision: { optionId: option.id, ...(feedback ? { feedback } : {}) },
          updatedAt: now
        };
        decision = option.mode
          ? { approve: true, scope: "once", source: "user", planMode: option.mode }
          : { approve: false, source: "user", reason: claudePlanRejectionMessage(feedback) };
        conversation.messages.push(createChatMessage("system", `@${approval.requesterHandle}: ${option.label}.`, undefined, { threadId: "system" }));
      } else if (!request.approve) {
        await execution?.beforeApply(approval);
        decidedApproval = {
          ...approval,
          status: "denied",
          updatedAt: now
        };
        decision = {
          approve: false,
          source: "user",
          reason: "User denied this tool request."
        };
      } else {
        const requester = chatParticipants(conversation)
          .find((participant) => participant.id === approval.requesterParticipantId);
        if (!requester) {
          throw new Error("The requesting member is no longer in this chat.");
        }
        // Legacy pending records did not persist the run mode. Their safe fallback is
        // the member's current mode, never the provider session's previous-turn mode.
        const agentMode = approval.request.agentMode ?? normalizeChatAgentMode(requester.agentMode);
        // "For this chat" covers what Claude Code's "don't ask again" covers
        // (a command prefix, a domain, a folder); a scoped tool's request
        // that could not be scoped is allowed once.
        const chatScope = normalizeChatToolPermissionScope(approval.request.chatScope);
        const scopedTool = chatToolPermissionIsScoped(approval.request.toolName);
        const scope = agentMode === "auto" || (scopedTool && !chatScope) ? "once" : request.scope === "chat" ? "chat" : "once";
        await execution?.beforeApply(approval);
        decidedApproval = {
          ...approval,
          status: "approved",
          approvalScope: scope,
          updatedAt: now
        };
        decision = { approve: true, scope, source: "user" };
        if (scope === "chat") {
          upsertAppToolApprovalPolicy(conversation, {
            id: randomUUID(),
            participantId: approval.requesterParticipantId,
            roleConfigId: approval.requesterRoleConfigId,
            toolName: approval.toolName,
            capability: approval.capability,
            targetToolName: approval.request.toolName,
            ...(scopedTool && chatScope ? { targetToolScope: chatScope } : {}),
            scope: "chat",
            createdAt: now,
            updatedAt: now
          });
        }
        conversation.messages.push(createChatMessage(
          "system",
          scope === "chat"
            ? `Allowed @${approval.requesterHandle} to ${scopedTool && chatScope ? chatToolPermissionScopeSummary(chatScope) : `use ${approval.request.toolName}`} for this chat.`
            : `Allowed @${approval.requesterHandle} to use ${approval.request.toolName} once.`,
          undefined,
          { threadId: "system" }
        ));
      }
      upsertAppToolApproval(conversation, decidedApproval);
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
    });

    if (expired) {
      throw new Error(TOOL_PERMISSION_ORPHANED);
    }
    if (!decidedApproval || !decision) {
      throw new Error("App tool approval request could not be resolved.");
    }
    if (!decision.approve) {
      try {
        await this.chat.approvalDecisions.emitAppToolApprovalDecision({
          conversationId: conversation.id,
          approval: decidedApproval,
          status: "denied"
        });
      } finally {
        this.resolveToolPermissionApproval(request.approvalId, decision);
      }
    } else {
      this.resolveToolPermissionApproval(request.approvalId, decision);
    }
    return conversation;
  }

  private noteToolPermissionWaiter(approvalId: string, change: 1 | -1): void {
    const count = (this.toolPermissionWaiters.get(approvalId) ?? 0) + change;
    if (count > 0) this.toolPermissionWaiters.set(approvalId, count);
    else this.toolPermissionWaiters.delete(approvalId);
  }

  /** A permission card whose call ended unanswered: closed as expired. */
  private async expirePendingToolPermissionApproval(conversationId: string, approvalId: string, reason: string): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    await this.chat.store.saveChatChange(conversation, () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
      // A call that joined meanwhile (the same tool call asked again) keeps it open.
      if (!approval || approval.status !== "pending" || approval.toolName !== APP_TOOL_PERMISSION_TOOL || this.toolPermissionWaiters.has(approvalId)) return;
      upsertAppToolApproval(conversation, { ...approval, status: "expired", error: reason, updatedAt: new Date().toISOString() });
    }).catch(() => undefined);
  }

  /** Permission cards of this device's members that no call waits on any
   *  more (the app restarted while they were open): closed as expired, so
   *  none offers an answer that would do nothing. */
  expireOrphanedToolPermissions(conversation: Conversation): boolean {
    const owned = new Set(chatParticipants(conversation).filter((participant) => this.chat.host.ownsParticipant(participant)).map((participant) => participant.id));
    const now = new Date().toISOString();
    let changed = false;
    const nextApprovals = chatAppToolApprovals(conversation).map((approval) => {
      if (approval.toolName !== APP_TOOL_PERMISSION_TOOL || approval.status !== "pending" || !owned.has(approval.requesterParticipantId) ||
        (approval.homeMachineId && approval.homeMachineId !== this.chat.host.hostMachineId) || this.toolPermissionWaiters.has(approval.id)) {
        return approval;
      }
      changed = true;
      return { ...approval, status: "expired" as const, error: TOOL_PERMISSION_ORPHANED, updatedAt: now };
    });
    if (changed) {
      conversation.metadata = { ...conversation.metadata, pendingAppToolApprovals: nextApprovals };
    }
    return changed;
  }

  private logToolPermissionResolution(
    actor: ChatAppMcpActor,
    outcome: ToolPermissionRequestOutcome,
    decision: ToolPermissionDecision
  ): void {
    void this.deps.debugLogs.write("chat.claude.permission-prompt.resolved", {
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      runId: actor.runId,
      agentMode: outcome.prepared.request.agentMode,
      toolName: outcome.prepared.request.toolName,
      nativeOccurrenceIdPresent: Boolean(outcome.prepared.request.nativeOccurrenceId),
      route: outcome.route,
      behavior: decision.approve ? "allow" : "deny",
      source: decision.source
    });
  }

  waitForToolPermissionDecision(
    conversationId: string,
    approvalId: string,
    runId: string | undefined,
    /** Aborts when the member's CLI gave up on the call that waits. */
    abandoned?: AbortSignal
  ): Promise<ToolPermissionDecision> {
    return new Promise<ToolPermissionDecision>((resolve) => {
      let settled = false;
      const controller = runId ? this.chat.activeRuns.firstChatRunController(runId) : undefined;
      const signal = controller?.signal && abandoned ? AbortSignal.any([controller.signal, abandoned]) : controller?.signal ?? abandoned;
      let timer: NodeJS.Timeout;
      const finish = (decision: ToolPermissionDecision): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const resolvers = this.toolPermissionResolvers.get(approvalId);
        resolvers?.delete(finish);
        if (resolvers?.size === 0) {
          this.toolPermissionResolvers.delete(approvalId);
        }
        resolve(decision);
      };
      const onAbort = (): void => {
        finish({
          approve: false,
          source: "abort",
          reason: "Tool permission request was cancelled because the chat run stopped."
        });
      };
      timer = setTimeout(() => {
        finish({
          approve: false,
          source: "timeout",
          reason: "Timed out waiting for User approval."
        });
      }, APP_TOOL_PERMISSION_WAIT_MS);
      const resolvers = this.toolPermissionResolvers.get(approvalId) ?? new Set();
      resolvers.add(finish);
      this.toolPermissionResolvers.set(approvalId, resolvers);
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
      // A fast UI response can land after the pending approval is saved but before
      // this waiter is registered. Re-read durable state after registration so that
      // race resolves to the stored decision rather than timing out.
      void this.deps.storage.getConversation(conversationId).then((conversation) => {
        if (!conversation || conversation.kind !== "chat") {
          return;
        }
        const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
        if (!approval) {
          return;
        }
        const decision = toolPermissionDecisionForApproval(approval);
        if (decision) {
          finish(decision);
        }
      }).catch(() => undefined);
    });
  }

  resolveToolPermissionApproval(approvalId: string, decision: ToolPermissionDecision): void {
    for (const resolve of Array.from(this.toolPermissionResolvers.get(approvalId) ?? [])) {
      resolve(decision);
    }
  }

  private async denyPendingToolPermissionApproval(conversationId: string, approvalId: string, reason: string): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    await this.chat.store.withChatMutation(conversation, async () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
      if (!approval || approval.status !== "pending" || approval.toolName !== APP_TOOL_PERMISSION_TOOL || this.toolPermissionWaiters.has(approvalId)) {
        return;
      }
      const now = new Date().toISOString();
      upsertAppToolApproval(conversation, {
        ...approval,
        status: "denied",
        error: reason,
        updatedAt: now
      });
      conversation.messages.push(createChatMessage("system", `Denied tool request from @${approval.requesterHandle}: ${reason}`, undefined, {
        threadId: "system"
      }));
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
    });
  }
}
