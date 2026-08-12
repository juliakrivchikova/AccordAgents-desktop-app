import { AlertTriangle, Check } from "lucide-react";

import type { ChatAppToolApproval } from "../../../shared/types";
import { chatCodexApprovalRequest, chatCodexApprovalShowsCancel } from "./chat-codex-approval-presentation";

export function ChatCodexApprovalResult({ approval }: { approval: ChatAppToolApproval }): JSX.Element {
  const approved = approval.status === "approved";
  const guardianCancelled = approval.status === "cancelled" &&
    chatCodexApprovalShowsCancel(chatCodexApprovalRequest(approval));
  const title = approved
    ? "Approved"
    : approval.status === "denied"
      ? "Denied"
      : approval.status === "cancelled"
        ? "Cancelled"
        : approval.status === "expired"
          ? "Expired"
          : "Completed";
  return (
    <div className={`chat-app-tool-result-card is-${approval.status}`}>
      <div className={`chat-app-tool-result-icon ${approved ? "" : "is-denied"}`} aria-hidden>
        {approved ? <Check size={19} /> : <AlertTriangle size={18} />}
      </div>
      <div className="chat-app-tool-result-copy">
        <strong>{title}</strong>
        <span>{guardianCancelled
          ? "Closed without retrying the denied action."
          : approval.error
            ? `${approval.summary}: ${approval.error}`
            : approval.summary}</span>
      </div>
    </div>
  );
}
