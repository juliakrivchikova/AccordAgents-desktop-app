import { TerminalWindowIcon } from "@phosphor-icons/react";

import type { ChatAppToolApproval } from "../../../shared/types";
import { chatCodexApprovalRequest, chatCodexApprovalShowsCancel } from "./chat-codex-approval-presentation";
import { ChatUsedApprovalLine } from "./chat-used-card-row";

/** How a decided Codex approval reads in its line. A denial closed without a
 *  retry does not show the command it denied. */
function codexApprovalEnding(approval: ChatAppToolApproval): { preview: string; ended: string; detail?: string } {
  const closedDenial = approval.status === "cancelled" &&
    chatCodexApprovalShowsCancel(chatCodexApprovalRequest(approval));
  const ended = approval.status === "approved"
    ? "Approved"
    : approval.status === "denied"
      ? "Denied"
      : approval.status === "cancelled"
        ? "Cancelled"
        : approval.status === "expired"
          ? "Expired"
          : "Completed";
  return closedDenial
    ? { preview: "Codex Auto Review denial", ended, detail: "Closed without retrying the denied action." }
    : { preview: approval.summary, ended, ...(approval.error ? { detail: approval.error } : {}) };
}

/** A decided Codex approval: one line, the action it was about, then who
 *  asked, how it ended and when (the whole command on hover). */
export function ChatCodexApprovalResult({ approval }: { approval: ChatAppToolApproval }): JSX.Element {
  return <ChatUsedApprovalLine approval={approval} kind="Codex approval" icon={TerminalWindowIcon} {...codexApprovalEnding(approval)} />;
}
