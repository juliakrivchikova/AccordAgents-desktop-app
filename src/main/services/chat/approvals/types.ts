import type { ClaudePlanApprovalMode } from "../../../../shared/claudePlanApproval";
import type {
  ChatAppToolApprovalScope, ChatPermissionChangeRequest, ChatPermissionGrant, ChatShellPermissionRule, ChatToolPermissionRequest
} from "../../../../shared/types";

export interface PreparedPermissionChange {
  request: ChatPermissionChangeRequest;
  portablePermissions: ChatPermissionGrant[];
  shellRules: ChatShellPermissionRule[];
  providerNativeAllowedTools: string[];
  githubAppRequest: boolean;
  summary: string;
}

export interface PreparedToolPermission {
  request: ChatToolPermissionRequest;
  toolInput: unknown;
  summary: string;
}

export interface ToolPermissionDecision {
  approve: boolean;
  scope?: ChatAppToolApprovalScope;
  reason?: string;
  source: "user" | "policy" | "timeout" | "abort";
  /** Claude Code's plan approval: the mode the CLI moves to on her Yes. */
  planMode?: ClaudePlanApprovalMode;
}
