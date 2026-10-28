import { ArtifactService, type ArtifactCommittedChange } from "../main/services/artifacts";
import { ArtifactStore } from "../main/services/artifactStore";
import { CommandError } from "../main/services/command";
import type { StorageService } from "../main/services/storage";
import { artifactMembersForConversation, normalizeArtifactMember } from "../shared/artifacts";
import type { HubDevice } from "../shared/hubProtocol";
import type {
  HubArtifactAnswer,
  HubArtifactOpKind,
  HubArtifactRevision,
  HubArtifactState,
  HubFeedEntry,
  HubOp,
  HubOpEffect,
  HubOpResult
} from "../shared/hubOps";
import {
  ARTIFACT_USER_MEMBER,
  type ArtifactError,
  type ArtifactResult,
  type ChatParticipant,
  type Conversation,
  type CreateArtifactRequest,
  type PublishArtifactRequest,
  type RenameArtifactRequest,
  type ReplaceArtifactDraftRequest,
  type ReviseArtifactRequest,
  type SaveArtifactDraftRequest,
  type SetArtifactArchivedRequest,
  type SignArtifactRequest,
  type SubmitArtifactDraftRequest,
  type UpdateArtifactAccessRequest,
  type UpdateArtifactDraftRosterRequest,
  type WithdrawArtifactDraftRequest
} from "../shared/types";

type ArtifactOp = Extract<HubOp, { kind: HubArtifactOpKind }>;
type ImportOp = Extract<HubOp, { kind: "artifact.import" }>;

/** Where an operation goes in the server's order, and who sent it. */
interface Place {
  opId: string;
  seq: number;
  acceptedAt: string;
  deviceId: string;
  conversationId: string;
  kind: HubArtifactOpKind;
}

/** The action being decided, and what its commit placed. */
type Deciding = Place & { change?: ArtifactCommittedChange; effect?: HubOpEffect };

export interface HubArtifactOutcome {
  result: HubOpResult;
  /** Present when the operation changed a document (it is in the feed). */
  entry?: HubFeedEntry;
}

/**
 * The User's server as the owner of every chat's documents (agreements Д1,
 * Д9): it decides each document action by the rules a device applied before
 * (ArtifactService, unchanged), over its own copy, the only one. A change
 * and its place in the server's order commit together, so every device
 * learns of every change and of nothing that did not happen. Devices read
 * documents back whole (`state`, `states`, `revision`) and keep a copy.
 *
 * The server applies operations one at a time (HubOps), so at most one
 * document action is being decided here at any moment.
 */
export class HubArtifacts {
  readonly store: ArtifactStore;
  private readonly rules: ArtifactService;
  /** The action being decided now, and what its commit placed. */
  private current?: Deciding;

  constructor(
    private readonly storage: StorageService,
    private readonly log: (event: string, payload: Record<string, unknown>) => void,
    private readonly now: () => Date
  ) {
    const database = storage.sqlExecutor();
    this.store = new ArtifactStore(database.path, "sqlite3", database);
    this.rules = new ArtifactService({
      store: this.store,
      getMembers: async (conversationId) => {
        const conversation = await this.chat(conversationId);
        return conversation ? artifactMembersForConversation(conversation) : undefined;
      },
      now: () => this.now().toISOString(),
      logger: (event, payload) => this.log(event, payload),
      commitWithChange: (change, write) => this.commitWithChange(change, write)
    });
  }

  init(): Promise<void> {
    return this.store.init();
  }

  /** A chat's fields and members, without its messages. */
  private async chat(conversationId: string): Promise<Conversation | undefined> {
    const opened = await this.storage.openConversation(conversationId, 1);
    return opened?.conversation.kind === "chat" ? opened.conversation : undefined;
  }

