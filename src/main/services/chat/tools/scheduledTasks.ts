import { randomUUID } from "node:crypto";
import type { ChatAgentPermissions, ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import {
  effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { APP_SCRIPTS_LIST_TOOL, APP_SCRIPTS_READ_RUNS_TOOL, APP_SCRIPTS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import type { ChatScriptChangeRequest, ScriptRunRow } from "../../../../shared/scripts";
import type { ProposeScriptChangeInput, ProposeScriptChangeResult, ScriptChatInfo } from "../../scripts";
import { chatAppToolApprovals, isScriptChangeRequest, newAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import { assertParticipantProvidersEnabled, chatParticipants, participantForRun } from "../members/identity";
import { createChatMessage } from "../store/messages";
import { emitChatRunFailure } from "../turns/replyMessages";
import type { ChatAppMcpActor, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** The scheduled-scripts service on this host, as the chat side uses it. */
export interface ChatScriptHost {
  proposeChange(input: ProposeScriptChangeInput): Promise<ProposeScriptChangeResult>;
  attachApproval(scriptId: string, approvalId: string, revisionId: string | undefined): Promise<void>;
  assertApprovable(request: ChatScriptChangeRequest): Promise<void>;
  applyApproved(request: ChatScriptChangeRequest): Promise<string>;
  rejectPending(request: ChatScriptChangeRequest): Promise<void>;
  /** Scripts of this chat only. */
  listForAgent(conversationId: string): Promise<Array<Record<string, unknown>>>;
  /** Refuses a script of another chat when conversationId is given. */
  runs(id: string, conversationId?: string, limit?: number): Promise<ScriptRunRow[]>;
}

/** Members' scheduled tasks: created from a turn, and their messages in the chat. */
export class ScheduledTasks {
  scriptHost?: ChatScriptHost;

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "host" | "participantBatch" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "settings" | "storage">
  ) {}

  /** Scheduled scripts on this host; absent where they are not available. */
  setScriptHost(host: ChatScriptHost | undefined): void {
    this.scriptHost = host;
  }

  /** `app_scripts_*` tools. */
  async scriptToolFromApp(actor: ChatAppMcpActor, toolName: string, rawRequest: unknown): Promise<Record<string, unknown>> {
    const host = this.scriptHost;
    if (!host) {
      throw new Error("Scheduled tasks are not available on this host yet.");
    }
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    this.chat.host.assertOwnsParticipant(requester);
    if (toolName === APP_SCRIPTS_LIST_TOOL) {
      return { ok: true, scripts: await host.listForAgent(conversation.id) };
    }
    if (toolName === APP_SCRIPTS_READ_RUNS_TOOL) {
      const request = (rawRequest ?? {}) as { scriptId?: unknown; limit?: unknown };
      const limit = typeof request.limit === "number" && Number.isInteger(request.limit) ? request.limit : 20;
      const runs = await host.runs(String(request.scriptId ?? ""), conversation.id, limit);
      return { ok: true, scriptId: request.scriptId, runs };
    }
    if (toolName !== APP_SCRIPTS_REQUEST_CHANGE_TOOL) {
      throw new Error(`Unknown app tool: ${toolName}`);
    }
    const proposal = await host.proposeChange({
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      requesterLabel: `@${requester.handle}`,
      request: rawRequest
    });
    if (proposal.kind === "ran") {
      return { ok: true, status: "started", scriptId: proposal.scriptId, summary: `Started "${proposal.name}" once.` };
    }
    // Creating a task, with leave to do it without a card (Settings → General
    // → New chats): installed and switched on now. One that needs keys waits
    // for the User, who enters them on its card; so does any other change.
    if (proposal.request.op === "create" && proposal.missingSecretNames.length === 0 && await this.createsScheduledTasksWithoutCard(conversation, requester)) {
      return this.createScheduledTaskWithoutCard(host, conversation, requester, proposal.request);
    }
    let approval!: ChatAppToolApproval;
    try {
      await this.chat.store.withChatMutation(conversation, async () => {
        approval = newAppToolApproval(
          conversation,
          requester,
          APP_SCRIPTS_REQUEST_CHANGE_TOOL,
          "scripts.request",
          proposal.request,
          proposal.summary,
          "pending"
        );
        upsertAppToolApproval(conversation, approval);
        // An older card for the same script is replaced by this proposal.
        for (const older of chatAppToolApprovals(conversation)) {
          if (
            older.id !== approval.id &&
            older.status === "pending" &&
            older.toolName === APP_SCRIPTS_REQUEST_CHANGE_TOOL &&
            isScriptChangeRequest(older.request) &&
            older.request.scriptId === proposal.request.scriptId &&
            (older.request.op === "create" || older.request.op === "update")
          ) {
            upsertAppToolApproval(conversation, { ...older, status: "cancelled", error: "Replaced by a newer proposal.", updatedAt: new Date().toISOString() });
          }
        }
        conversation.messages.push(createChatMessage("system", `Scheduled task approval needed from @${requester.handle}: ${proposal.summary}.`, undefined, {
          threadId: "system"
        }));
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
    } catch (error) {
      await host.rejectPending(proposal.request).catch(() => undefined);
      throw error;
    }
    await host.attachApproval(proposal.request.scriptId, approval.id, proposal.request.revisionId);
    return {
      ok: true,
      status: "pending_user_approval",
      approvalId: approval.id,
      scriptId: proposal.request.scriptId,
      summary: proposal.summary,
      ...(proposal.missingSecretNames.length > 0 ? { keysTheUserMustEnter: proposal.missingSecretNames } : {})
    };
  }

  /** Whether a member creates scheduled tasks without a card: its right as it
   *  runs now (a member another member added: never above the main session's;
   *  none in Plan, which changes nothing), while the User's switch is on:
   *  turned off, every chat asks again. */
  private async createsScheduledTasksWithoutCard(conversation: Conversation, member: ChatParticipant): Promise<boolean> {
    const running = participantForRun(conversation, member);
    const permissions = effectiveChatAgentPermissionsForProvider(
      running.kind, normalizeChatAgentMode(running.agentMode), normalizeChatAgentPermissions(running.permissions)
    );
    return permissions.scheduleWithoutAsking === true && await this.scheduledTasksWithoutAskingOn();
  }

  /** A member's rights as it is told them: scheduled tasks without a card
   *  only while the User's switch is on. */
  async withSchedulingWhileOn(permissions: ChatAgentPermissions): Promise<ChatAgentPermissions> {
    const { scheduleWithoutAsking, ...rest } = permissions;
    return scheduleWithoutAsking && !await this.scheduledTasksWithoutAskingOn() ? rest : permissions;
  }

  /** Settings → General → New chats → Create scheduled tasks without asking,
   *  as it is now (a machine: as the computer that set it up published it). */
  private async scheduledTasksWithoutAskingOn(): Promise<boolean> {
    return (await this.deps.settings.getPublicSettings()).newChatDefaults?.scheduleWithoutAsking === true;
  }

  private async createScheduledTaskWithoutCard(
    host: ChatScriptHost,
    conversation: Conversation,
    requester: ChatParticipant,
    request: ChatScriptChangeRequest
  ): Promise<Record<string, unknown>> {
    let summary: string;
    let approval!: ChatAppToolApproval;
    try {
      summary = await host.applyApproved(request);
      await this.chat.store.withChatMutation(conversation, async () => {
        approval = newAppToolApproval(conversation, requester, APP_SCRIPTS_REQUEST_CHANGE_TOOL, "scripts.request", request, summary, "auto-applied");
        // A machine's card reaches the User's other devices through her
        // server only while it stands there: raised and answered by this
        // machine itself (nobody is asked), then settled below.
        if (this.chat.host.machineRuntime) approval.taskCreatedAt = approval.createdAt;
        upsertAppToolApproval(conversation, approval);
        conversation.messages.push(createChatMessage("system", summary, undefined, { threadId: "system" }));
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
    } catch (error) {
      // Never a task that runs with nothing in the chat about it.
      await host.rejectPending(request).catch(() => undefined);
      throw error;
    }
    if (approval.taskCreatedAt) {
      await this.chat.store.saveChatChange(conversation, () => {
        const current = chatAppToolApprovals(conversation).find((item) => item.id === approval.id) ?? approval;
        const { taskCreatedAt: _raised, ...settled } = current;
        upsertAppToolApproval(conversation, settled);
      });
    }
    void this.deps.debugLogs.write("chat.scheduled-task.created-without-card", { conversationId: conversation.id, participantId: requester.id, scriptId: request.scriptId });
    return { ok: true, status: "created", approvalId: approval.id, scriptId: request.scriptId, summary };
  }

  /** For the script service: a chat's title and members, by id. */
  async describeChatForScripts(chatId: string): Promise<ScriptChatInfo | undefined> {
    // The snapshot this process last saved, when it has one: reading the
    // whole chat (every message row) only for its title and roster would cost
    // a full read on every script post. postScriptMessage re-checks the
    // roster against storage under the chat lock anyway.
    const conversation = this.chat.store.lastSavedSnapshots.get(chatId)?.snapshot ?? await this.deps.storage.getConversation(chatId);
    if (!conversation || conversation.kind !== "chat") {
      return undefined;
    }
    return {
      id: conversation.id,
      title: conversation.title,
      archived: conversation.metadata.archived === true,
      participants: chatParticipants(conversation).map((participant) => ({
        id: participant.id,
        handle: participant.handle,
        runsHere: this.chat.host.ownsParticipant(participant)
      }))
    };
  }

  /** A scheduled script posts into a chat: the message is authored by the
   *  script (role "script") and starts exactly the members it names, the
   *  way a User message with those mentions does. Each target run gets its
   *  own run id, so Stop works per member as usual. */
  async postScriptMessage(input: {
    conversationId: string;
    scriptId: string;
    scriptName: string;
    content: string;
    participantIds: string[];
    progress?: ProgressCallback;
  }): Promise<{ messageId: string; runIds: string[] }> {
    const warnings: string[] = [];
    const ingest = await this.chat.activeRuns.withChatRunLock(input.conversationId, async () => {
      const conversation = await this.chat.store.requireChat(input.conversationId);
      let prepared!: { conversation: Conversation; targets: ChatParticipant[]; message: ChatMessage };
      await this.chat.store.withChatMutation(conversation, async () => {
        if (conversation.metadata.archived === true) {
          throw new Error("That chat is archived.");
        }
        const participants = chatParticipants(conversation);
        const targets = input.participantIds.map((id) => participants.find((participant) => participant.id === id));
        if (targets.some((target) => !target)) {
          throw new Error("A member the script mentions is no longer in this chat.");
        }
        if (targets.length > 0) {
          const settings = await this.deps.settings.getPublicSettings();
          assertParticipantProvidersEnabled(targets as ChatParticipant[], settings.providers ?? []);
        }
        const message = createChatMessage("script", input.content, undefined, {
          appMessageSource: "script",
          scriptId: input.scriptId,
          scriptName: input.scriptName
        });
        message.participantLabel = input.scriptName;
        // Each wake-up starts its own thread, so one alert burst and the
        // investigation it starts stay together.
        message.metadata = {
          ...message.metadata,
          threadId: message.id,
          // Whom it wakes, as a User's message records its addressees: the
          // sessions view puts a wake-up of a member into that member's
          // session (shared/mainSession.ts).
          ...(targets.length > 0 ? { askedParticipantIds: (targets as ChatParticipant[]).map((target) => target.id) } : {})
        };
        conversation.messages.push(message);
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
        prepared = { conversation, targets: targets as ChatParticipant[], message };
      });
      return prepared;
    });
    if (ingest.targets.length === 0) {
      return { messageId: ingest.message.id, runIds: [] };
    }
    const targetRunIds = new Map(ingest.targets.map((target) => [target.id, randomUUID()] as const));
    const batchRunId = targetRunIds.get(ingest.targets[0]!.id)!;
    void this.chat.participantBatch.runParticipantBatch(
      ingest.conversation,
      ingest.targets,
      ingest.message,
      batchRunId,
      undefined,
      input.progress,
      warnings,
      { targetRunIds }
    ).catch((error) => {
      emitChatRunFailure(batchRunId, input.progress, error);
    });
    return { messageId: ingest.message.id, runIds: [...targetRunIds.values()] };
  }
}
