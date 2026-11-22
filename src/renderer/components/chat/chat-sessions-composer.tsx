import type { ReactNode } from "react";

import type { ChatParticipant } from "../../../shared/types";
import type { ChatComposerProps } from "./chat-composer";

const NO_MENTIONS: ChatParticipant[] = [];

/** The placeholder of a composer in the sessions view: no handles there. */
export const SESSIONS_COMPOSER_PLACEHOLDER = "Ask anything. / commands, # files";

/**
 * Whom the main composer's message is for: in the sessions view exactly the
 * main session, whatever the text names; in the classic view nobody fixed
 * (undefined), so the message goes where today's rules send it (an @handle
 * to that member; none to the main session in a main-session chat, the old
 * rules in an old chat). `sessionsMainId`: the main session, only while the
 * chat is shown in the sessions view.
 */
export function mainComposerTargetIds(sessionsMainId: string | undefined): string[] | undefined {
  return sessionsMainId ? [sessionsMainId] : undefined;
}

/**
 * The main composer in the sessions view (docs/main-session.md): it writes to
 * the main session whatever its text names, so it offers no members to
 * mention (commands and files stay), and it carries the main session's
 * controls (model, effort, permission mode), as Claude's desktop app, Codex
 * and T3 Code have them under their composers. It has no "N active runs" pill (the
 * reply's task rows and the side panel name the members, the panel stops them); while the main
 * session itself runs, its send button stops that run when there is nothing
 * to send. The classic view's composer is as before.
 */
export function sessionsComposerProps(
  mainSessionId: string | undefined,
  renderMemberChip?: (participantId: string) => ReactNode,
  main?: { runIds: readonly string[]; onStopRun?: (runId: string) => void }
): Partial<Pick<ChatComposerProps, "participants" | "placeholder" | "footerChip" | "activeRunCount" | "onStopAllRuns" | "stop">> {
  if (!mainSessionId) {
    return {};
  }
  const runIds = main?.runIds ?? [];
  const onStopRun = main?.onStopRun;
  return {
    participants: NO_MENTIONS,
    placeholder: SESSIONS_COMPOSER_PLACEHOLDER,
    footerChip: renderMemberChip?.(mainSessionId),
    activeRunCount: 0,
    onStopAllRuns: undefined,
    stop: runIds.length > 0 && onStopRun
      ? { label: "Stop", onStop: () => runIds.forEach((runId) => onStopRun(runId)) }
      : undefined
  };
}
