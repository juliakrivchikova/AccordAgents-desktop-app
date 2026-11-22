import type { LucideIcon } from "lucide-react";

import type { ChatAppToolApproval } from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";
import { formatChatTime } from "./chat-format";
import { useSessionsViewLabel, useSessionsViewNames, useSessionsViewText } from "./chat-sessions-links";
import { sessionsViewSummaryText } from "../../../shared/sessionsViewText";

/**
 * A used approval card in one line, like a folded urgent alert or choice (the
 * User, 2026-11-16 and 2026-11-18): its icon, what it was about, then who
 * asked, how it ended and when. It opens nothing; the whole of a cut-off line,
 * and why it ended so, are its tooltip and its accessible name. It stands
 * aligned with the messages' text and is found by its id (Activity's Open in
 * chat).
 */
export function ChatUsedApprovalLine(props: {
  approval: ChatAppToolApproval;
  /** What kind of card it was, for its accessible name (its icon says it). */
  kind: string;
  icon: LucideIcon;
  /** What the card was about. */
  preview: string;
  /** How it ended, in a word or two. */
  ended: string;
  /** Leave out the time (a line whose ending already names one). */
  withoutTime?: boolean;
  /** More than the line says: why it ended so. */
  detail?: string;
  /** The preview is the app's words about members ("Remove @gera from this
   *  chat"), worded without handles in the sessions view; otherwise (a
   *  command, a task's name) it is shown exactly as written. */
  appPreview?: boolean;
}): JSX.Element {
  // The sessions view names who asked by its task, the main session by
  // nothing, and what the card was about without handles.
  const appText = useSessionsViewText();
  const names = useSessionsViewNames();
  const requester = useSessionsViewLabel()(chatParticipantReference(props.approval.requesterHandle));
  const preview = props.appPreview ? sessionsViewSummaryText(props.preview, names) : props.preview;
  const detail = props.detail ? appText(props.detail) : undefined;
  const when = props.withoutTime ? "" : formatChatTime(props.approval.updatedAt);
  const outcome = `${requester ? `${requester} · ` : ""}${appText(props.ended)}${when ? ` ${when}` : ""}`;
  const Icon = props.icon;
  return (
    <section
      className={`chat-used-approval is-${props.approval.status}`}
      aria-label={[props.kind, `${preview}: ${outcome}`, detail].filter(Boolean).join(". ")}
      data-app-tool-approval-id={props.approval.id}
      tabIndex={-1}
    >
      <div className="chat-card-row" title={[preview, outcome, detail].filter(Boolean).join("\n")}>
        <Icon className="chat-card-row-icon" size={14} aria-hidden="true" />
        <span className="chat-card-row-preview">{preview}</span>
        <span className="chat-card-row-outcome">{outcome}</span>
      </div>
    </section>
  );
}
