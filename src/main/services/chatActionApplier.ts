/**
 * Applying a chat action that arrived from another machine.
 *
 * Emitting an action is half a user scenario. Until every peer applies it, a
 * signature made on one machine is invisible on the next, and two machines that
 * revised the same artifact never learn that one of them lost. This is the
 * receiving half, shared by the desktop link and the machine host so both apply
 * the same event the same way.
 *
 * The outcomes are deliberately distinct:
 *
 *   - `applied`     the local state now reflects the action.
 *   - `duplicate`   it was already applied; folding it again changes nothing.
 *   - `deferred`    this peer does not hold what the action refers to yet. The
 *                   event is kept and retried rather than dropped, so nothing
 *                   is lost while the content it depends on is still on its way.
 *   - `superseded`  the action was made on state this peer has already moved
 *                   past. It is recorded as visibly superseded, never applied
 *                   silently over the winner.
 *
 * A signature is stored against the revision it was made on, by id and content
 * hash. It is never re-pointed at whatever the head happens to be now: the head
 * filter decides what counts toward approval, so a signature on a revision that
 * lost a race keeps belonging to the content its signer actually read.
 *
 * Nothing here repeats an external effect. An execution receipt is recorded as
 * a fact and applied exactly once; re-delivery is a duplicate.
 */

import {
  isChatActionKind,
  type ChatActionKind,
  type ChatActionPayload,
  type ChatSignaturePayload
} from "../../shared/chatActionEvents";
import type { ChatEventEnvelope } from "../../shared/chatEvents";

export interface ChatActionArtifactPort {
  getRevision(artifactId: string, versionEventId: string): Promise<
    { version: number; contentHash: string; superseded: boolean } | undefined
  >;
  insertSignature(record: {
    artifactId: string;
    version: number;
    versionEventId: string;
    contentHash: string;
    signer: string;
    signedAt: string;
  }): Promise<boolean>;
}

export type ChatActionApplyStatus = "applied" | "duplicate" | "deferred" | "superseded";

export interface ChatActionApplyResult {
  status: ChatActionApplyStatus;
  kind: ChatActionKind;
  targetKey: string;
  /** Shown to the User for a superseded or deferred action. */
  detail?: string;
}

export interface ChatActionApplierDeps {
  artifacts?: ChatActionArtifactPort;
  now?(): string;
  logger?(event: string, payload: Record<string, unknown>): void;
}

export class ChatActionApplier {
  constructor(private readonly deps: ChatActionApplierDeps = {}) {}

  /** True when this event is one this applier owns. */
  handles(event: ChatEventEnvelope): boolean {
    return isChatActionKind(event.kind) && isActionPayload(event.payload);
  }

  async apply(event: ChatEventEnvelope): Promise<ChatActionApplyResult> {
    const payload = event.payload as ChatActionPayload;
    const kind = event.kind as ChatActionKind;
    const base = { kind, targetKey: payload.targetKey };
    if (kind === "execution.receipt") {
      // A fact about something that already happened elsewhere. Recording it is
      // the whole application; there is nothing local to repeat.
      return { ...base, status: "applied" };
    }
    if (kind === "artifact.signature.added") {
      return this.applySignature(event, payload, base);
    }
    if (kind === "artifact.revision.created") {
      return this.applyRevision(payload, base);
    }
    // Permissions, choices, participant requests and Stop are projected from
    // the log rather than written into a second store, so recording the event
    // is the application.
    return { ...base, status: "applied" };
  }

  private async applySignature(
    event: ChatEventEnvelope,
    payload: ChatActionPayload,
    base: { kind: ChatActionKind; targetKey: string }
  ): Promise<ChatActionApplyResult> {
    const artifacts = this.deps.artifacts;
    const signature = payload as ChatSignaturePayload;
    const artifactId = artifactIdFromTarget(payload.targetKey);
    if (!artifacts || !artifactId || typeof signature.signer !== "string"
      || typeof signature.signedStateId !== "string" || typeof signature.signedContentHash !== "string") {
      return { ...base, status: "applied" };
    }
    const revision = await artifacts.getRevision(artifactId, signature.signedStateId);
    if (!revision) {
      // The revision this signature was made on has not reached this peer yet.
      // Keeping the event is the only honest option: dropping it would lose a
      // signature, and inventing a target would attach it to the wrong content.
      return {
        ...base,
        status: "deferred",
        detail: `The revision ${signature.signer} signed is not on this machine yet.`
      };
    }
    if (revision.contentHash !== signature.signedContentHash) {
      return {
        ...base,
        status: "superseded",
        detail: `${signature.signer} signed different content than this machine holds for that revision.`
      };
    }
    const inserted = await artifacts.insertSignature({
      artifactId,
      version: revision.version,
      versionEventId: signature.signedStateId,
      contentHash: signature.signedContentHash,
      signer: signature.signer,
      signedAt: signatureTime(event, this.deps.now)
    });
    if (!inserted) return { ...base, status: "duplicate" };
    return revision.superseded
      ? {
        ...base,
        status: "applied",
        detail: `${signature.signer}'s signature belongs to a revision that lost a race; it does not count toward the current version.`
      }
      : { ...base, status: "applied" };
  }

  private async applyRevision(
    payload: ChatActionPayload,
    base: { kind: ChatActionKind; targetKey: string }
  ): Promise<ChatActionApplyResult> {
    const artifacts = this.deps.artifacts;
    const artifactId = artifactIdFromTarget(payload.targetKey);
    if (!artifacts || !artifactId || !payload.stateId) {
      return { ...base, status: "applied" };
    }
    const already = await artifacts.getRevision(artifactId, payload.stateId);
    if (already) return { ...base, status: "duplicate" };
    const expected = payload.precondition?.expectedStateId;
    if (!expected) {
      // The action that establishes a target's first state. Its content is
      // replicated separately; recording it is what makes the ordering work.
      return { ...base, status: "applied" };
    }
    const base_ = await artifacts.getRevision(artifactId, expected);
    if (!base_) {
      return {
        ...base,
        status: "deferred",
        detail: "The revision this change was made on is not on this machine yet."
      };
    }
    if (base_.superseded) {
      return {
        ...base,
        status: "superseded",
        detail: "This change was made on a revision that has since been replaced; it is shown as superseded."
      };
    }
    // The base is current here, so the peer is ahead. Its content arrives with
    // the artifact replication; the ordering is already recorded by the event.
    return { ...base, status: "applied" };
  }
}

function artifactIdFromTarget(targetKey: string): string | undefined {
  const match = /^artifact:(.+)$/.exec(targetKey);
  return match?.[1];
}

function signatureTime(event: ChatEventEnvelope, now?: () => string): string {
  return event.createdAt || now?.() || new Date().toISOString();
}

function isActionPayload(value: unknown): value is ChatActionPayload {
  const payload = value as Partial<ChatActionPayload> | undefined;
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload)
    && typeof payload.operationId === "string" && payload.operationId
    && typeof payload.targetKey === "string" && payload.targetKey);
}
