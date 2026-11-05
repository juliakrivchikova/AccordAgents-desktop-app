import type { ReviewProgress } from "./types";

/** The request kind of a member's restart turn on the User's server. */
export const MEMBER_RESTART_TURN_KIND = "restart";

/** A restart asked longer ago than this is not run any more: background work
 *  the member started since was never part of what the User agreed to stop. */
export const MEMBER_RESTART_TURN_TTL_MS = 10 * 60_000;

/** What a machine's last hello says about restarting its members. */
export type MachineMemberRestartSupport = "supported" | "outdated" | "disconnected" | "unknown";

/** The restart turn's request, as the desktop asks it of a machine. */
export interface MemberRestartTurnRequest {
  kind: typeof MEMBER_RESTART_TURN_KIND;
  /** The User agreed to stop the member's background tasks. */
  stopBackgroundTasks?: boolean;
  /** When the desktop asked (its clock), for MEMBER_RESTART_TURN_TTL_MS. */
  askedAt: string;
}

export function isMemberRestartTurnRequest(request: Record<string, unknown> | undefined): boolean {
  return request?.kind === MEMBER_RESTART_TURN_KIND;
}

/** The chat line a member's restart writes, on the device that runs it. */
export function memberRestartLine(handle: string, backgroundTasks: number): string {
  const stopped = backgroundTasks > 0
    ? ` and stopped its ${backgroundTasks === 1 ? "background task" : `${backgroundTasks} background tasks`}`
    : "";
  return `Restarted @${handle}${stopped}. Its next reply picks up the current connectors and settings.`;
}

export interface MemberRestartInProgress {
  runId: string;
  /** Its latest word ("Restarting @x." or "… Waiting for machine Box"). */
  message: string;
  /** It is in its machine's hands (asked, waiting, running there): the
   *  User can stop waiting for it. */
  waiting: boolean;
}

/** Each member whose restart has not ended yet, from the runs' progress. */
export function restartingMembers(progress: readonly ReviewProgress[]): ReadonlyMap<string, MemberRestartInProgress> {
  const latest = new Map<string, ReviewProgress>();
  for (const item of progress) {
    if (item.memberRestart) latest.set(item.memberRestart.participantId, item);
  }
  const restarting = new Map<string, MemberRestartInProgress>();
  for (const [participantId, item] of latest) {
    if (item.phase === "initial") {
      restarting.set(participantId, { runId: item.runId, message: item.message, waiting: item.memberRestart?.waiting === true });
    }
  }
  return restarting;
}
