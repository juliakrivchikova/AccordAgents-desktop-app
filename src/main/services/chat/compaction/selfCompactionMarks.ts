import { createHash } from "node:crypto";
import { isHubTurnRunId } from "../../../../shared/hubOps";
import type { ChatMessage, ChatSelfCompactionMark } from "../../../../shared/types";

/** The turn a member asked to compact its own context in: after that it is
 *  called again to go on with the work it stopped for it. Carried by the
 *  card it raised, or by the compaction's turn on the User's server. */
export interface SelfCompactionResume {
  /** The run that asked, as its own device names it. */
  runId: string;
  /** The message that run answered; none for a reply its CLI began on its own. */
  triggerMessageId?: string;
  /** The member request that run answered, when it did. */
  participantRequestBatchId?: string;
  /** When it was asked, or the User answered its card: what she stopped of
   *  the member's after that leaves its work to her. */
  since?: string;
  /** It said its work is done (app_chat_request_compaction `workDone`): no
   *  turn to go on in after the compaction. */
  workDone?: boolean;
}

const SELF_COMPACTION_MARK_ORDER: ReadonlyArray<ChatSelfCompactionMark["state"]> = ["card", "waiting", "ended", "resumed"];

/** The further of two copies of a reply's mark: an older copy of the reply
 *  (a runner's, another turn's) never takes it back. */
export function furthestSelfCompactionMark(stored: ChatSelfCompactionMark | undefined, current: ChatSelfCompactionMark | undefined): ChatSelfCompactionMark | undefined {
  if (!stored || !current) return stored ?? current;
  const further = SELF_COMPACTION_MARK_ORDER.indexOf(stored.state) - SELF_COMPACTION_MARK_ORDER.indexOf(current.state);
  if (further !== 0) return further > 0 ? stored : current;
  return current.reason && !stored.reason ? current : stored;
}

/** What a member's answer came to after its own compaction. */
export type SelfCompactedAnswer =
  | { kind: "went-on"; reply: ChatMessage }
  | { kind: "ended"; reason: NonNullable<ChatSelfCompactionMark["reason"]>; error?: string };

/** How a member's own compaction ended, for the turn it goes on in. */
export type SelfCompactionEnd = { kind: "completed" } | { kind: "declined" } | { kind: "failed"; reason?: string };

/** One run by the id its device and the User's server name it. */
export function runIdBase(runId: string): string {
  return runId.startsWith("turn-") ? runId.slice("turn-".length) : runId;
}

/** The run a member goes on in after the compaction it asked for in `runId`:
 *  one per asking run, named the same on every device. */
export function selfCompactionResumeRunId(runId: string): string {
  const named = `turn-compaction-resume-${runIdBase(runId)}`;
  return isHubTurnRunId(named) && named.length <= 120
    ? named
    : `turn-compaction-resume-${createHash("sha256").update(runIdBase(runId)).digest("hex").slice(0, 32)}`;
}

export function selfCompactionResumeFrom(value: unknown): SelfCompactionResume | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (item: unknown): string | undefined => typeof item === "string" && item.trim() ? item.trim() : undefined;
  const runId = text(record.runId);
  if (!runId) return undefined;
  const triggerMessageId = text(record.triggerMessageId);
  const participantRequestBatchId = text(record.participantRequestBatchId);
  const since = text(record.since);
  return {
    runId, ...(triggerMessageId ? { triggerMessageId } : {}), ...(participantRequestBatchId ? { participantRequestBatchId } : {}), ...(since ? { since } : {}),
    ...(record.workDone === true ? { workDone: true } : {})
  };
}
