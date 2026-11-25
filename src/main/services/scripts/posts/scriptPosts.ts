import { randomUUID } from "node:crypto";
import {
  SCRIPT_MAX_HELD_MESSAGES, SCRIPT_MAX_MESSAGES_PER_HOUR, SCRIPT_MAX_MESSAGES_PER_RUN, SCRIPT_MESSAGE_MAX_CHARS,
  type ScriptApiPostMessageRequest, type ScriptApiPostMessageResult
} from "../../../../shared/scripts";
import type { ScriptRecord } from "../../scriptStore";
import { DAY_MS, MAX_MENTIONS } from "../constants";
import { pruneRate } from "../records/scriptRules";
import { errorMessage, iso, redactScriptOutput } from "../scriptText";
import { type RunningScript, ScriptApiError, type ScriptChatInfo } from "../types";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** Messages a script posts into its chat. */
export class ScriptPosts {
  constructor(
    private readonly scripts: Pick<ScriptModules, "scriptHealth" | "scriptHost" | "scriptRecords" | "scriptRuns">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options">
  ) {}

  // ------------------------------------------------------------ script API

  /** `POST /script-api/messages` from a running script. */
  async postFromScript(context: { scriptId: string; runId: string }, body: unknown): Promise<ScriptApiPostMessageResult> {
    const run = this.scripts.scriptRuns.running.get(context.scriptId);
    if (!run || run.runId !== context.runId) throw new ScriptApiError(403, "This run has ended; its token is no longer valid.");
    const record = await this.deps.options.store.readRecord(context.scriptId);
    if (!record?.approvedHash) throw new ScriptApiError(403, "The script is not approved.");
    const request = (body ?? {}) as Partial<ScriptApiPostMessageRequest>;
    if (typeof request.chatId !== "string" || !record.permissions.chatIds.includes(request.chatId)) {
      throw new ScriptApiError(403, "This script may not post to that chat.");
    }
    if (typeof request.text !== "string" || !request.text.trim()) throw new ScriptApiError(400, "text is required.");
    if (request.text.length > SCRIPT_MESSAGE_MAX_CHARS) throw new ScriptApiError(400, `text is at most ${SCRIPT_MESSAGE_MAX_CHARS} characters.`);
    const mentions = request.mentions ?? [];
    if (!Array.isArray(mentions) || mentions.length > MAX_MENTIONS || mentions.some((item) => typeof item !== "string")) {
      throw new ScriptApiError(400, `mentions is a list of at most ${MAX_MENTIONS} member handles.`);
    }
    const idempotencyKey = request.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200)) {
      throw new ScriptApiError(400, "idempotencyKey is text of at most 200 characters.");
    }
    if (idempotencyKey) {
      const rate = await this.deps.options.store.readRate(context.scriptId);
      const previous = rate.idempotency[idempotencyKey];
      if (previous && this.deps.now() - Date.parse(previous.at) < DAY_MS) {
        return { ok: true, status: "duplicate", ...(previous.messageId ? { messageId: previous.messageId } : {}) };
      }
    }
    if (run.messagesSent + run.messagesInFlight >= SCRIPT_MAX_MESSAGES_PER_RUN) {
      throw new ScriptApiError(429, `A run may post at most ${SCRIPT_MAX_MESSAGES_PER_RUN} messages; batch what you found into one message.`);
    }
    // Counted before the first await, so concurrent posts cannot all pass.
    run.messagesInFlight += 1;
    try {
      const result = await this.postFromScriptAccepted(context, run, record, request as Partial<ScriptApiPostMessageRequest> & { chatId: string; text: string }, mentions as string[], idempotencyKey);
      if (result.status === "posted") run.messagesSent += 1;
      return result;
    } finally {
      run.messagesInFlight -= 1;
    }
  }

  private async postFromScriptAccepted(
    context: { scriptId: string; runId: string },
    run: RunningScript,
    record: ScriptRecord,
    request: Partial<ScriptApiPostMessageRequest> & { chatId: string; text: string },
    mentions: string[],
    idempotencyKey: string | undefined
  ): Promise<ScriptApiPostMessageResult> {
    const chat = await this.deps.options.chat.describeChat(request.chatId);
    if (!chat) throw new ScriptApiError(404, "That chat no longer exists.");
    if (chat.archived) throw new ScriptApiError(409, "That chat is archived.");
    const participantIds = this.resolveMentions(record, chat, mentions);
    // A key value never reaches a chat through the script's own message.
    const text = redactScriptOutput(request.text.trim(), run.secretValues);

    // Reserve under the lock; post outside it, so one slow chat save never
    // holds this script's queue (or the scheduler waiting on it).
    const reservation = await this.deps.options.store.withScript(context.scriptId, async () => {
      const now = this.deps.now();
      const rate = await this.deps.options.store.readRate(context.scriptId);
      pruneRate(rate, now);
      if (idempotencyKey && rate.idempotency[idempotencyKey]) {
        const previous = rate.idempotency[idempotencyKey]!;
        return { kind: "duplicate" as const, messageId: previous.messageId };
      }
      const overWakeups = participantIds.length > 0 && rate.wakeups.length >= record.permissions.maxWakeupsPerHour;
      const overMessages = rate.posts.length >= SCRIPT_MAX_MESSAGES_PER_HOUR;
      if (overWakeups || overMessages) {
        const held = await this.deps.options.store.readHeld(context.scriptId);
        if (held.length >= SCRIPT_MAX_HELD_MESSAGES) {
          return { kind: "full" as const };
        }
        held.push({ id: randomUUID(), chatId: chat.id, text, participantIds, createdAt: iso(now) });
        await this.deps.options.store.writeHeld(context.scriptId, held);
        if (idempotencyKey) rate.idempotency[idempotencyKey] = { status: "held", at: iso(now) };
        await this.deps.options.store.writeRate(context.scriptId, rate);
        return { kind: "held" as const, heldCount: held.length, first: held.length === 1, overWakeups };
      }
      rate.posts.push(iso(now));
      if (participantIds.length > 0) rate.wakeups.push(iso(now));
      if (idempotencyKey) rate.idempotency[idempotencyKey] = { status: "posting", at: iso(now) };
      await this.deps.options.store.writeRate(context.scriptId, rate);
      return { kind: "post" as const, at: iso(now) };
    });
    if (reservation.kind === "duplicate") {
      return { ok: true, status: "duplicate", ...(reservation.messageId ? { messageId: reservation.messageId } : {}) };
    }
    if (reservation.kind === "full") {
      throw new ScriptApiError(429, `${SCRIPT_MAX_HELD_MESSAGES} messages are already held for the User; nothing more is accepted until they are released or discarded.`);
    }
    if (reservation.kind === "held") {
      if (reservation.first) {
        void this.scripts.scriptHealth.notice(context.scriptId, reservation.overWakeups
          ? `Holding messages: it reached its limit of ${record.permissions.maxWakeupsPerHour} wake-ups per hour. Release or discard them in Settings → Scheduled Tasks.`
          : `Holding messages: it reached its limit of ${SCRIPT_MAX_MESSAGES_PER_HOUR} messages per hour. Release or discard them in Settings → Scheduled Tasks.`);
      }
      this.scripts.scriptHost.changed();
      return { ok: true, status: "held", heldCount: reservation.heldCount };
    }
    let posted: { messageId: string };
    try {
      posted = await this.deps.options.chat.postScriptMessage({
        conversationId: chat.id,
        scriptId: record.id,
        scriptName: record.name,
        content: text,
        participantIds
      });
    } catch (error) {
      // Undo the reservation, so a retry is not refused as a duplicate.
      await this.deps.options.store.withScript(context.scriptId, async () => {
        const rate = await this.deps.options.store.readRate(context.scriptId);
        rate.posts = rate.posts.filter((at) => at !== reservation.at);
        if (participantIds.length > 0) {
          const index = rate.wakeups.indexOf(reservation.at);
          if (index >= 0) rate.wakeups.splice(index, 1);
        }
        if (idempotencyKey) delete rate.idempotency[idempotencyKey];
        await this.deps.options.store.writeRate(context.scriptId, rate);
      }).catch(() => undefined);
      throw new ScriptApiError(409, errorMessage(error));
    }
    if (idempotencyKey) {
      await this.deps.options.store.withScript(context.scriptId, async () => {
        const rate = await this.deps.options.store.readRate(context.scriptId);
        rate.idempotency[idempotencyKey] = { messageId: posted.messageId, status: "posted", at: reservation.at };
        await this.deps.options.store.writeRate(context.scriptId, rate);
      }).catch(() => undefined);
    }
    return { ok: true, status: "posted", messageId: posted.messageId };
  }

  private resolveMentions(record: ScriptRecord, chat: ScriptChatInfo, mentions: readonly string[]): string[] {
    const ids: string[] = [];
    for (const raw of mentions) {
      const key = raw.trim().replace(/^@/, "").toLowerCase();
      const participant = chat.participants.find((item) => item.id === raw.trim() || item.handle.toLowerCase() === key);
      if (!participant) throw new ScriptApiError(403, `@${key} is not a member of that chat.`);
      if (!record.permissions.participantIds.includes(participant.id)) {
        throw new ScriptApiError(403, `This script may not mention @${participant.handle}.`);
      }
      if (this.deps.options.localMembersOnly && participant.runsHere === false) {
        throw new ScriptApiError(409, `@${participant.handle} no longer runs on ${this.scripts.scriptHost.hostPhrase()}, so this script cannot wake it.`);
      }
      if (!ids.includes(participant.id)) ids.push(participant.id);
    }
    return ids;
  }

  /** Post the held messages in order. Each leaves the held list only once it
   *  is posted; one that cannot be posted (its member left the chat) stays
   *  held, the rest still go out, and the failures are reported. */
  async releaseHeld(id: string): Promise<void> {
    const record = await this.scripts.scriptRecords.requireRecord(id);
    const held = await this.deps.options.store.readHeld(id);
    const failures: string[] = [];
    try {
      for (const item of held) {
        if (this.deps.now() - Date.parse(item.createdAt) >= DAY_MS) {
          await this.removeHeld(id, item.id);
          continue;
        }
        try {
          if (this.deps.options.localMembersOnly && item.participantIds.length > 0) {
            // Held while the member ran here; it may have moved since.
            const chat = await this.deps.options.chat.describeChat(item.chatId);
            const moved = item.participantIds
              .map((participantId) => chat?.participants.find((participant) => participant.id === participantId))
              .find((participant) => participant?.runsHere === false);
            if (moved) throw new Error(`@${moved.handle} no longer runs on ${this.scripts.scriptHost.hostPhrase()}`);
          }
          await this.deps.options.chat.postScriptMessage({
            conversationId: item.chatId,
            scriptId: id,
            scriptName: record.name,
            content: item.text,
            participantIds: item.participantIds
          });
        } catch (error) {
          failures.push(errorMessage(error));
          continue;
        }
        await this.removeHeld(id, item.id);
      }
    } finally {
      this.scripts.scriptHost.changed();
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} held ${failures.length === 1 ? "message" : "messages"} could not be posted and stay held: ${failures[0]}`);
    }
  }

  private async removeHeld(id: string, heldId: string): Promise<void> {
    await this.deps.options.store.withScript(id, async () => {
      const rows = await this.deps.options.store.readHeld(id);
      await this.deps.options.store.writeHeld(id, rows.filter((row) => row.id !== heldId));
    });
  }

  async discardHeld(id: string): Promise<void> {
    await this.scripts.scriptRecords.requireRecord(id);
    await this.deps.options.store.withScript(id, () => this.deps.options.store.writeHeld(id, []));
    this.scripts.scriptHost.changed();
  }
}
