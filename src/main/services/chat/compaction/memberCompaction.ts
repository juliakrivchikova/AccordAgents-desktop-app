import { randomUUID } from "node:crypto";
import { newOpId } from "../../chatServerOps";
import type { ChatParticipant, Conversation } from "../../../../shared/types";
import { normalizeChatAgentPermissions, normalizeChatParticipantRequestPermission } from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { buildChatParticipantActivitySnapshot } from "../../../../shared/chatParticipantActivity";
import { isMainSessionParticipant } from "../../../../shared/mainSession";
import { participantForMentionHandle } from "../choices/mentions";
import { chatParticipants, participantForRun } from "../members/identity";
import { createChatMessage } from "../store/messages";
import { compactionAnchor, compactionFailureLine, compactMessageMetadata, normalizeCompactInstructions } from "./compactionText";
import type { SelfCompactionEnd } from "./selfCompactionMarks";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** How long the tool waits for the User's server to take a machine's
 *  compaction of a member before it answers that the server has not yet. */
const SERVER_ANSWER_WAIT_MS = 20_000;

/** Statuses of a member that is not doing anything now. */
const IDLE_STATUSES = new Set(["idle", "stopped", "error"]);

/**
 * The chat's main session compacts another member (`app_chat_compact_participant`;
 * the User, 2026-11-26), as she would with `@x /compact <instructions>`: only
 * while its own compaction right is allow (Settings → General → New chats →
 * Compact without asking). On this computer the compaction runs as hers does,
 * here or on the member's machine; on a machine it is a turn of that member on
 * the User's server, which the device the member runs on takes, as a member's
 * own compaction there is. The tool answers once the compaction holds the
 * member's turns, so the work the main session gives it next runs after it.
 */
export class MemberCompaction {
  constructor(
    private readonly chat: Pick<ChatModules, "backgroundTasks" | "compaction" | "host" | "participantBatch" | "serverLink" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress">
  ) {}

