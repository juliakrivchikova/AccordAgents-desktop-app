import type { DeviceEventBlobReference } from "./deviceEventBlobs";
import type { ChatParticipant, ChatParticipantSession } from "./types";

/**
 * Moving a member between this computer and a cloud machine with its CLI
 * session (a Claude Code member only: its transcript resumes on another
 * computer, checked on the User's machine on 2026-11-07).
 *
 * Everything travels through the User's server: the device the member leaves
 * puts its session there as a body, the member's `sessionHandoff` names it,
 * and the device the member arrives on takes it before the member's next turn
 * there. Leaving a machine is a turn of the member on the server (request
 * kind `session.export`), so a stopped machine is started for it as for any
 * turn.
 */

/** The request kind of the turn that asks a machine for a member's session. */
export const MEMBER_SESSION_EXPORT_TURN_KIND = "session.export";

/** An export asked longer ago than this is not run any more: the User was
 *  told the move failed, and a late one would hold the member's turns. */
export const MEMBER_SESSION_EXPORT_TURN_TTL_MS = 10 * 60_000;

/** After a machine hands a member's session over, it leaves the member's
 *  turns waiting this long for the computer to make the move: a reply it ran
 *  meanwhile would be missing from the session that moved. */
export const MEMBER_SESSION_EXPORT_HOLD_MS = 3 * 60_000;

export interface MemberSessionExportTurnRequest {
  kind: typeof MEMBER_SESSION_EXPORT_TURN_KIND;
  /** When the desktop asked (its clock), for MEMBER_SESSION_EXPORT_TURN_TTL_MS. */
  askedAt: string;
}

export function isMemberSessionExportTurnRequest(request: Record<string, unknown> | undefined): boolean {
  return request?.kind === MEMBER_SESSION_EXPORT_TURN_KIND;
}

/** What a member's `sessionHandoff` says: its session, put on the User's
 *  server by the device it left, for the device it runs on now to take. */
export interface ChatSessionHandoff {
  provider: "claude-code";
  /** The CLI's own session id (what `--resume` takes). */
  sessionId: string;
  /** The packed session on the User's server (see packMemberSession). */
  blob: DeviceEventBlobReference;
  /** When it was handed over (the moving desktop's clock). */
  at: string;
}

/** What a machine's export turn reports, on a hidden line of the chat. */
export interface MemberSessionExportReport {
  runId: string;
  participantId: string;
  /** No session there yet: the member just moves. */
  none?: boolean;
  sessionId?: string;
  blob?: DeviceEventBlobReference;
  error?: string;
}

/** What the session a member's handoff carries holds besides the transcript:
 *  the app's own record of it, as the device it left had it. */
export type PortableMemberSession = Omit<ChatParticipantSession, "remoteSession" | "invalidatedRemoteSessionId" | "invalidatedRemoteSessionAt" | "importedHandoff">;

/** Only a Claude Code member on its own sign-in moves with its session; a
 *  member through an added provider stays where it first ran. */
export function memberSessionMoves(participant: Pick<ChatParticipant, "kind" | "hostId">): boolean {
  return participant.kind === "claude-code" && !participant.hostId;
}

/** What a machine's last hello says about moving members' sessions. */
export type MachineSessionMoveSupport = "supported" | "outdated" | "unknown";

/** The line the chat shows once a member moved. */
export function memberMovedLine(handle: string, destination: string, withSession: boolean): string {
  return withSession
    ? `@${handle} moved to ${destination}. Its session moved with it.`
    : `@${handle} now runs on ${destination}.`;
}
