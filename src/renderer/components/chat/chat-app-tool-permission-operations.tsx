import type { ChatParticipantRequestApprovalRequest, ChatPermissionChangeRequest, ChatToolPermissionRequest } from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";
import { chatPermissionGrantDescription, chatPermissionGrantLabel } from "./chat-conversation-data";

export function ChatAppToolPermissionOperation({ request }: { request: ChatPermissionChangeRequest }): JSX.Element {
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

export function ChatAppToolPermissionPromptOperation({ request }: { request: ChatToolPermissionRequest }): JSX.Element {
  const inputPreview = JSON.stringify(request.toolInput ?? {}, null, 2);
  return (
    <div className="chat-app-tool-roster-list">
      <div className="chat-app-tool-roster-item">
        <strong>Tool request</strong>
        <span><code>{request.toolName}</code></span>
      </div>
      <div className="chat-app-tool-roster-item is-tool-input">
        <strong>Input</strong>
        <pre>{inputPreview}</pre>
      </div>
    </div>
  );
}

export function ChatAppToolParticipantRequestOperation({ request, requesterHandle }: { request: ChatParticipantRequestApprovalRequest; requesterHandle: string }): JSX.Element {
  return (
    <div className="chat-app-tool-roster-list">
      {request.requests.map((item, index) => (
        <div className="chat-app-tool-roster-item" key={`${item.target}-${index}`}>
          <strong>{chatParticipantReference(requesterHandle)} asks {chatParticipantReference(item.target)}</strong>
          <span>{item.prompt}</span>
        </div>
      ))}
    </div>
  );
}