  async compactParticipantFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const members = chatParticipants(conversation);
    const caller = members.find((participant) => participant.id === actor.participantId);
    if (!caller) return refused("rejected", "The requesting member is no longer in this chat.");
    if (!hasChatAppToolCapability(actor.capabilities, "participants.compact") || !isMainSessionParticipant(conversation.metadata, caller.id)) {
      return refused("rejected", "Only the chat's main session compacts other members.");
    }
    const right = normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(participantForRun(conversation, caller).permissions).requestCompaction);
    if (right !== "allow") {
      return refused("rejected", "You compact other members only while you compact without asking (Settings → General → New chats → Compact without asking).");
    }
    let request: { target: string; instructions: string };
    try {
      request = memberCompactionRequest(rawRequest);
    } catch (error) {
      return refused("invalid_request", error instanceof Error ? error.message : String(error));
    }
    const target = participantForMentionHandle(members, request.target);
    if (!target) return refused("not_found", `There is no member @${request.target} in this chat.`);
    if (target.id === caller.id) return refused("rejected", "Your own context is compacted with app_chat_request_compaction.");
    const activity = buildChatParticipantActivitySnapshot(conversation, undefined,
      new Map(Object.entries(this.chat.backgroundTasks.backgroundTasksForConversation(conversation.id))))
      .participants.find((entry) => entry.participantId === target.id);
    if (activity && !IDLE_STATUSES.has(activity.status)) {
      return refused("busy", `@${target.handle} is ${activity.status} now: compact it once it is idle.`);
    }
    if (!activity?.lastTurnEndedAt) {
      return refused("no_active_session", `@${target.handle} has not worked in this chat yet: there is nothing to compact.`);
    }
    void this.deps.debugLogs.write("chat.member-compaction.requested", {
      conversationId: conversation.id, participantId: caller.id, targetParticipantId: target.id, machineRuntime: this.chat.host.machineRuntime
    });
    return this.chat.host.machineRuntime
      ? this.compactThroughServer(conversation, caller, target, request.instructions)
      : this.compactHere(conversation, caller, target, request.instructions);
  }

  /** The computer: as the User's Compact, with its status line and Stop. */
  private async compactHere(conversation: Conversation, caller: ChatParticipant, target: ChatParticipant, instructions: string): Promise<Record<string, unknown>> {
    const runId = randomUUID();
    const run = this.chat.participantBatch.registerBackgroundRunController(runId, undefined);
    let wasQueued = false;
    let markQueued: () => void = () => undefined;
    const queued = new Promise<"queued">((resolve) => { markQueued = () => { wasQueued = true; resolve("queued"); }; });
    let end: SelfCompactionEnd | undefined;
    const compacting = this.chat.compaction.compactParticipant({
      conversationId: conversation.id,
      participantId: target.id,
      handle: target.handle,
      instructions,
      triggeredBy: "agent",
      requestedByParticipantId: caller.id,
      runId
    }, run.signal, this.deps.onReviewProgress, (ended) => { end = ended; }, markQueued);
    const ended = compacting.then(
      () => ({ kind: "ended" as const }),
      (error: unknown) => ({ kind: "threw" as const, error: error instanceof Error ? error.message : String(error) })
    );
    void ended.then(async (result) => {
      const stopped = run.signal.aborted;
      run.cleanup();
      // A compaction that failed once it held the member's turns writes no
      // line of its own (the User's Compact shows the error where she
      // pressed it), so here the chat says it; one refused before that is
      // the tool's answer.
      if (result.kind === "threw" && wasQueued && !stopped) await this.recordFailure(conversation.id, target, caller, runId, instructions, result.error);
    });
    const first = await Promise.race([queued, ended]);
    if (first !== "queued") {
      if (first.kind === "threw") return refused("failed", first.error);
      const reason = end?.kind === "failed" ? end.reason : undefined;
      if (reason === "no active session") return refused("no_active_session", `@${target.handle} does not have an active session to compact yet.`);
      if (reason) return refused("failed", reason);
    }
    return started(target, runId);
  }

  /** A machine: a turn of the member on the User's server, taken by the
   *  device it runs on (this one included), as a member's own compaction on
   *  a machine is (SelfCompaction.requestServerSelfCompaction). */
  private async compactThroughServer(conversation: Conversation, caller: ChatParticipant, target: ChatParticipant, instructions: string): Promise<Record<string, unknown>> {
    const link = this.chat.serverLink.current;
    if (!link) return refused("failed", "This machine is not linked to your server.");
    const anchor = compactionAnchor(conversation, {});
    if (!anchor) return refused("failed", "Nothing in this chat has reached your server yet.");
    const runId = `turn-${randomUUID()}`;
    const opId = newOpId();
    await link.enqueue([{
      opId, kind: "turn.request", conversationId: conversation.id, runId, messageId: anchor.id, participantId: target.id,
      request: { kind: "compaction", triggeredBy: "agent", instructions, requestedByParticipantId: caller.id }
    }]);
    const answer = await link.opAnswered(opId, AbortSignal.timeout(SERVER_ANSWER_WAIT_MS)).catch(() => undefined);
    if (!answer) {
      return {
        ok: true,
        status: "queued",
        runId,
        target: `@${target.handle}`,
        next: `Your server has not taken it yet; @${target.handle} is compacted once it does, before a request you give it afterwards. Do not wait or poll for it.`
      };
    }
    if (answer.status === "rejected") return refused("rejected", answer.reason);
    return started(target, runId);
  }

  private async recordFailure(conversationId: string, target: ChatParticipant, caller: ChatParticipant, runId: string, instructions: string, error: string): Promise<void> {
    const latest = await this.chat.store.requireChat(conversationId).catch(() => undefined);
    if (!latest) return;
    await this.chat.store.withChatMutation(latest, async () => {
      latest.messages.push(createChatMessage("system", compactionFailureLine(target.handle, error), undefined,
        compactMessageMetadata({ runId, triggeredBy: "agent", instructions, requestedByParticipantId: caller.id }, target.id, "failed")));
      latest.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(latest);
      this.chat.store.queueSnapshot(latest);
    });
  }
}

function memberCompactionRequest(value: unknown): { target: string; instructions: string } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as { target?: unknown; instructions?: unknown } : {};
  const target = typeof record.target === "string" ? record.target.trim().replace(/^@/, "") : "";
  if (!target) throw new Error("target is required: the member's handle.");
  const instructions = normalizeCompactInstructions(typeof record.instructions === "string" ? record.instructions : undefined);
  if (!instructions) throw new Error("instructions are required: what the summary must keep for that member's next work.");
  return { target, instructions };
}

function refused(status: string, error: string): Record<string, unknown> {
  return { ok: false, status, error };
}

function started(target: ChatParticipant, runId: string): Record<string, unknown> {
  return {
    ok: true,
    status: "started",
    runId,
    target: `@${target.handle}`,
    next: `@${target.handle} is being compacted; a request you give it now runs after the compaction. The chat shows a line when it is done: do not wait or poll for it.`
  };
}
