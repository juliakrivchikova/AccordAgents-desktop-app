import type { ChatCodexApprovalOption } from "../../../shared/types";
import { MAX_DISPLAY_TEXT } from "./constants";
import { displayString, redactApprovalText } from "./display";
import { assertOnlyKeys, record, requiredRecord, requiredStringArray } from "./fields";
import { validateNetworkPolicyAmendment } from "./validation";

export function simpleDecisionResponses(
  decisions: Array<[string, string, ChatCodexApprovalOption["outcome"]]>
): Array<{ option: ChatCodexApprovalOption; response: unknown }> {
  return decisions.map(([id, label, outcome]) => ({
    option: { id, label, outcome },
    response: { decision: id }
  }));
}

export function commandDecision(value: unknown, field: string): unknown {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") {
    return value;
  }
  const candidate = record(value);
  if (candidate && Object.keys(candidate).length === 1 && record(candidate.acceptWithExecpolicyAmendment)) {
    const wrapper = requiredRecord(candidate.acceptWithExecpolicyAmendment, `${field}.acceptWithExecpolicyAmendment`);
    assertOnlyKeys(wrapper, ["execpolicy_amendment"], `${field}.acceptWithExecpolicyAmendment`);
    const amendment = requiredStringArray(wrapper.execpolicy_amendment, `${field}.acceptWithExecpolicyAmendment.execpolicy_amendment`);
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
  }
  if (candidate && Object.keys(candidate).length === 1 && record(candidate.applyNetworkPolicyAmendment)) {
    const wrapper = requiredRecord(candidate.applyNetworkPolicyAmendment, `${field}.applyNetworkPolicyAmendment`);
    assertOnlyKeys(wrapper, ["network_policy_amendment"], `${field}.applyNetworkPolicyAmendment`);
    const amendment = validateNetworkPolicyAmendment(wrapper.network_policy_amendment, `${field}.applyNetworkPolicyAmendment.network_policy_amendment`);
    return { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } };
  }
  throw new Error(`${field} contains an unsupported decision.`);
}

export function commandDecisionId(value: unknown, index: number): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = record(value);
  return candidate?.acceptWithExecpolicyAmendment
    ? `acceptWithExecpolicyAmendment-${index}`
    : `applyNetworkPolicyAmendment-${index}`;
}

export function commandDecisionLabel(value: unknown): string {
  if (value === "accept") return "Allow once";
  if (value === "acceptForSession") return "Allow for this Codex session";
  if (value === "decline") return "Deny";
  if (value === "cancel") return "Cancel";
  const candidate = record(value);
  return candidate?.acceptWithExecpolicyAmendment
    ? "Allow and update command policy"
    : "Apply proposed network policy";
}

export function commandDecisionDetail(value: unknown): string | undefined {
  const candidate = record(value);
  const exec = record(candidate?.acceptWithExecpolicyAmendment);
  if (exec) {
    const amendment = requiredStringArray(exec.execpolicy_amendment, "execpolicy amendment");
    return displayString(`Command policy: ${amendment.map((item) => JSON.stringify(redactApprovalText(item))).join(" ")}`, MAX_DISPLAY_TEXT);
  }
  const network = record(record(candidate?.applyNetworkPolicyAmendment)?.network_policy_amendment);
  if (network) {
    return displayString(`Network policy: ${String(network.action)} ${String(network.host)}`, MAX_DISPLAY_TEXT);
  }
  return undefined;
}

export function commandDecisionOutcome(value: unknown): ChatCodexApprovalOption["outcome"] {
  if (value === "decline") return "deny";
  if (value === "cancel") return "cancel";
  return "approve";
}

export function grantedPermissions(value: unknown): Record<string, unknown> {
  const permissions = requiredRecord(value, "permissions");
  const granted: Record<string, unknown> = {};
  if (record(permissions.network)) granted.network = permissions.network;
  if (record(permissions.fileSystem)) granted.fileSystem = permissions.fileSystem;
  return granted;
}
