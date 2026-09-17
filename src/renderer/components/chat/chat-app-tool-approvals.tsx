import type {
  ChatAppToolApproval,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatParticipant,
  ChatParticipantConfig,
  CliProviderHost,
  ChatRoleConfig
} from "../../../shared/types";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";

export function ChatAppToolApprovalList(props: {
  approvals: ChatAppToolApproval[];
  participants: ChatParticipant[];
  savedParticipants: ChatParticipantConfig[];
  cliProviderHosts?: CliProviderHost[];
  roles: ChatRoleConfig[];
  submittingIds: ReadonlySet<string>;
  embedded?: boolean;
  onRespond: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest,
    codexDecisionId?: string
  ) => Promise<void>;
}): JSX.Element {
  return (
    <div className="chat-app-tool-approval-list" aria-label="Pending app tool approvals">
      {props.approvals.map((approval) => (
        <ChatAppToolApprovalCard
          approval={approval}
          participants={props.participants}
          savedParticipants={props.savedParticipants}
          cliProviderHosts={props.cliProviderHosts}
          roles={props.roles}
          submitting={props.submittingIds.has(approval.id)}
          embedded={props.embedded}
          onRespond={props.onRespond}
          key={approval.id}
        />
      ))}
    </div>
  );
}
