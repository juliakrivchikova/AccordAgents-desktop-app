import type { ArtifactApproval } from "../../../shared/types";

// Approval at a glance: unsigned / N of M signed / fully approved.
export function ArtifactApprovalBadge({ approval, compact }: { approval: ArtifactApproval; compact?: boolean }): JSX.Element | null {
  if (approval.state === "none-required") {
    return compact ? null : <span className="artifact-approval artifact-approval-none">no signers required</span>;
  }
  if (approval.state === "approved") {
    return (
      <span className="artifact-approval artifact-approval-approved" title="Fully approved: every required signer signed the current version">
        ✓ {compact ? "approved" : "fully approved"}
      </span>
    );
  }
  const label = `${approval.signedCurrent.length}/${approval.requiredSigners.length} signed`;
  return (
    <span
      className={`artifact-approval ${approval.state === "unsigned" ? "artifact-approval-unsigned" : "artifact-approval-partial"}`}
      title={`Required signers: ${approval.requiredSigners.join(", ")}`}
    >
      {approval.state === "unsigned" && !compact ? "unsigned" : label}
    </span>
  );
}
