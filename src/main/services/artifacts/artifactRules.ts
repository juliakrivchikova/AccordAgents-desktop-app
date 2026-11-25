import { randomUUID } from "node:crypto";
import type { ArtifactError } from "../../../shared/types";
import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import type { ArtifactEventRecord, ArtifactOperationRecord, ArtifactRecord } from "../artifactStore";

export function artifactOperation<T = unknown>(
  conversationId: string,
  actor: string,
  operationKind: string,
  operationId: string,
  requestHash: string,
  result: { artifactId: string; draftId?: string; value?: T },
  createdAt: string,
  artifactId?: string
): ArtifactOperationRecord {
  return {
    conversationId,
    artifactId,
    actor,
    operationKind,
    operationId,
    requestHash,
    resultJson: JSON.stringify(result),
    createdAt
  };
}

export function artifactEvent(
  artifact: ArtifactRecord,
  actor: string,
  kind: string,
  content: string,
  createdAt: string
): ArtifactEventRecord {
  return {
    id: randomUUID(),
    conversationId: artifact.conversationId,
    artifactId: artifact.id,
    kind,
    actor,
    content,
    createdAt
  };
}

export function requireContributor(record: ArtifactRecord, actor: string, action: string): ArtifactError | undefined {
  if (actor === ARTIFACT_USER_MEMBER || record.owner === actor || record.contributors.includes(actor)) {
    return undefined;
  }
  return {
    code: "access_denied",
    message: `${artifactMemberLabel(actor)} cannot ${action} "${record.name}": only User, the owner (${artifactMemberLabel(record.owner)}), and contributors (${record.contributors.map(artifactMemberLabel).join(", ") || "none"}) can.`
  };
}

export function archivedMutationError(record: ArtifactRecord, action: string): ArtifactError | undefined {
  if (!record.archivedAt) {
    return undefined;
  }
  return {
    code: "invalid_request",
    message: `Restore "${record.name}" before ${action}.`
  };
}

export function canManageAccess(record: ArtifactRecord, actor: string): boolean {
  return actor === ARTIFACT_USER_MEMBER || record.owner === actor;
}