  /**
   * Decides one document action. `home` names the device a member of a chat
   * runs on. Who may act: the User from her own devices (never a machine),
   * a member only from the device it runs on (Д4); the rest is the rules'.
   */
  async apply(
    device: HubDevice,
    op: ArtifactOp,
    place: { opId: string; seq: number; acceptedAt: string },
    home: (conversation: Conversation, participantId: string) => string | undefined
  ): Promise<HubArtifactOutcome> {
    const { opId, seq } = place;
    await this.init();
    const refusal = await this.mayAct(device, op, home);
    if (refusal) return { result: { opId, status: "rejected", reason: refusal.message, artifact: { result: { ok: false, error: refusal } } } };
    this.current = { ...place, deviceId: device.deviceId, conversationId: op.conversationId, kind: op.kind };
    let answer: ArtifactResult<unknown>;
    let decided: Deciding | undefined;
    try {
      answer = await this.decide(op);
    } catch (error) {
      // A failure to store is not the action's fault: the device sends it
      // again (nothing was placed). Anything else is the action's own
      // problem and is answered, so it never blocks what comes after it.
      if (error instanceof CommandError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.log("hub.artifact.failed", { opId, kind: op.kind, conversationId: op.conversationId, message });
      const failed: ArtifactError = { code: "invalid_request", message: `The server could not apply this document action: ${message}` };
      return { result: { opId, status: "rejected", reason: failed.message, artifact: { result: { ok: false, error: failed } } } };
    } finally {
      decided = this.current;
      this.current = undefined;
    }
    const ops = this.storage.hubOps();
    const placed = (await ops.accepted([opId])).get(opId);
    if (placed && decided?.change && decided.effect) {
      const artifact: HubArtifactAnswer = {
        artifactId: decided.change.artifactId,
        ...(decided.change.draftId ? { draftId: decided.change.draftId } : {}),
        result: answer
      };
      const result: HubOpResult = { opId, status: "accepted", seq: placed.seq, artifact };
      // Kept with the operation for a device that sends it again (the
      // operation itself was placed with its change).
      await ops.setResult(opId, result).catch((error: unknown) => {
        this.log("hub.artifact.answer-not-kept", { opId, message: error instanceof Error ? error.message : String(error) });
      });
      const entry: HubFeedEntry = { seq: placed.seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt: place.acceptedAt,
        effect: decided.effect };
      return { result, entry };
    }
    // Nothing changed: the same answer the rules gave, with nothing placed
    // (asking again is asking the rules again).
    if (answer.ok) {
      return { result: { opId, status: "accepted", seq: seq - 1, artifact: { ...answerIds(answer.value), result: answer } } };
    }
    return { result: { opId, status: "rejected", reason: answer.error.message, artifact: { result: answer } } };
  }

  private async mayAct(device: HubDevice, op: ArtifactOp, home: (conversation: Conversation, participantId: string) => string | undefined): Promise<ArtifactError | undefined> {
    const actor = normalizeArtifactMember(op.actor);
    if (actor === ARTIFACT_USER_MEMBER) {
      return device.role === "machine"
        ? { code: "access_denied", message: "A machine acts only for the members that run on it, never as the User." }
        : undefined;
    }
    const conversation = await this.chat(op.conversationId);
    // A chat or member the server does not know: the rules say so.
    if (!conversation) return undefined;
    const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as ChatParticipant[] : [];
    const participant = participants.find((item) => normalizeArtifactMember(item?.handle) === actor);
    if (!participant) return undefined;
    if (home(conversation, participant.id) !== device.deviceId) {
      return { code: "access_denied", message: `@${actor} runs on another device; only that device acts for @${actor}.` };
    }
    return undefined;
  }

  private decide(op: ArtifactOp): Promise<ArtifactResult<unknown>> {
    const request = op.request;
    const actor = op.actor;
    switch (op.kind) {
      case "artifact.create": return this.rules.create(actor, request as unknown as CreateArtifactRequest);
      case "artifact.revise": return this.rules.revise(actor, request as unknown as ReviseArtifactRequest);
      case "artifact.rename": return this.rules.rename(actor, request as unknown as RenameArtifactRequest);
      case "artifact.sign": return this.rules.sign(actor, request as unknown as SignArtifactRequest);
      case "artifact.access": return this.rules.updateAccess(actor, request as unknown as UpdateArtifactAccessRequest);
      case "artifact.archive": return this.rules.setArchived(actor, request as unknown as SetArtifactArchivedRequest);
      case "artifact.draft.save": return this.rules.saveDraft(actor, request as unknown as SaveArtifactDraftRequest);
      case "artifact.draft.submit": return this.rules.submitDraft(actor, request as unknown as SubmitArtifactDraftRequest);
      case "artifact.draft.replace": return this.rules.replaceDraft(actor, request as unknown as ReplaceArtifactDraftRequest);
      case "artifact.draft.withdraw": return this.rules.withdrawDraft(actor, request as unknown as WithdrawArtifactDraftRequest);
      case "artifact.roster": return this.rules.updateDraftRoster(actor, request as unknown as UpdateArtifactDraftRosterRequest);
      case "artifact.publish": return this.rules.publish(actor, request as unknown as PublishArtifactRequest);
    }
  }

  /**
   * Called by the rules inside the commit that changes a document: the same
   * commit places the action in the server's order, but only when the change
   * really happened (the rules' own condition, and for a change that posts a
   * chat note, that its note was written in this very commit). The note moves
   * from the outbox into the feed entry, where the acting device takes it.
   */
  private commitWithChange<T>(
    change: ArtifactCommittedChange,
    write: (statement: { sql: string; onlyIfSql: (condition: string) => string }) => Promise<T>
  ): Promise<T> {
    const current = this.current;
    if (!current) throw new Error("A document changed outside an operation on the server.");
    if (current.change) throw new Error("A document action commits once.");
    const effect: HubOpEffect = {
      kind: current.kind,
      artifactId: change.artifactId,
      ...(change.event ? { note: { eventId: change.event.id, content: change.event.content } } : {})
    };
    current.change = change;
    current.effect = effect;
    const result: HubOpResult = { opId: current.opId, status: "accepted", seq: current.seq,
      artifact: { artifactId: change.artifactId, ...(change.draftId ? { draftId: change.draftId } : {}) } };
    const ops = this.storage.hubOps();
    const entry = { seq: current.seq, opId: current.opId, deviceId: current.deviceId, conversationId: current.conversationId, kind: current.kind,
      effect, result, acceptedAt: current.acceptedAt };
    const noted = change.event ? `exists(select 1 from artifact_event_outbox where id = ${sqlText(change.event.id)})` : undefined;
    const taken = change.event ? `delete from artifact_event_outbox where id = ${sqlText(change.event.id)};` : "";
    return write({
      sql: `${ops.insertSql(entry, noted)} ${taken}`,
      onlyIfSql: (condition) => `${ops.insertSql(entry, noted ? `(${condition}) and ${noted}` : condition)} ${taken}`
    });
  }

  /**
   * A page of a chat's documents moved from the computer (one time). Kept
   * as they were; what the server holds already stays. Placed in the order
   * (every device reads these documents again) in the same commit.
   */
  async import(device: HubDevice, op: ImportOp, place: { opId: string; seq: number; acceptedAt: string }): Promise<HubArtifactOutcome> {
    const { opId, seq, acceptedAt } = place;
    if (device.role !== "owner") return { result: { opId, status: "rejected", reason: "Only the computer that held the documents moves them to the server." } };
    if (!await this.chat(op.conversationId)) return { result: { opId, status: "rejected", reason: "There is no such chat." } };
    await this.init();
    const built = await this.store.importSql(op.conversationId, op.rows);
    if (built.refused.length) this.log("hub.artifact.import-refused", { opId, conversationId: op.conversationId, refused: built.refused.slice(0, 20) });
    const answer: HubArtifactAnswer = { result: { ok: true, value: { artifactIds: built.artifactIds, refused: built.refused } } };
    if (built.artifactIds.length === 0) return { result: { opId, status: "accepted", seq: seq - 1, artifact: answer } };
    const effect: HubOpEffect = { kind: "artifact.import", artifactIds: built.artifactIds };
    const result: HubOpResult = { opId, status: "accepted", seq, artifact: answer };
    const entry: HubFeedEntry = { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect };
    await this.store.commitSql(`${built.sql}\n${this.storage.hubOps().insertSql({ ...entry, kind: "artifact.import", result })}`);
    return { result, entry };
  }

  /** The statements that delete a chat's documents with the chat. */
  async deletionSql(conversationId: string, deletedAt: string): Promise<string> {
    await this.init();
    return this.store.deleteByConversationSql(conversationId, deletedAt);
  }

  // --- reading ---------------------------------------------------------------

  state(artifactId: string): Promise<HubArtifactState | undefined> {
    return this.store.serverState(artifactId);
  }

  states(conversationId: string): Promise<HubArtifactState[]> {
    return this.store.serverStates(conversationId);
  }

  revision(artifactId: string, versionEventId: string): Promise<HubArtifactRevision | undefined> {
    return this.store.revisionWithContent(artifactId, versionEventId);
  }
}

/** The document (and draft) an answer is about, from the answer itself. */
function answerIds(value: unknown): { artifactId?: string; draftId?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as { summary?: { id?: unknown }; id?: unknown; artifactId?: unknown };
  const artifactId = typeof record.summary?.id === "string" ? record.summary.id
    : typeof record.artifactId === "string" ? record.artifactId
      : typeof record.id === "string" ? record.id : undefined;
  const draftId = typeof record.artifactId === "string" && typeof record.id === "string" ? record.id : undefined;
  return { ...(artifactId ? { artifactId } : {}), ...(draftId ? { draftId } : {}) };
}

function sqlText(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}
