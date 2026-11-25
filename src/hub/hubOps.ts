import type { HubDevice } from "../shared/hubProtocol";
import type {
  HubArtifactResponse, HubArtifactRevisionResponse, HubArtifactsResponse, HubChatPage, HubCard, HubChatsResponse, HubFeedResponse,
  HubOpsResponse, HubTurn
} from "../shared/hubOps";
import type { ChatMessage } from "../shared/types";
import type { HubOpApplied } from "./hubOps/types";
import { HubArtifacts } from "./hubArtifacts";
import type { StorageService } from "../main/services/storage";
import { createHubOpsModules, type HubOpsModules } from "./hubOps/modules";

export { SERVER_MESSAGE_KEYS, HUB_SERVER_WRITER, HUB_MEMBER_RULES_DOCUMENT } from "./hubOps/constants";
export { type HubOpApplied, HubOpsRequestError } from "./hubOps/types";
export { homeDeviceId } from "./hubOps/chatRecords";

/**
 * The server as the owner of every chat (Д1). Applies devices' operations one
 * at a time, in the order they arrive, by rules that are the same for every
 * device (Д2), and keeps what it accepted as the feed every device reads.
 */
export class HubOps {
  private readonly modules: HubOpsModules;

  readonly artifacts: HubArtifacts;

  constructor(
    storage: StorageService,
    log: (event: string, payload: Record<string, unknown>) => void = () => undefined,
    now: () => Date = () => new Date()
  ) {
    this.artifacts = new HubArtifacts(storage, log, now);
    this.modules = createHubOpsModules({ storage, log, now, artifacts: this.artifacts });
  }

  memberRulesChanged(): void {
    this.modules.memberRules.memberRulesChanged();
  }

  onApplied(listener: (applied: HubOpApplied) => void): void {
    this.modules.feed.onApplied(listener);
  }

  head(): Promise<number> {
    return this.modules.feed.head();
  }

  /** Applies a device's operations in order and answers each one. */
  apply(device: HubDevice, raw: unknown): Promise<HubOpsResponse> {
    return this.modules.operations.apply(device, raw);
  }

  /**
   * A message the server writes itself: an urgent alert's card, created or
   * changed as the alert moves on (with no device online). Placed in the
   * same order as devices' operations and fed to every device; only an
   * alert card, and only one the server wrote, can be changed this way.
   */
  writeServerMessage(conversationId: string, message: ChatMessage): Promise<{ seq: number } | { refused: string }> {
    return this.modules.operations.writeServerMessage(conversationId, message);
  }

  /** Cards not settled yet. */
  openCards(conversationId?: string): Promise<HubCard[]> {
    return this.modules.cards.openCards(conversationId);
  }

  /** Turns asked of this device's members that nobody took yet: what a
   *  computer or machine runs after it was off. */
  waitingTurns(device: HubDevice): Promise<HubTurn[]> {
    return this.modules.turns.waitingTurns(device);
  }

  /** Turns this device took and never finished: what it closes after it
   *  stopped or restarted in the middle of them. */
  claimedTurns(device: HubDevice): Promise<HubTurn[]> {
    return this.modules.turns.claimedTurns(device);
  }

  // --- reading -------------------------------------------------------------

  /** What was accepted after `after`, waiting up to `waitMs` for something
   *  new. `gone` when the feed no longer holds what comes right after it. */
  feed(after: number, waitMs: number, closed?: Promise<void>, deviceId?: string): Promise<HubFeedResponse | { gone: true; head: number }> {
    return this.modules.feed.feed(after, waitMs, closed, deviceId);
  }

  /** A chat's documents, as one consistent reading (between operations). */
  artifactStates(conversationId: string): Promise<HubArtifactsResponse> {
    return this.modules.artifactViews.artifactStates(conversationId);
  }

  /** One document whole, without revision bodies; none when the server has
   *  no such document. */
  artifactState(artifactId: string): Promise<HubArtifactResponse> {
    return this.modules.artifactViews.artifactState(artifactId);
  }

  /** One revision's body; none when the server has no such revision. */
  artifactRevision(artifactId: string, versionEventId: string): Promise<HubArtifactRevisionResponse> {
    return this.modules.artifactViews.artifactRevision(artifactId, versionEventId);
  }

  chats(): Promise<HubChatsResponse> {
    return this.modules.chatPages.chats();
  }

  chatPage(conversationId: string, before?: string): Promise<HubChatPage> {
    return this.modules.chatPages.chatPage(conversationId, before);
  }

  /** Feed readers waiting now (the server's status). */
  waiting(): number {
    return this.modules.feed.waiting();
  }
}
