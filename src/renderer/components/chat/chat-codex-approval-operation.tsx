import type { ChatCodexApprovalRequest } from "../../../shared/types";

function actionLabel(request: ChatCodexApprovalRequest): string {
  if (request.action === "command") return "Protected command";
  if (request.action === "permissions") return "Additional permissions";
  return "Protected file changes";
}

export function ChatCodexApprovalOperation({ request }: { request: ChatCodexApprovalRequest }): JSX.Element {
  const permissions = request.permissions;
  return (
    <div className="chat-codex-approval-operation" data-testid="codex-approval-details">
      <div className="chat-app-tool-review-chip">{actionLabel(request)}</div>
      {request.command && <pre className="chat-codex-approval-command"><code>{request.command}</code></pre>}
      <dl className="chat-codex-approval-facts">
        {request.cwd && <><dt>Working directory</dt><dd>{request.cwd}</dd></>}
        {request.grantRoot && request.grantRoot !== request.cwd && <><dt>Requested write root</dt><dd>{request.grantRoot}</dd></>}
        {request.reason && <><dt>Reason</dt><dd>{request.reason}</dd></>}
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
