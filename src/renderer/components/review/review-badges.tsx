import { CheckCircleIcon, CircleIcon, QuestionIcon, XCircleIcon } from "@phosphor-icons/react";

import type {
  Finding,
  PlanItemReview
} from "../../../shared/types";
import {
  StatusBadge,
  type StatusBadgeTone
} from "../primitives";
import { pointStatus } from "./review-conversation-data";

const POINT_STATUS_TONE: Record<"confirmed" | "disputed" | "unresolved" | "filtered-out", StatusBadgeTone> = {
  confirmed: "success",
  disputed: "warning",
  unresolved: "neutral",
  "filtered-out": "muted"
};

export function PointStatusBadge({ finding }: { finding: Finding }): JSX.Element {
  const status = pointStatus(finding);
  const Icon = status.kind === "confirmed" ? CheckCircleIcon : status.kind === "filtered-out" ? XCircleIcon : QuestionIcon;
  return (
    <StatusBadge tone={POINT_STATUS_TONE[status.kind]} icon={Icon}>
      {status.label}
    </StatusBadge>
  );
}

export function PlanItemReviewBadge({ review }: { review?: PlanItemReview }): JSX.Element {
  if (review) {
    return (
      <StatusBadge tone="success" icon={CheckCircleIcon}>
        reviewed
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" icon={CircleIcon}>
      pending
    </StatusBadge>
  );
}
