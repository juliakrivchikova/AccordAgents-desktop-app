import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { newOpId } from "../../chatServerOps";
import type { ChatParticipant, Conversation } from "../../../../shared/types";
import { normalizeChatAgentPermissions, normalizeChatParticipantRequestPermission } from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { buildChatParticipantActivitySnapshot } from "../../../../shared/chatParticipantActivity";
import { isMainSessionParticipant } from "../../../../shared/mainSession";
import { participantForMentionHandle } from "../choices/mentions";
import { chatParticipants, participantForRun } from "../members/identity";
import { createChatMessage } from "../store/messages";
import { isMachineCompactionLine } from "../../../../shared/machineLink";
import {
  compactionAnchor, compactionFailureLine, compactMessageMetadata, machineCompactionFailureLine, normalizeCompactInstructions
} from "./compactionText";
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
  /** Members a compaction was asked for here and has not ended yet, by
   *  chat and member: asked again meanwhile (a retry, two calls at once), the
   *  tool says so instead of compacting twice. */
  private readonly compacting = new Set<string>();

  constructor(
    private readonly chat: Pick<ChatModules, "backgroundTasks" | "compaction" | "host" | "participantBatch" | "serverLink" | "serverTurns" | "store">,
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
    // Checked and taken with nothing awaited in between.
    const key = `${conversation.id}\u0000${target.id}`;
    if (this.compacting.has(key)) return refused("busy", `@${target.handle} is being compacted already.`);
    this.compacting.add(key);
    void this.deps.debugLogs.write("chat.member-compaction.requested", {
      conversationId: conversation.id, participantId: caller.id, targetParticipantId: target.id, machineRuntime: this.chat.host.machineRuntime
    });
    const done = () => { this.compacting.delete(key); };
    try {
      return this.chat.host.machineRuntime
        ? await this.compactThroughServer(conversation, caller, target, request.instructions, done)
        : await this.compactHere(conversation, caller, target, request.instructions, done);
    } catch (error) {
      done();
      throw error;
    }
  }

  /** The computer: as the User's Compact, with its status line and Stop. */
  private async compactHere(conversation: Conversation, caller: ChatParticipant, target: ChatParticipant, instructions: string, done: () => void): Promise<Record<string, unknown>> {
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
      done();
      // A compaction that failed once it held the member's turns, before it
      // ended (`end`, after which its own line is written), writes no line
      // of its own (the User's Compact shows the error where she pressed
      // it), so here the chat says it; one refused before that is the
      // tool's answer.
      if (result.kind === "threw" && wasQueued && !end && !stopped) await this.recordFailure(conversation.id, target, caller, runId, instructions, result.error);
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

  /**
   * A machine: a turn of the member on the User's server, taken by the device
   * it runs on (this one included), as a member's own compaction on a machine
   * is (SelfCompaction.requestServerSelfCompaction). The tool answers once
   * that device took it (its turns are held from then, ServerTurns), and the
   * compaction is followed to its end: one that never ran there, or that the
   * server refused after the tool answered, leaves the line a compaction
   * here would (compactParticipantOnMachine).
   */
  private async compactThroughServer(
    conversation: Conversation, caller: ChatParticipant, target: ChatParticipant, instructions: string, done: () => void
  ): Promise<Record<string, unknown>> {
    const link = this.chat.serverLink.current;
    if (!link) {
      done();
      return refused("failed", "This machine is not linked to your server.");
    }
    const anchor = compactionAnchor(conversation, {});
    if (!anchor) {
      done();
      return refused("failed", "Nothing in this chat has reached your server yet.");
    }
    const runId = `turn-${randomUUID()}`;
    const opId = newOpId();
    await link.enqueue([{
      opId, kind: "turn.request", conversationId: conversation.id, runId, messageId: anchor.id, participantId: target.id,
      request: { kind: "compaction", triggeredBy: "agent", instructions, requestedByParticipantId: caller.id }
    }]);
    let toolAnswered = false;
    let tell: (answer: Record<string, unknown>) => void = () => undefined;
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      tell = (value) => { if (!toolAnswered) { toolAnswered = true; resolve(value); } };
    });
    // What the tool no longer says is said in the chat.
    const failed = async (reason: string, line: string): Promise<void> => {
      if (!toolAnswered) return tell(refused("failed", reason));
      await this.writeLine(conversation.id, target, caller, runId, instructions, line);
    };
    void (async () => {
      const accepted = await link.opAnswered(opId).catch((error: unknown) => ({ status: "rejected" as const, reason: error instanceof Error ? error.message : String(error) }));
      if (accepted.status === "rejected") {
        if (!toolAnswered) return tell(refused("rejected", accepted.reason));
        return this.writeLine(conversation.id, target, caller, runId, instructions, compactionFailureLine(target.handle, accepted.reason));
      }
      const placed = await this.chat.serverTurns.waitForServerTurn(runId, (turn) => turn.state !== "requested");
      tell(started(target, runId));
      const ended = placed.state === "finished" || placed.state === "stopped"
        ? placed
        : await this.chat.serverTurns.waitForServerTurn(runId, (turn) => turn.state === "finished" || turn.state === "stopped");
      // The line of the device that ran it came through the server before
      // the turn's end did.
      const latest = await this.chat.store.requireChat(conversation.id).catch(() => undefined);
      if (!latest || latest.messages.some((message) => isMachineCompactionLine(message, runId, target.id))) return;
      const stoppedBeforeStart = ended.state === "stopped" && !ended.executorDeviceId;
      await failed(stoppedBeforeStart ? "It was stopped before it started." : "The device it runs on ended it without saying how it went.",
        machineCompactionFailureLine(target.handle, stoppedBeforeStart ? "interrupted" : "failed",
          stoppedBeforeStart ? undefined : "the device it runs on ended the compaction without saying how it went"));
    })().catch(async (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      void this.deps.debugLogs.write("chat.member-compaction.follow-error", { conversationId: conversation.id, runId, message: reason });
      await failed(reason, compactionFailureLine(target.handle, reason)).catch(() => undefined);
    }).finally(done);
    const waited = await Promise.race([answer, delay(SERVER_ANSWER_WAIT_MS, undefined, { ref: false }).then(() => undefined)]);
    if (waited) return waited;
    tell({});
    return {
      ok: true,
      status: "queued",
      runId,
      target: `@${target.handle}`,
      next: `The device @${target.handle} runs on has not taken it yet; it is compacted once that device does, and the chat shows a line then. Do not wait or poll for it.`
    };
  }

  private recordFailure(conversationId: string, target: ChatParticipant, caller: ChatParticipant, runId: string, instructions: string, error: string): Promise<void> {
    return this.writeLine(conversationId, target, caller, runId, instructions, compactionFailureLine(target.handle, error));
  }

  private async writeLine(conversationId: string, target: ChatParticipant, caller: ChatParticipant, runId: string, instructions: string, line: string): Promise<void> {
    const latest = await this.chat.store.requireChat(conversationId).catch(() => undefined);
    if (!latest) return;
    await this.chat.store.withChatMutation(latest, async () => {
      latest.messages.push(createChatMessage("system", line, undefined,
        compactMessageMetadata({ runId, triggeredBy: "agent", instructions, requestedByParticipantId: caller.id }, target, "failed")));
      latest.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(latest);
      this.chat.store.queueSnapshot(latest);
    });
  }
}

function memberCompactionRequest(value: unknown): { target: string; instructions: string } {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as { target?: unknown; participant?: unknown; handle?: unknown; instructions?: unknown } : {};
  // A member named as the other member tools name it (seen live: a main
  // session that guessed `participant` before it read the schema).
  const named = [record.target, record.participant, record.handle].find((item) => typeof item === "string" && item.trim());
  const target = typeof named === "string" ? named.trim().replace(/^@/, "") : "";
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
