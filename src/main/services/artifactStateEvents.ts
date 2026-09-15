import { createHash } from "node:crypto";
import type { ArtifactDraftRecord, ArtifactRecord } from "./artifactStore";
import type { ArtifactActionEmission } from "./artifacts";
import type { ChatActionPayload } from "../../shared/chatActionEvents";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { compareLogicalOrder } from "../../shared/hlc";
import { stableJson } from "../../shared/stableJson";
import { ARTIFACT_CONTENT_MAX_BYTES } from "../../shared/artifacts";

export type ArtifactMetadata = Pick<ArtifactRecord, "name" | "owner" | "contributors" | "requiredSigners" | "labels" | "archivedAt"
  | "allowedDraftAuthors" | "requiredDraftAuthors" | "audiencePolicyByAuthor" | "draftRosterRevision">;

export type ArtifactStateChange =
  | { type: "collection"; record: ArtifactRecord }
  | { type: "metadata"; record: ArtifactRecord; before: Partial<ArtifactMetadata>; after: Partial<ArtifactMetadata> }
  | { type: "draft"; record: ArtifactRecord; draft: ArtifactDraftRecord; expected?: string };

export const ARTIFACT_STATE_KINDS = ["artifact.collection.created", "artifact.metadata.changed", "artifact.draft.saved",
  "artifact.draft.submitted", "artifact.draft.withdrawn"] as const;

export function artifactStateAction(kind: typeof ARTIFACT_STATE_KINDS[number], operationId: string, input: Exclude<ArtifactStateChange, { type: "draft" }> | { type: "draft"; record: ArtifactRecord; draft: ArtifactDraftRecord; expected?: ArtifactDraftRecord }): ArtifactActionEmission {
  const change: ArtifactStateChange = input.type === "draft" ? { ...input, expected: input.expected ? draftStateHash(input.expected) : undefined } : input;
  return { conversationId: change.record.conversationId, kind, payload: {
    operationId, targetKey: `artifact:${change.record.id}`, artifactChange: change
  } };
}

export function artifactStateChange(payload: ChatActionPayload): ArtifactStateChange | undefined {
  const change = payload.artifactChange as ArtifactStateChange | undefined;
  if (!change || !["collection", "metadata", "draft"].includes(change.type) || !change.record?.id
      || payload.targetKey !== `artifact:${change.record.id}`) return undefined;
  const record = change.record;
  if (![record.headVersion, record.draftRosterRevision].every(value => Number.isSafeInteger(value) && value >= 0)
      || !["published", "collecting_drafts"].includes(record.lifecycle)
      || ![record.id, record.name, record.owner, record.conversationId, record.createdAt, record.updatedAt].every(text)
      || ![record.contributors, record.requiredSigners, record.labels, record.allowedDraftAuthors, record.requiredDraftAuthors].every(strings)
      || !policy(record.audiencePolicyByAuthor) || !optionalText(record.archivedAt)) {
    throw new Error("Invalid artifact record in event.");
  }
  if (change.type === "draft") {
    const draft = change.draft;
    if (!draft || !Number.isSafeInteger(draft.editRevision) || draft.editRevision < 1
        || !["editing", "submitted", "superseded", "withdrawn"].includes(draft.state)
        || ![draft.id, draft.artifactId, draft.author, draft.createdAt, draft.updatedAt].every(text)
        || ![draft.supersedesDraftId, draft.submittedAt, change.expected].every(optionalText)
        || typeof draft.content !== "string" || Buffer.byteLength(draft.content, "utf8") > ARTIFACT_CONTENT_MAX_BYTES || !strings(draft.readers)) {
      throw new Error("Invalid draft in artifact event.");
    }
  } else if (change.type === "metadata") {
    const allowed = new Set(["name", "owner", "contributors", "requiredSigners", "labels", "archivedAt", "allowedDraftAuthors", "requiredDraftAuthors", "audiencePolicyByAuthor", "draftRosterRevision"]);
    for (const values of [change.before, change.after]) {
      if (!values || Array.isArray(values) || Object.keys(values).some(key => !allowed.has(key))
          || Object.entries(values).some(([key, value]) => key === "draftRosterRevision" ? false
            : key === "audiencePolicyByAuthor" ? !policy(value)
            : ["name", "owner", "archivedAt"].includes(key) ? typeof value !== "string" : !strings(value))
          || (values.draftRosterRevision !== undefined && (!Number.isSafeInteger(values.draftRosterRevision) || values.draftRosterRevision < 0))) {
        throw new Error("Invalid artifact metadata in event.");
      }
    }
  }
  return change;
}

