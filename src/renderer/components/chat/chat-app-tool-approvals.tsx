import { useState, type KeyboardEvent } from "react";
import { CornerDownLeft } from "lucide-react";

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
  const chatOptionLabel = permissionRequest
    ? `Yes, allow @${props.approval.requesterHandle} in this chat`
    : participantRequest
      ? `Yes, allow @${props.approval.requesterHandle} to ask ${participantRequest.requests.length === 1 ? `@${participantRequest.requests[0].target.replace(/^@/, "")}` : "these targets"}`
      : "Yes, allow for this chat";
  const options: { key: string; label: string; approve: boolean; scope?: ChatAppToolApprovalScope }[] = [
    { key: "once", label: "Yes, allow once", approve: true, scope: "once" },
    ...(inferredParticipantRequest ? [] : [{ key: "chat", label: chatOptionLabel, approve: true, scope: "chat" as ChatAppToolApprovalScope }]),
    { key: "deny", label: `No, tell @${props.approval.requesterHandle} what to do differently`, approve: false }
  ];
  const defaultIndex = preferOnceApproval || inferredParticipantRequest ? 0 : Math.min(1, options.length - 1);
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex);

  function submit(): void {
    const option = options[Math.min(selectedIndex, options.length - 1)];
    if (option) {
      void props.onRespond(props.approval.id, option.approve, option.scope);
    }
  }

  function handleOptionsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (props.submitting) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (/^[1-9]$/.test(event.key)) {
      const next = Number(event.key) - 1;
      if (next < options.length) {
        event.preventDefault();
        setSelectedIndex(next);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

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
      <div
        className="chat-approval-options"
        role="listbox"
        tabIndex={0}
        aria-label="Approval options"
        onKeyDown={handleOptionsKeyDown}
      >
        {options.map((option, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className={`chat-approval-option ${index === selectedIndex ? "selected" : ""}`}
            disabled={props.submitting}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => setSelectedIndex(index)}
            key={option.key}
          >
            <span className="chat-approval-option-num">{index + 1}</span>
            <span className="chat-approval-option-label">{option.label}</span>
          </button>
        ))}
      </div>
      <div className="chat-approval-footer">
        <Button variant="default" size="sm" className="chat-approval-submit" disabled={props.submitting} onClick={submit}>
          <span>Submit</span>
          <CornerDownLeft size={14} aria-hidden />
        </Button>
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
