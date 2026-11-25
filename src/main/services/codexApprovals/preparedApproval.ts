import type { ChatCodexApprovalOption, ChatCodexApprovalRequest } from "../../../shared/types";
import { MAX_DISPLAY_PATH } from "./constants";
import { displayString } from "./display";
import type { PreparedCodexApproval } from "./types";

export function prepared(
  request: ChatCodexApprovalRequest,
  responses: Array<{ option: ChatCodexApprovalOption; response: unknown }>
): PreparedCodexApproval {
  return {
    request,
    responseByOptionId: new Map(responses.map((item) => [item.option.id, item.response]))
  };
}

export function commonV2Fields(params: Record<string, unknown>): Pick<ChatCodexApprovalRequest, "threadId" | "turnId" | "itemId" | "approvalId"> {
  return {
    threadId: displayString(params.threadId, MAX_DISPLAY_PATH),
    turnId: displayString(params.turnId, MAX_DISPLAY_PATH),
    itemId: displayString(params.itemId, MAX_DISPLAY_PATH),
    approvalId: displayString(params.approvalId, MAX_DISPLAY_PATH)
  };
}
