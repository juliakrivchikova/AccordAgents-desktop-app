import type { ChatCodexApprovalMethod } from "./types";

export const CODEX_GUARDIAN_DENIED_APPROVAL_METHOD = "item/autoApprovalReview/denied";
export const CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD = "item/autoApprovalReview/timedOut";
export const CHAT_CODEX_APPROVAL_CANCEL_DECISION_ID = "__chat_cancel__";

export function isCodexGuardianDeniedApprovalMethod(
  method: ChatCodexApprovalMethod | string | undefined
): method is typeof CODEX_GUARDIAN_DENIED_APPROVAL_METHOD {
  return method === CODEX_GUARDIAN_DENIED_APPROVAL_METHOD;
}

export function isCodexGuardianTimedOutApprovalMethod(
  method: ChatCodexApprovalMethod | string | undefined
): method is typeof CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD {
  return method === CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD;
}
