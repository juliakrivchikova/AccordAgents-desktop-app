export type ChatCodexApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "item/autoApprovalReview/denied"
  | "item/autoApprovalReview/timedOut"
  | "applyPatchApproval"
  | "execCommandApproval";

export interface ChatCodexApprovalOption {
  id: string;
  label: string;
  detail?: string;
  outcome: "approve" | "deny" | "cancel";
}

export interface ChatCodexCommandActionSummary {
  type: "read" | "listFiles" | "search" | "unknown";
  command: string;
  name?: string;
  path?: string;
  query?: string;
}

export interface ChatCodexPermissionSummary {
  network?: boolean;
  readPaths?: string[];
  writePaths?: string[];
}

export interface ChatCodexFileChangeSummary {
  path: string;
  change: "add" | "delete" | "update" | "unknown";
}

export interface ChatCodexApprovalRequest {
  kind: "codexApproval";
  method: ChatCodexApprovalMethod;
  requestId: string | number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  approvalId?: string;
  action: "command" | "fileChange" | "permissions" | "network" | "mcpToolCall";
  command?: string;
  commandActions?: ChatCodexCommandActionSummary[];
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  fileChanges?: ChatCodexFileChangeSummary[];
  permissions?: ChatCodexPermissionSummary;
  networkTarget?: string;
  networkProtocol?: string;
  mcpServer?: string;
  mcpToolName?: string;
  guardianRiskLevel?: string;
  guardianUserAuthorization?: string;
  guardianDecisionSource?: string;
  options: ChatCodexApprovalOption[];
}
