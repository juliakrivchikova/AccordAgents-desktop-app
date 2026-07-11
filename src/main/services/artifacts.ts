import { randomUUID } from "node:crypto";
import type {
  ArtifactDiffResult,
  ArtifactError,
  ArtifactReadResult,
  ArtifactResult,
  ArtifactSummary,
  ArtifactVersionContent,
  ArtifactVersionMeta,
  CreateArtifactRequest,
  DiffArtifactRequest,
  ReadArtifactRequest,
  RenameArtifactRequest,
  ReviseArtifactRequest,
  SignArtifactRequest,
  UpdateArtifactAccessRequest
} from "../../shared/types";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_LABEL_MAX_LENGTH,
  ARTIFACT_MAX_LABELS,
  ARTIFACT_NAME_MAX_LENGTH,
  ARTIFACT_NOTE_MAX_LENGTH,
  artifactApprovalShortLabel,
  artifactMemberLabel,
  artifactNameKey,
  artifactReference,
  computeArtifactApproval,
  normalizeArtifactMember,
  normalizeArtifactMemberList,
  normalizeArtifactName
} from "../../shared/artifacts";
import { unifiedLineDiff } from "../../shared/artifactDiff";
import type { ArtifactRecord, ArtifactSignatureRecord, ArtifactStore } from "./artifactStore";

export interface ArtifactServiceDeps {
  store: ArtifactStore;
  // Current member set for a chat ("user" + participant handles), or undefined
  // when the conversation does not exist or is not a chat.
  getMembers(conversationId: string): Promise<string[] | undefined>;
  // Post a brief linked note into the chat timeline. Never receives artifact bodies.
  postNote?(conversationId: string, content: string): Promise<void>;
  // Notify the renderer that this chat's artifact list changed.
  onChanged?(conversationId: string): void;
  logger?(event: string, payload: Record<string, unknown>): void;
  now?(): string;
}

interface ArtifactContext {
  conversationId: string;
  actor: string;
  members: string[];
}

function ok<T>(value: T): ArtifactResult<T> {
  return { ok: true, value };
}

function fail<T>(error: ArtifactError): ArtifactResult<T> {
  return { ok: false, error };
}

function invalid<T>(message: string): ArtifactResult<T> {
  return fail<T>({ code: "invalid_request", message });
}

