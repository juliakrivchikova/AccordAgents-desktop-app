import { nextCronRun } from "../../../../shared/scriptSchedule";
import type { ChatScriptChangeRequest, ScriptSchedule } from "../../../../shared/scripts";
import type { ScriptRateState, ScriptRecord } from "../../scriptStore";
import { DAY_MS, HOUR_MS } from "../constants";

export function firstDueAt(schedule: ScriptSchedule, now: number): number {
  return schedule.kind === "interval" ? now : nextCronRun(schedule.expression, schedule.timeZone, now);
}

export function pruneRate(rate: ScriptRateState, now: number): void {
  rate.wakeups = rate.wakeups.filter((at) => now - Date.parse(at) < HOUR_MS);
  rate.posts = rate.posts.filter((at) => now - Date.parse(at) < HOUR_MS);
  for (const [key, entry] of Object.entries(rate.idempotency)) {
    if (now - Date.parse(entry.at) >= DAY_MS) delete rate.idempotency[key];
  }
}

// ---------------------------------------------------- proposal & approval

/** True when a script belongs to this chat: an agent may see and act on
 *  only the scripts of the chat it is in. */
export function belongsToChat(record: ScriptRecord, conversationId: string): boolean {
  return record.createdInChatId === conversationId || record.permissions.chatIds.includes(conversationId);
}

/** True when this proposal's files are already the approved ones: an
 *  approval that was applied but whose card could not be saved. */
export function alreadyApplied(record: ScriptRecord, request: ChatScriptChangeRequest): boolean {
  return (request.op === "create" || request.op === "update")
    && Boolean(request.revisionId)
    && record.appliedRevisionId === request.revisionId;
}
