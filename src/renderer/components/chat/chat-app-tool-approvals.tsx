import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ChatAppToolApproval,
  ChatAppToolApprovalScope,
  ChatParticipantRequestApprovalRequest,
  ChatPermissionChangeRequest,
  ChatRosterChangeOperation
} from "../../../shared/types";
import { StatusBadge } from "../primitives";
import {
  APP_ROSTER_REQUEST_CHANGE_TOOL,
  chatParticipantRequestApprovalRequest,
  chatPermissionChangeRequest,
  chatPermissionGrantDescription,
  chatPermissionGrantLabel
} from "./chat-conversation-data";

export function ChatAppToolApprovalList(props: {
  approvals: ChatAppToolApproval[];
  submittingIds: ReadonlySet<string>;
  onRespond: (approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope) => Promise<void>;
}): JSX.Element {
  return (
    <div className="chat-app-tool-approval-list" aria-label="Pending app tool approvals">
      {props.approvals.map((approval) => (
        <ChatAppToolApprovalCard
          approval={approval}
          submitting={props.submittingIds.has(approval.id)}
          onRespond={props.onRespond}
          key={approval.id}
        />
      ))}
    </div>
  );
}

function ChatAppToolApprovalCard(props: {
  approval: ChatAppToolApproval;
  submitting: boolean;
  onRespond: (approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope) => Promise<void>;
}): JSX.Element {
  const permissionRequest = chatPermissionChangeRequest(props.approval);
  const participantRequest = chatParticipantRequestApprovalRequest(props.approval);
  const inferredParticipantRequest = participantRequest?.source === "inferred";
  const preferOnceApproval = Boolean(permissionRequest && permissionRequest.kind !== "portable");
  const added = props.approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL && "operations" in props.approval.request
    ? props.approval.request.operations.filter((operation) => operation.type === "add")
    : [];
  const approvalKind = permissionRequest ? "Permission request" : participantRequest ? "Participant request" : "App tool request";
  return (
    <section className="chat-app-tool-approval-card" aria-label={props.approval.summary}>
      <div className="chat-app-tool-approval-head">
        <div>
          <span>{approvalKind} · @{props.approval.requesterHandle}</span>
          <strong>{props.approval.summary}</strong>
        </div>
        <StatusBadge tone="warning">approval needed</StatusBadge>
      </div>
      {props.approval.request.reason && <p>{props.approval.request.reason}</p>}
      {permissionRequest ? (
        <ChatAppToolPermissionOperation request={permissionRequest} />
      ) : participantRequest ? (
        <ChatAppToolParticipantRequestOperation request={participantRequest} requesterHandle={props.approval.requesterHandle} />
      ) : (
        <div className="chat-app-tool-roster-list">
          {added.map((operation, index) => (
            <ChatAppToolRosterOperation operation={operation} key={`${operation.participant.handle}-${index}`} />
          ))}
        </div>
      )}
      {permissionRequest && (
        <p className="chat-app-tool-scope-note">
          Applies only to @{props.approval.requesterHandle}. Allow once expires after the next run; chat grants stay enabled for this participant in this chat.
        </p>
      )}
      {participantRequest && (
        <p className="chat-app-tool-scope-note">
          Approval runs the requested participant{participantRequest.requests.length === 1 ? "" : "s"} and then returns to @{props.approval.requesterHandle} after replies or errors. {inferredParticipantRequest ? "Inferred requests are approved one time." : "Chat grants apply only to this requester and target set."}
        </p>
      )}
      <div className="chat-app-tool-approval-actions">
        <Button variant="outline" size="sm" disabled={props.submitting} onClick={() => void props.onRespond(props.approval.id, false)}>
          Deny
        </Button>
        <Button variant={preferOnceApproval ? "default" : "outline"} size="sm" disabled={props.submitting} onClick={() => void props.onRespond(props.approval.id, true, "once")}>
          <CheckCircle2 size={16} />
          Allow once
        </Button>
        {!inferredParticipantRequest && (
          <Button variant={preferOnceApproval ? "outline" : "default"} size="sm" disabled={props.submitting} onClick={() => void props.onRespond(props.approval.id, true, "chat")}>
            <CheckCircle2 size={16} />
            {permissionRequest
              ? `Allow @${props.approval.requesterHandle} in this chat`
              : participantRequest
                ? `Allow @${props.approval.requesterHandle} to ask ${participantRequest.requests.length === 1 ? `@${participantRequest.requests[0].target.replace(/^@/, "")}` : "these targets"}`
                : "Allow for chat"}
          </Button>
        )}
      </div>
    </section>
  );
}

function ChatAppToolRosterOperation({ operation }: { operation: ChatRosterChangeOperation }): JSX.Element {
  return (
    <div className="chat-app-tool-roster-item">
      <strong>@{operation.participant.handle}</strong>
      <span>{operation.participant.roleConfigId} · {operation.participant.kind}</span>
    </div>
  );
}

function ChatAppToolPermissionOperation({ request }: { request: ChatPermissionChangeRequest }): JSX.Element {
  if (request.kind === "shellRules") {
    return (
      <div className="chat-app-tool-roster-list">
        {request.rules.map((rule, index) => (
          <div className="chat-app-tool-roster-item" key={`${rule.action}-${rule.match}-${rule.pattern}-${index}`}>
            <strong>Shell {rule.action}</strong>
            <span>{rule.match} <code>{rule.pattern}</code></span>
          </div>
        ))}
      </div>
    );
  }
  if (request.kind === "providerNative") {
    return (
      <div className="chat-app-tool-roster-list">
        {request.allowedTools.map((token) => (
          <div className="chat-app-tool-roster-item" key={token}>
            <strong>Claude only</strong>
            <span><code>{token}</code></span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="chat-app-tool-roster-list">
      {request.permissions.map((permission) => (
        <div className="chat-app-tool-roster-item" key={permission}>
          <strong>{chatPermissionGrantLabel(permission)}</strong>
          <span>{chatPermissionGrantDescription(permission)}</span>
        </div>
      ))}
    </div>
  );
}

function ChatAppToolParticipantRequestOperation({ request, requesterHandle }: { request: ChatParticipantRequestApprovalRequest; requesterHandle: string }): JSX.Element {
  return (
    <div className="chat-app-tool-roster-list">
      {request.requests.map((item, index) => (
        <div className="chat-app-tool-roster-item" key={`${item.target}-${index}`}>
          <strong>@{requesterHandle} asks @{item.target.replace(/^@/, "")}</strong>
          <span>{item.prompt}</span>
        </div>
      ))}
    </div>
  );
}