export class ArtifactService {
  // Serializes all artifact mutations per conversation. Combined with the
  // SQL-level expected-head guard in ArtifactStore.appendVersion this makes
  // concurrent revisions of the same base version a deterministic
  // one-winner/one-stale-loser outcome instead of a lost update.
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ArtifactServiceDeps) {}

  async list(actorRaw: string, conversationId: string): Promise<ArtifactResult<ArtifactSummary[]>> {
    const context = await this.requireMember(actorRaw, conversationId);
    if (!context.ok) {
      return context;
    }
    const records = await this.deps.store.listByConversation(conversationId);
    const headSignatures = await this.deps.store.listHeadSignaturesByArtifact(conversationId);
    return ok(records.map((record) => this.summaryFromRecord(record, headSignatures.get(record.id) ?? [])));
  }

  async read(actorRaw: string, request: ReadArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    const context = await this.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const record = resolved.value;
    if (request.version !== undefined && !isVersionNumber(request.version)) {
      return invalid("version must be a positive integer.");
    }
    const version = request.version === undefined ? record.headVersion : Math.floor(request.version);
    const versionRecord = await this.deps.store.getVersion(record.id, version);
    if (!versionRecord) {
      return fail({
        code: "not_found",
        message: `Version ${version} of artifact "${record.name}" does not exist (versions run 1..${record.headVersion}).`
      });
    }
    const signatures = await this.deps.store.listSignatures(record.id);
    const summary = this.summaryFromRecord(record, signatures.filter((signature) => signature.version === record.headVersion));
    const versionContent: ArtifactVersionContent = {
      version: versionRecord.version,
      author: versionRecord.author,
      note: versionRecord.note,
      createdAt: versionRecord.createdAt,
      signatures: signatures
        .filter((signature) => signature.version === versionRecord.version)
        .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt })),
      content: versionRecord.content
    };
    if (!request.includeHistory) {
      return ok({ summary, version: versionContent });
    }
    const metas = await this.deps.store.listVersionMetas(record.id);
    const history: ArtifactVersionMeta[] = metas.map((meta) => ({
      version: meta.version,
      author: meta.author,
      note: meta.note,
      createdAt: meta.createdAt,
      signatures: signatures
        .filter((signature) => signature.version === meta.version)
        .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt }))
    }));
    return ok({ summary, version: versionContent, history });
  }

  async diff(actorRaw: string, request: DiffArtifactRequest): Promise<ArtifactResult<ArtifactDiffResult>> {
    const context = await this.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const record = resolved.value;
    if (!isVersionNumber(request.fromVersion) || !isVersionNumber(request.toVersion)) {
      return invalid("fromVersion and toVersion must be positive integers.");
    }
    const fromVersion = Math.floor(request.fromVersion);
    const toVersion = Math.floor(request.toVersion);
    const [from, to] = await Promise.all([
      this.deps.store.getVersion(record.id, fromVersion),
      this.deps.store.getVersion(record.id, toVersion)
    ]);
    if (!from || !to) {
      const missing = !from ? fromVersion : toVersion;
      return fail({
        code: "not_found",
        message: `Version ${missing} of artifact "${record.name}" does not exist (versions run 1..${record.headVersion}).`
      });
    }
    const headSignatures = (await this.deps.store.listSignatures(record.id))
      .filter((signature) => signature.version === record.headVersion);
    return ok({
      summary: this.summaryFromRecord(record, headSignatures),
      fromVersion,
      toVersion,
      diff: unifiedLineDiff(from.content, to.content, {
        fromLabel: `${record.name} v${fromVersion}`,
        toLabel: `${record.name} v${toVersion}`
      })
    });
  }

  async create(actorRaw: string, request: CreateArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const name = normalizeArtifactName(request.name);
      const nameError = validateName(name);
      if (nameError) {
        return invalid<ArtifactReadResult>(nameError);
      }
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid<ArtifactReadResult>(contentError);
      }
      const contributors = normalizeArtifactMemberList(request.contributors ?? []);
      const requiredSigners = normalizeArtifactMemberList(request.requiredSigners ?? []);
      const memberError = validateMemberSets(members, contributors, requiredSigners);
      if (memberError) {
        return invalid<ArtifactReadResult>(memberError);
      }
      const labelsResult = normalizeLabels(request.labels);
      if (typeof labelsResult === "string") {
        return invalid<ArtifactReadResult>(labelsResult);
      }
      const existing = await this.deps.store.getByName(request.conversationId, artifactNameKey(name));
      if (existing) {
        return fail<ArtifactReadResult>({
          code: "name_taken",
          message: `An artifact named "${existing.name}" already exists in this chat. Names must be unique (case-insensitive); pick another name or revise the existing artifact.`
        });
      }
      const now = this.now();
      const record: ArtifactRecord = {
        id: randomUUID(),
        conversationId: request.conversationId,
        name,
        owner: actor,
        contributors: contributors.filter((member) => member !== actor),
        requiredSigners,
        labels: labelsResult,
        headVersion: 1,
        createdAt: now,
        updatedAt: now
      };
      const note = normalizeNote(request.note);
      await this.deps.store.insertArtifact(record, artifactNameKey(name), {
        artifactId: record.id,
        version: 1,
        content: request.content,
        author: actor,
        note,
        createdAt: now
      });
      this.notifyChanged(request.conversationId);
      await this.postNote(
        request.conversationId,
        `${artifactMemberLabel(actor)} created artifact ${artifactReference(record.id, name)} · v1`
      );
      return this.read(actorRaw, { conversationId: request.conversationId, artifactId: record.id });
    });
  }

  async revise(actorRaw: string, request: ReviseArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      const accessError = this.requireContributor(record, actor, "revise");
      if (accessError) {
        return fail<ArtifactReadResult>(accessError);
      }
      if (!isVersionNumber(request.baseVersion)) {
        return invalid<ArtifactReadResult>("baseVersion must be the version number your edit is based on.");
      }
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid<ArtifactReadResult>(contentError);
      }
      const baseVersion = Math.floor(request.baseVersion);
      if (baseVersion !== record.headVersion) {
        return this.staleVersionError(record, baseVersion);
      }
      const now = this.now();
      const note = normalizeNote(request.note);
      const nextVersion = record.headVersion + 1;
      const accepted = await this.deps.store.appendVersion(
        {
          artifactId: record.id,
          version: nextVersion,
          content: request.content,
          author: actor,
          note,
          createdAt: now
        },
        record.headVersion
      );
      if (!accepted) {
        // Another writer advanced the head between our read and the guarded
        // write (only possible across processes; in-process writes are queued).
        const refreshed = await this.deps.store.getById(record.id);
        return this.staleVersionError(refreshed ?? record, baseVersion);
      }
      this.notifyChanged(request.conversationId);
      await this.postNote(
        request.conversationId,
        `${artifactMemberLabel(actor)} revised ${artifactReference(record.id, record.name)} · v${nextVersion}${note ? ` — ${note}` : ""}`
      );
      return this.read(actorRaw, { conversationId: request.conversationId, artifactId: record.id });
    });
  }

  async rename(actorRaw: string, request: RenameArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      const accessError = this.requireContributor(record, actor, "rename");
      if (accessError) {
        return fail<ArtifactSummary>(accessError);
      }
      const newName = normalizeArtifactName(request.newName);
      const nameError = validateName(newName);
      if (nameError) {
        return invalid<ArtifactSummary>(nameError);
      }
      const newKey = artifactNameKey(newName);
      const existing = await this.deps.store.getByName(request.conversationId, newKey);
      if (existing && existing.id !== record.id) {
        return fail<ArtifactSummary>({
          code: "name_taken",
          message: `An artifact named "${existing.name}" already exists in this chat.`
        });
      }
      if (record.name === newName) {
        return this.summaryResult(record.id);
      }
      const oldName = record.name;
      const now = this.now();
      // Rename is a label change only: no new version, signatures untouched.
      await this.deps.store.updateName(record.id, newName, newKey, now);
      this.notifyChanged(request.conversationId);
      await this.postNote(
        request.conversationId,
        `${artifactMemberLabel(actor)} renamed artifact ${artifactReference(record.id, newName)} (was "${oldName}")`
      );
      return this.summaryResult(record.id);
    });
  }

  async sign(actorRaw: string, request: SignArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      if (!record.requiredSigners.includes(actor)) {
        return fail<ArtifactSummary>({
          code: "access_denied",
          message: `${artifactMemberLabel(actor)} is not in the required-signer set of "${record.name}" (required: ${record.requiredSigners.map(artifactMemberLabel).join(", ") || "none"}).`
        });
      }
      if (request.version !== undefined && !isVersionNumber(request.version)) {
        return invalid<ArtifactSummary>("version must be a positive integer.");
      }
      const version = request.version === undefined ? record.headVersion : Math.floor(request.version);
      const versionRecord = await this.deps.store.getVersion(record.id, version);
      if (!versionRecord) {
        return fail<ArtifactSummary>({
          code: "not_found",
          message: `Version ${version} of artifact "${record.name}" does not exist (versions run 1..${record.headVersion}).`
        });
      }
      const now = this.now();
      const inserted = await this.deps.store.insertSignature({
        artifactId: record.id,
        version,
        signer: actor,
        signedAt: now
      });
      if (inserted) {
        await this.deps.store.touch(record.id, now);
        this.notifyChanged(request.conversationId);
        const summaryAfter = await this.summaryResult(record.id);
        if (summaryAfter.ok && version === record.headVersion) {
          const approvalLabel = artifactApprovalShortLabel(summaryAfter.value.approval);
          await this.postNote(
            request.conversationId,
            `${artifactMemberLabel(actor)} signed ${artifactReference(record.id, record.name)} v${version} (${approvalLabel})`
          );
        } else if (summaryAfter.ok) {
          await this.postNote(
            request.conversationId,
            `${artifactMemberLabel(actor)} signed ${artifactReference(record.id, record.name)} v${version}`
          );
        }
        return summaryAfter;
      }
      return this.summaryResult(record.id);
    });
  }

  async updateAccess(actorRaw: string, request: UpdateArtifactAccessRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      if (record.owner !== actor) {
        return fail<ArtifactSummary>({
          code: "access_denied",
          message: `Only the owner (${artifactMemberLabel(record.owner)}) can manage owner, contributors, or required signers of "${record.name}".`
        });
      }
      const nextOwner = request.owner === undefined ? record.owner : normalizeArtifactMember(request.owner);
      const nextContributors = request.contributors === undefined
        ? record.contributors
        : normalizeArtifactMemberList(request.contributors);
      const nextRequiredSigners = request.requiredSigners === undefined
        ? record.requiredSigners
        : normalizeArtifactMemberList(request.requiredSigners);
      if (!nextOwner) {
        return invalid<ArtifactSummary>("owner must be a chat member.");
      }
      const memberError = validateMemberSets(members, [nextOwner, ...nextContributors], nextRequiredSigners);
      if (memberError) {
        return invalid<ArtifactSummary>(memberError);
      }
      let nextLabels = record.labels;
      if (request.labels !== undefined) {
        const labelsResult = normalizeLabels(request.labels);
        if (typeof labelsResult === "string") {
          return invalid<ArtifactSummary>(labelsResult);
        }
        nextLabels = labelsResult;
      }
      await this.deps.store.updateAccess(
        record.id,
        {
          owner: nextOwner,
          contributors: nextContributors.filter((member) => member !== nextOwner),
          requiredSigners: nextRequiredSigners,
          labels: nextLabels
        },
        this.now()
      );
      this.notifyChanged(request.conversationId);
      return this.summaryResult(record.id);
    });
  }

  // --- internals -----------------------------------------------------------

  private async requireMember(
    actorRaw: string,
    conversationId: string
  ): Promise<ArtifactResult<ArtifactContext>> {
    const actor = normalizeArtifactMember(actorRaw);
    if (!actor) {
      return invalid("Missing acting member.");
    }
    if (!conversationId || typeof conversationId !== "string") {
      return invalid("conversationId is required.");
    }
    const members = await this.deps.getMembers(conversationId);
    if (!members) {
      return fail({ code: "not_found", message: "Chat not found." });
    }
    if (!members.includes(actor)) {
      return fail({
        code: "access_denied",
        message: `${artifactMemberLabel(actor)} is not a member of this chat.`
      });
    }
    return ok({ conversationId, actor, members });
  }

  private async resolveArtifact(
    conversationId: string,
    artifactId: string | undefined,
    name: string | undefined
  ): Promise<ArtifactResult<ArtifactRecord>> {
    const id = typeof artifactId === "string" ? artifactId.trim() : "";
    if (id) {
      const record = await this.deps.store.getById(id);
      if (!record || record.conversationId !== conversationId) {
        return fail({ code: "not_found", message: `No artifact with id ${id} in this chat.` });
      }
      return ok(record);
    }
    const normalizedName = normalizeArtifactName(name ?? "");
    if (!normalizedName) {
      return invalid("Provide artifactId or name.");
    }
    const record = await this.deps.store.getByName(conversationId, artifactNameKey(normalizedName));
    if (!record) {
      return fail({ code: "not_found", message: `No artifact named "${normalizedName}" in this chat.` });
    }
    return ok(record);
  }

  private requireContributor(record: ArtifactRecord, actor: string, action: string): ArtifactError | undefined {
    if (record.owner === actor || record.contributors.includes(actor)) {
      return undefined;
    }
    return {
      code: "access_denied",
      message: `${artifactMemberLabel(actor)} cannot ${action} "${record.name}": only the owner (${artifactMemberLabel(record.owner)}) and contributors (${record.contributors.map(artifactMemberLabel).join(", ") || "none"}) can.`
    };
  }

  private async staleVersionError(record: ArtifactRecord, baseVersion: number): Promise<ArtifactResult<ArtifactReadResult>> {
    const head = await this.deps.store.getVersion(record.id, record.headVersion);
    const signatures = head
      ? (await this.deps.store.listSignatures(record.id)).filter((signature) => signature.version === head.version)
      : [];
    return fail({
      code: "stale_version",
      message: `Your edit was based on v${baseVersion}, but "${record.name}" is now at v${record.headVersion}. Nothing was saved. Re-apply your change on top of the current version and revise again with baseVersion ${record.headVersion}.`,
      currentVersion: record.headVersion,
      current: head
        ? {
            version: head.version,
            author: head.author,
            note: head.note,
            createdAt: head.createdAt,
            signatures: signatures.map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt })),
            content: head.content
          }
        : undefined
    });
  }

  private async summaryResult(artifactId: string): Promise<ArtifactResult<ArtifactSummary>> {
    const record = await this.deps.store.getById(artifactId);
    if (!record) {
      return fail({ code: "not_found", message: "Artifact not found." });
    }
    const headSignatures = (await this.deps.store.listSignatures(record.id))
      .filter((signature) => signature.version === record.headVersion);
    return ok(this.summaryFromRecord(record, headSignatures));
  }

  private summaryFromRecord(record: ArtifactRecord, headSignatures: ArtifactSignatureRecord[]): ArtifactSummary {
    return {
      id: record.id,
      conversationId: record.conversationId,
      name: record.name,
      owner: record.owner,
      contributors: record.contributors,
      labels: record.labels,
      headVersion: record.headVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      approval: computeArtifactApproval(
        record.requiredSigners,
        headSignatures.map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt }))
      )
    };
  }

  private withMutation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.mutationQueues.set(conversationId, next.catch(() => undefined));
    return next;
  }

  private notifyChanged(conversationId: string): void {
    try {
      this.deps.onChanged?.(conversationId);
    } catch (error) {
      this.log("artifacts.on-changed-error", { conversationId, message: errorMessage(error) });
    }
  }

  private async postNote(conversationId: string, content: string): Promise<void> {
    if (!this.deps.postNote) {
      return;
    }
    try {
      await this.deps.postNote(conversationId, content);
    } catch (error) {
      this.log("artifacts.post-note-error", { conversationId, message: errorMessage(error) });
    }
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private log(event: string, payload: Record<string, unknown>): void {
    try {
      this.deps.logger?.(event, payload);
    } catch {
      // Logging must never break artifact operations.
    }
  }
}