function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function text(value: unknown): value is string { return typeof value === "string" && Boolean(value); }
function optionalText(value: unknown): boolean { return value === undefined || text(value); }
function policy(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every(row => row && strings(row.allowedReaders) && strings(row.requiredReaders)));
}

export function artifactStateEventSql(event: ChatEventEnvelope, change: ArtifactStateChange, condition = "1"): string {
  return `insert or ignore into artifact_state_events(event_id, artifact_id, event_json)
    select ${q(event.eventId)}, ${q(change.record.id)}, ${q(JSON.stringify({ ...event, payload: { ...event.payload as object, artifactChange: change } }))}
    where (${condition}) and not exists(select 1 from artifact_conversation_tombstones where conversation_id = ${q(change.record.conversationId)});`;
}

export const ARTIFACT_STATE_SCHEMA = `create table if not exists artifact_state_events (
  event_id text primary key, artifact_id text not null, event_json text not null);
  create index if not exists idx_artifact_state_events_artifact on artifact_state_events(artifact_id);`;

/** Pure re-fold: arrival order never decides which edit wins, and replay never
 * posts notes or repeats an agent action. Bodies stay bound to their draft id. */
export function foldArtifactState(events: ChatEventEnvelope<ChatActionPayload>[]): {
  record?: ArtifactRecord; metadata: Partial<ArtifactMetadata>; drafts: ArtifactDraftRecord[]; applied: Set<string>
} {
  const ordered = [...events].sort((a, b) => compareLogicalOrder(a, b)
    || a.originId.localeCompare(b.originId) || a.logScopeId.localeCompare(b.logScopeId)
    || a.originSeq - b.originSeq || a.eventId.localeCompare(b.eventId));
  let record: ArtifactRecord | undefined;
  const metadata: Partial<ArtifactMetadata> = {};
  const drafts = new Map<string, ArtifactDraftRecord>();
  const seenDrafts = new Map<string, ArtifactDraftRecord>();
  const applied = new Set<string>();
  for (const event of ordered) {
    const change = artifactStateChange(event.payload);
    if (!change) continue;
    record ??= structuredClone(change.record);
    if (event.conversationId !== record.conversationId || change.record.id !== record.id) throw new Error("Artifact event crossed its conversation.");
    if (change.type === "collection") {
      applied.add(event.eventId);
    } else if (change.type === "metadata") {
      // Untouched fields may have changed at publication (notably signers).
      // Each event carries that baseline; previously folded changes still win.
      const current = { ...change.record, ...metadata };
      if (!Object.entries(change.before).every(([key, value]) => stableJson(current[key as keyof ArtifactRecord] ?? (key === "archivedAt" ? "" : null)) === stableJson(value ?? (key === "archivedAt" ? "" : null)))) continue;
      Object.assign(metadata, change.after);
      applied.add(event.eventId);
    } else {
      const draft = change.draft;
      if (draft.artifactId !== record.id || !draft.id || typeof draft.content !== "string") throw new Error("Invalid artifact draft event.");
      const previous = drafts.get(draft.id);
      const seen = seenDrafts.get(draft.id);
      if (seen && seen.author !== draft.author) throw new Error("Draft identity changed.");
      seenDrafts.set(draft.id, draft);
      if (previous && (!change.expected || draftStateHash(previous) !== change.expected)) continue;
      // A submitted event is self-contained even if its saved draft did not
      // arrive. A different author's draft cannot replace this author's work.
      if (previous && previous.author !== draft.author) throw new Error("Draft identity changed.");
      const sameAuthor = [...drafts.values()].filter(row => row.author === draft.author && row.id !== draft.id);
      if (draft.state === "editing" && sameAuthor.some(row => row.state === "editing")) continue;
      if (draft.state === "submitted" && sameAuthor.some(row => row.state === "submitted" && row.id !== draft.supersedesDraftId)) continue;
      if (draft.state === "submitted" && draft.supersedesDraftId) {
        const old = drafts.get(draft.supersedesDraftId);
        if (old && old.author !== draft.author) throw new Error("Draft replacement crossed its author.");
        if (old) drafts.set(old.id, { ...old, state: "superseded", updatedAt: draft.updatedAt });
      }
      drafts.set(draft.id, structuredClone(draft));
      applied.add(event.eventId);
    }
  }
  // Retain a competing creation as superseded, including on its authoring
  // device, instead of leaving its local row active after the earlier edit wins.
  for (const [id, draft] of seenDrafts) if (!drafts.has(id)) drafts.set(id, { ...draft, state: "superseded" });
  return { record, metadata, drafts: [...drafts.values()], applied };
}

function draftStateHash(draft: ArtifactDraftRecord): string {
  return createHash("sha256").update(stableJson(draft)).digest("hex");
}

export function q(value: string | undefined | null): string {
  return value == null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}
