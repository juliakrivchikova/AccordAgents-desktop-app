import type { FindingSeverity, ReviewProgress } from "../../../shared/types";

export type ProgressCallback = (progress: ReviewProgress) => void;

export interface LinePoint {
  id: string;
  title: string;
  claim: string;
  evidence: string;
  action: string;
  severity: FindingSeverity;
  sourceParticipantIds: string[];
}

export interface RawImplementationPlan {
  participantId: string;
  participantLabel: string;
  content: string;
  createdAt: string;
}