function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 1;
}

function validateName(name: string): string | undefined {
  if (!name) {
    return "Artifact name is required.";
  }
  if (name.length > ARTIFACT_NAME_MAX_LENGTH) {
    return `Artifact name must be at most ${ARTIFACT_NAME_MAX_LENGTH} characters.`;
  }
  return undefined;
}

function validateContent(content: unknown): string | undefined {
  if (typeof content !== "string" || content.length === 0) {
    return "Artifact content must be a non-empty string.";
  }
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_CONTENT_MAX_BYTES) {
    return `Artifact content is limited to ${Math.floor(ARTIFACT_CONTENT_MAX_BYTES / 1024)} KB per version.`;
  }
  return undefined;
}

function validateMemberSets(members: string[], contributors: string[], requiredSigners: string[]): string | undefined {
  const memberSet = new Set(members);
  const unknown = [...new Set([...contributors, ...requiredSigners])].filter((member) => !memberSet.has(member));
  if (unknown.length > 0) {
    return `Not current chat members: ${unknown.join(", ")}. Members are "user" and participant handles.`;
  }
  return undefined;
}

function normalizeLabels(raw: string[] | undefined): string[] | string {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return "labels must be an array of short strings.";
  }
  const labels = [...new Set(raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0))];
  if (labels.some((label) => label.length > ARTIFACT_LABEL_MAX_LENGTH)) {
    return `Each label must be at most ${ARTIFACT_LABEL_MAX_LENGTH} characters.`;
  }
  if (labels.length > ARTIFACT_MAX_LABELS) {
    return `At most ${ARTIFACT_MAX_LABELS} labels are allowed.`;
  }
  return labels;
}

function normalizeNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const note = raw.replace(/\s+/g, " ").trim();
  if (!note) {
    return undefined;
  }
  return note.length > ARTIFACT_NOTE_MAX_LENGTH ? `${note.slice(0, ARTIFACT_NOTE_MAX_LENGTH - 1)}…` : note;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
