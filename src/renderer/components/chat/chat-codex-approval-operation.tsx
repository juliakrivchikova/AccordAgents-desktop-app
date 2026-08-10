import type { ChatCodexApprovalRequest } from "../../../shared/types";

function actionLabel(request: ChatCodexApprovalRequest): string {
  if (request.method === "item/autoApprovalReview/denied") return "Auto Review denied";
  if (request.action === "command") return "Protected command";
  if (request.action === "permissions") return "Additional permissions";
  if (request.action === "network") return "Protected network access";
  if (request.action === "mcpToolCall") return "Protected MCP tool call";
  return "Protected file changes";
}

export function ChatCodexApprovalOperation({ request }: { request: ChatCodexApprovalRequest }): JSX.Element {
  const permissions = request.permissions;
  return (
    <div className="chat-codex-approval-operation" data-testid="codex-approval-details">
      <div className="chat-app-tool-review-chip">{actionLabel(request)}</div>
      {request.command && <pre className="chat-codex-approval-command"><code>{request.command}</code></pre>}
      {request.commandActions && request.commandActions.length > 0 && (
        <ul className="chat-codex-approval-actions" aria-label="Parsed command actions">
          {request.commandActions.map((action, index) => (
            <li key={`${action.type}:${action.command}:${index}`}>
              <span>{action.name ?? action.type}</span>
              <code>{action.path ?? action.query ?? action.command}</code>
            </li>
          ))}
        </ul>
      )}
      <dl className="chat-codex-approval-facts">
        {request.cwd && <><dt>Working directory</dt><dd>{request.cwd}</dd></>}
        {request.grantRoot && request.grantRoot !== request.cwd && <><dt>Requested write root</dt><dd>{request.grantRoot}</dd></>}
        {request.reason && <><dt>Reason</dt><dd>{request.reason}</dd></>}
        {request.guardianRiskLevel && <><dt>Risk</dt><dd>{request.guardianRiskLevel}</dd></>}
        {request.guardianUserAuthorization && <><dt>User authorization</dt><dd>{request.guardianUserAuthorization}</dd></>}
        {request.guardianDecisionSource && <><dt>Decision source</dt><dd>{request.guardianDecisionSource}</dd></>}
        {request.networkTarget && <><dt>Network target</dt><dd>{request.networkTarget}</dd></>}
        {request.networkProtocol && <><dt>Protocol</dt><dd>{request.networkProtocol}</dd></>}
        {request.mcpServer && <><dt>MCP server</dt><dd>{request.mcpServer}</dd></>}
        {request.mcpToolName && <><dt>MCP tool</dt><dd>{request.mcpToolName}</dd></>}
        {permissions?.network && <><dt>Network</dt><dd>Additional network access requested</dd></>}
        {permissions?.readPaths && permissions.readPaths.length > 0 && <><dt>Read access</dt><dd>{permissions.readPaths.join(", ")}</dd></>}
        {permissions?.writePaths && permissions.writePaths.length > 0 && <><dt>Write access</dt><dd>{permissions.writePaths.join(", ")}</dd></>}
      </dl>
      {request.fileChanges && request.fileChanges.length > 0 && (
        <ul className="chat-codex-approval-files" aria-label="Requested file changes">
          {request.fileChanges.map((change) => (
            <li key={`${change.change}:${change.path}`}>
              <span>{change.change}</span>
              <code>{change.path}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
