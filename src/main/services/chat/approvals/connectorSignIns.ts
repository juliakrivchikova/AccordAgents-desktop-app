import type {
  ChatAppToolApproval, ChatConnectorSignInRequest, Conversation, RespondToChatAppToolApprovalRequest
} from "../../../../shared/types";
import { CliAgentRunner } from "../../cliAgents";
import { APP_CONNECTOR_SIGN_IN_TOOL } from "../../appMcp";
import {
  CONNECTOR_CONTROL_TIMEOUT_MS, CONNECTOR_PENDING_WAIT_MS, connectorSignInHost, connectorSignInSummary, isConnectorSignInRequest,
  matchMcpServer, parseConnectorSignInInput, parseMcpServerStatuses, type McpServerStatus
} from "../../../../shared/connectorSignIn";
import { chatAppToolApprovals, newAppToolApproval, reconnectConnectorForMember, upsertAppToolApproval } from "./approvalRecords";
import type { ToolPermissionDecision } from "./types";
import { chatParticipants } from "../members/identity";
import type { ChatAppMcpActor, ChatApprovalExecutionGuard } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CONNECTOR_SIGN_IN_ORPHANED = "No member is waiting for this sign-in any more; it ended before you answered.";

/** Sign-in cards for connectors a member's CLI needs. */
export class ConnectorSignIns {
  /** Sign-in cards members' calls wait on in this process, by how many calls
   *  wait. Any other pending one was left by a call that ended (the app
   *  restarted), and is closed rather than answered into nothing. */
  private readonly connectorSignInWaiters = new Map<string, number>();
  /** Sign-in cards answered Done whose server is being reconnected. */
  private readonly connectorSignInReconnects = new Map<string, Promise<Record<string, unknown>>>();
  private connectorSignedInObserver?: () => void;

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "host" | "store" | "toolPermissions">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "storage">
  ) {}

  /** Told when a member's connector was connected through the sign-in card
   *  (the computer's usage signals; a machine's runtime sets none). */
  setConnectorSignedInObserver(observer: (() => void) | undefined): void {
    this.connectorSignedInObserver = observer;
  }

  /** A member asks the User to sign in to (or reconnect) an MCP server its
   *  task needs (src/shared/connectorSignIn.ts). The call waits for the User
   *  as a permission card does. The sign-in address comes from the member's
   *  own CLI, and after "Done" the server is reconnected in the member's live
   *  process, so its tools are there for the rest of the same reply. The card
   *  stays open (its server card too) until what came of it is recorded. */
  async requestConnectorSignInFromTool(actor: ChatAppMcpActor, rawRequest: unknown, abandoned?: AbortSignal): Promise<Record<string, unknown>> {
    let input: { connector: string; reason?: string };
    try {
      input = parseConnectorSignInInput(rawRequest);
    } catch (error) {
      return { status: "error", message: (error instanceof Error ? error.message : String(error)) };
    }
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      return { status: "error", message: "The requesting member is no longer in this chat." };
    }
    if (requester.kind !== "claude-code") {
      return {
        status: "unsupported",
        message: "Signing in from the chat works for Claude Code members only. Tell the User which server needs signing in; they sign in through your CLI's own MCP settings."
      };
    }
    // The member's turn stopping, or its CLI giving up on this call.
    const runSignal = actor.runId ? this.chat.activeRuns.firstChatRunController(actor.runId)?.signal : undefined;
    const signals = [runSignal, abandoned].filter((item): item is AbortSignal => Boolean(item));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const control = (request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
      this.memberClaudeControl(actor.conversationId, actor.participantId, request, signal);
    const serverNow = async (name: string): Promise<McpServerStatus | undefined> =>
      parseMcpServerStatuses(await control({ subtype: "mcp_status" })).find((server) => server.name === name);
    const waitedCard = (chat: Conversation, connector: string): ChatAppToolApproval | undefined =>
      chatAppToolApprovals(chat).find((item) =>
        item.status === "pending" && item.toolName === APP_CONNECTOR_SIGN_IN_TOOL && item.requesterParticipantId === requester.id &&
        isConnectorSignInRequest(item.request) && item.request.connector === connector && (this.connectorSignInWaiters.get(item.id) ?? 0) > 0);

    let server: McpServerStatus;
    let auth: Record<string, unknown> = {};
    let joined: ChatAppToolApproval | undefined;
    try {
      const status = await control({ subtype: "mcp_status" });
      if (!status) {
        return { status: "unavailable", message: "This member has no live Claude Code process on this device to sign in from." };
      }
      const match = matchMcpServer(parseMcpServerStatuses(status), input.connector);
      if (match.kind === "ambiguous") {
        return { status: "ambiguous", message: `Several MCP servers match "${input.connector}"; call again with one of these names.`, names: match.names };
      }
      if (match.kind === "none") {
        return {
          status: "not_found",
          message: `Claude Code has no MCP server named "${input.connector}".`,
          ...(match.suggestions.length > 0 ? { similar: match.suggestions } : {})
        };
      }
      server = match.server;
      // Still connecting: given a moment, as the CLI's own list would show it settle.
      const pendingUntil = Date.now() + CONNECTOR_PENDING_WAIT_MS;
      while (server.status === "pending" && Date.now() < pendingUntil && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        server = await serverNow(server.name) ?? server;
      }
      if (server.status === "connected") {
        return { status: "connected", connector: server.name, message: "Already connected; its tools are available (find them with ToolSearch)." };
      }
      if (server.status === "disabled") {
        return { status: "disabled", connector: server.name, message: "The User turned this server off in Claude Code (/mcp). Ask them to turn it on if you need it." };
      }
      // Asked again while its card waits: the same card. Signing in again
      // would start a new sign-in and spoil the one the User may be in.
      joined = waitedCard((await this.deps.storage.getConversation(conversation.id)) ?? conversation, server.name);
      if (!joined && server.status === "needs-auth") {
        auth = await control({ subtype: "mcp_authenticate", serverName: server.name }) ?? {};
        const authUrl = typeof auth.authUrl === "string" ? auth.authUrl : undefined;
        if (authUrl && !connectorSignInHost(authUrl)) {
          return { status: "error", connector: server.name, message: "Claude Code returned a sign-in address the app does not open." };
        }
        if (!authUrl || auth.requiresUserAction === false) {
          // Signed in without the User (a saved session was renewed).
          return await reconnectConnectorForMember(control, serverNow, server.name);
        }
      }
    } catch (error) {
      return { status: "error", connector: input.connector, message: `Claude Code: ${(error instanceof Error ? error.message : String(error))}` };
    }

    const authUrl = typeof auth.authUrl === "string" ? auth.authUrl : undefined;
    const request: ChatConnectorSignInRequest = {
      kind: "connectorSignIn",
      connector: server.name,
      action: server.status === "needs-auth" ? "sign-in" : "reconnect",
      ...(authUrl ? { authUrl } : {}),
      // The CLI takes the browser's return itself, on its own computer.
      ...(authUrl && auth.callbackExpected === true ? { callbackOnMemberComputer: true } : {}),
      ...(input.reason ? { reason: input.reason } : {})
    };
    let approval: ChatAppToolApproval;
    this.connectorSignInWaiterAdd(joined?.id ?? "");
    let waitingOn = joined?.id ?? "";
    try {
      approval = joined ?? await this.chat.store.withChatMutation(conversation, async () => {
        const current = chatParticipants(conversation).find((participant) => participant.id === requester.id);
        if (!current) {
          throw new Error("The requesting member is no longer in this chat.");
        }
        const now = new Date().toISOString();
        const raced = waitedCard(conversation, request.connector);
        // Raised by another call meanwhile: that card, with this sign-in's
        // address, since the CLI's newest sign-in is the one that works.
        const next: ChatAppToolApproval = raced
          ? { ...raced, ...(authUrl ? { request: { ...(raced.request as ChatConnectorSignInRequest), ...request } } : {}), updatedAt: now }
          : newAppToolApproval(conversation, current, APP_CONNECTOR_SIGN_IN_TOOL, "permissions.request", request, connectorSignInSummary(current.handle, request), "pending");
        if (!raced) {
          // A card for this server no call here waits on is left from a call
          // that ended: closed, so only this one is open.
          for (const stale of chatAppToolApprovals(conversation)) {
            if (stale.status === "pending" && stale.toolName === APP_CONNECTOR_SIGN_IN_TOOL && stale.requesterParticipantId === current.id &&
              isConnectorSignInRequest(stale.request) && stale.request.connector === request.connector) {
              upsertAppToolApproval(conversation, { ...stale, status: "expired", error: CONNECTOR_SIGN_IN_ORPHANED, updatedAt: now });
            }
          }
          if (actor.runId && actor.triggerMessageId) {
            next.resumeContext = {
              runId: actor.runId,
              triggerMessageId: actor.triggerMessageId,
              participantRequestBatchId: actor.participantRequestBatchId
            };
          }
        }
        upsertAppToolApproval(conversation, next);
        conversation.updatedAt = now;
        // Waited on from before its save, so nothing takes it for a card left
        // by a call that ended.
        this.connectorSignInWaiterAdd(next.id);
        waitingOn = next.id;
        await this.chat.store.saveConversation(conversation);
        return next;
      });
    } catch (error) {
      this.connectorSignInWaiterRelease(waitingOn);
      return { status: "error", connector: request.connector, message: (error instanceof Error ? error.message : String(error)) };
    }
    void this.deps.debugLogs.write("chat.connector-sign-in.asked", {
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      runId: actor.runId,
      approvalId: approval.id,
      action: request.action,
      joined: Boolean(joined),
      authHost: connectorSignInHost(authUrl)
    });

    let decision: ToolPermissionDecision;
    try {
      decision = await this.chat.toolPermissions.waitForToolPermissionDecision(actor.conversationId, approval.id, actor.runId, abandoned);
    } finally {
      this.connectorSignInWaiterRelease(approval.id);
    }
    if (!decision.approve) {
      const latest = await this.deps.storage.getConversation(actor.conversationId);
      const stored = latest ? chatAppToolApprovals(latest).find((item) => item.id === approval.id) : undefined;
      if (decision.source === "user" && stored?.status === "denied") {
        return { status: "declined", connector: request.connector, message: "The User chose not to sign in now. Go on without it, or tell them what you need it for." };
      }
      // Another call still waits on the same card: it stays open for that one.
      if ((this.connectorSignInWaiters.get(approval.id) ?? 0) === 0) {
        await this.closePendingConnectorSignIn(actor.conversationId, approval.id, decision.reason ?? "The sign-in card was not answered.");
      }
      return { status: "expired", connector: request.connector, message: "The sign-in card closed without the User's answer." };
    }
    // Every call that waited on the card gets the same result: one reconnect.
    let reconnect = this.connectorSignInReconnects.get(approval.id);
    if (!reconnect) {
      reconnect = (async () => {
        const result = await reconnectConnectorForMember(control, serverNow, request.connector);
        if (result.status === "connected") {
          try {
            this.connectorSignedInObserver?.();
          } catch {
            // An observer never changes the sign-in.
          }
        }
        await this.recordConnectorSignInResult(actor.conversationId, approval.id, result);
        return result;
      })().finally(() => this.connectorSignInReconnects.delete(approval.id));
      this.connectorSignInReconnects.set(approval.id, reconnect);
    }
    return reconnect;
  }

  private connectorSignInWaiterAdd(approvalId: string): void {
    if (approvalId) this.connectorSignInWaiters.set(approvalId, (this.connectorSignInWaiters.get(approvalId) ?? 0) + 1);
  }

  private connectorSignInWaiterRelease(approvalId: string): void {
    const count = (this.connectorSignInWaiters.get(approvalId) ?? 0) - 1;
    if (count > 0) this.connectorSignInWaiters.set(approvalId, count);
    else this.connectorSignInWaiters.delete(approvalId);
  }

  /** The member's live Claude Code process answers one of its control requests. */
  private memberClaudeControl(conversationId: string, participantId: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeControl">>;
    return runner.memberClaudeControl
      ? runner.memberClaudeControl.call(this.deps.cliRunner, conversationId, participantId, request, CONNECTOR_CONTROL_TIMEOUT_MS, signal)
      : Promise.resolve(undefined);
  }

  /** What came of the User's "Done", on its card: the card (and its server
   *  card, which waits for this) closes with it. */
  private async recordConnectorSignInResult(conversationId: string, approvalId: string, result: Record<string, unknown>): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    await this.chat.store.saveChatChange(conversation, () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
      if (!approval) return;
      const now = new Date().toISOString();
      const { error: _previous, ...rest } = approval;
      upsertAppToolApproval(conversation, {
        ...rest,
        consumedAt: now,
        updatedAt: now,
        ...(result.status === "connected" ? {} : { error: typeof result.message === "string" ? result.message : "It is still not connected." })
      });
    }).catch((error) => {
      void this.deps.debugLogs.write("chat.connector-sign-in.record-error", { conversationId, approvalId, message: (error instanceof Error ? error.message : String(error)) });
    });
  }

  /** A sign-in card nobody answered (the member's turn stopped, or the wait ran out). */
  private async closePendingConnectorSignIn(conversationId: string, approvalId: string, reason: string): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    await this.chat.store.saveChatChange(conversation, () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
      if (!approval || approval.status !== "pending") return;
      upsertAppToolApproval(conversation, {
        ...approval,
        status: /stop|cancel/i.test(reason) ? "cancelled" : "expired",
        error: reason,
        updatedAt: new Date().toISOString()
      });
    }).catch(() => undefined);
  }

  /** The User's answer to a sign-in card: Done (approve) or Not now. The
   *  member's waiting call does the rest. A card no call waits on any more
   *  is closed instead, saying so. */
  async respondToConnectorSignInApproval(
    request: RespondToChatAppToolApprovalRequest,
    execution?: ChatApprovalExecutionGuard
  ): Promise<Conversation | undefined> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return conversation;
    }
    let decided: ChatAppToolApproval | undefined;
    await this.chat.store.withChatMutation(conversation, async () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === request.approvalId);
      if (!approval || approval.toolName !== APP_CONNECTOR_SIGN_IN_TOOL) {
        throw new Error("App tool approval request was not found.");
      }
      if (approval.status !== "pending") {
        throw new Error("App tool approval request has already been answered.");
      }
      await execution?.beforeApply(approval);
      const now = new Date().toISOString();
      decided = (this.connectorSignInWaiters.get(approval.id) ?? 0) > 0
        ? { ...approval, status: request.approve ? "approved" : "denied", updatedAt: now }
        : { ...approval, status: "expired", error: CONNECTOR_SIGN_IN_ORPHANED, updatedAt: now };
      upsertAppToolApproval(conversation, decided);
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
    });
    if (!decided) {
      throw new Error("App tool approval request could not be resolved.");
    }
    this.chat.toolPermissions.resolveToolPermissionApproval(request.approvalId, request.approve
      ? { approve: true, source: "user" }
      : { approve: false, source: "user", reason: "The User chose not to sign in now." });
    return conversation;
  }

  /** Sign-in cards of this device's members left by calls that ended: open
   *  ones no call waits on, and Done ones whose reconnect never finished (the
   *  app quit meanwhile). Both are closed, saying so, rather than shown as
   *  waiting forever. */
  expireOrphanedConnectorSignIns(conversation: Conversation): boolean {
    const owned = new Set(chatParticipants(conversation).filter((participant) => this.chat.host.ownsParticipant(participant)).map((participant) => participant.id));
    const now = new Date().toISOString();
    let changed = false;
    const nextApprovals = chatAppToolApprovals(conversation).map((approval) => {
      if (approval.toolName !== APP_CONNECTOR_SIGN_IN_TOOL || !owned.has(approval.requesterParticipantId) ||
        (approval.homeMachineId && approval.homeMachineId !== this.chat.host.hostMachineId)) {
        return approval;
      }
      if (approval.status === "pending" && !this.connectorSignInWaiters.has(approval.id)) {
        changed = true;
        return { ...approval, status: "expired" as const, error: CONNECTOR_SIGN_IN_ORPHANED, updatedAt: now };
      }
      if (approval.status === "approved" && !approval.consumedAt && !this.connectorSignInReconnects.has(approval.id)) {
        changed = true;
        return { ...approval, consumedAt: now, error: "The app closed before it could reconnect the server. Ask the member again if it is still needed.", updatedAt: now };
      }
      return approval;
    });
    if (changed) {
      conversation.metadata = { ...conversation.metadata, pendingAppToolApprovals: nextApprovals };
    }
    return changed;
  }
}
