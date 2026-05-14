import type { FindingSeverity } from "../../../shared/types";
import { StatusBadge, type StatusBadgeTone } from "./status-badge";

const SEVERITY_TONE: Record<FindingSeverity, StatusBadgeTone> = {
  Critical: "danger",
  High: "danger",
  Medium: "warning",
  Low: "info",
  Info: "muted"
};

export interface SeverityBadgeProps {
  severity: FindingSeverity;
  className?: string;
}

export const SeverityBadge = ({ severity, className }: SeverityBadgeProps): JSX.Element => (
  <StatusBadge tone={SEVERITY_TONE[severity]} className={className} uppercase>
    {severity}
  </StatusBadge>
);
