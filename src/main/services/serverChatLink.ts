import { HubClient, HubHttpError } from "./hubClient";
import { HubOpsClient, HUB_FEED_CURSOR_KEY, type HubOpOutcome } from "./hubOpsClient";
import { conversationFieldsOf, newOpId, type ChatServerLink } from "./chatServerOps";
import { LOCAL_MESSAGE_METADATA_KEYS } from "./chatChanges";
import type { HubSigningIdentity } from "./hubAuth";
import type { StorageService } from "./storage";
import type { ChatService } from "./chat";
import type { ArtifactClient, ArtifactServerLink, ArtifactWriteOutcome } from "./artifactClient";
import { HUB_OP_MAX_BYTES, type HubArtifactImportRows, type HubFeedEntry, type HubOp, type HubTurn } from "../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../shared/types";

/** Messages in one page of a chat moving to the server (well under the
 *  server's limit for one operation). */
const IMPORT_PAGE_BYTES = Math.floor(HUB_OP_MAX_BYTES * 0.8);
const IMPORT_PAGE_MESSAGES = 200;
/** A document action a request is already carrying when its writer stops
 *  waiting gets this much longer for that request's answer. */
const ARTIFACT_IN_FLIGHT_WAIT_MS = 10_000;
/** A machine looks this often whether it has read the server yet, before it
 *  drops what it kept for the old order. */
const LEGACY_DROP_CHECK_MS = 30_000;

/**
 * The computer's (or a machine's) link to the User's server, which owns every
 * chat (agreements Д1–Д13): its own server when she has one, otherwise the same
 * server run inside the app (Д6). Saves become operations sent in order; what
 * the server accepted comes back from its feed; members' turns wait for it.
 * The first time, the computer moves its chats to the server (5.7).
 */
export class ServerChatLink {
  private client?: HubClient;
  private ops?: HubOpsClient;
  private embedded?: { url: string; close(): Promise<void> };
  /** Writes and reads wait until the chats were moved (the first time). */
  private ready = false;
  private deviceIdValue = "";
  private machineNames = new Map<string, string>();
  private starting?: Promise<void>;
  private unreachable?: number;
  /** Chats whose documents this computer could not move yet (the server
   *  refused a page): its copy of them is kept, never replaced by the
   *  server's, until they move. */
  private readonly pendingArtifactMoves = new Set<string>();
  /** The computer has not yet read which of its chats' documents are on the
   *  server: until it has, no chat's documents are replaced by the server's. */
  private artifactMovesUnknown = false;
  /** Documents moved or read again later, after a first try failed. */
  private documentsRetry?: Promise<void>;
  /** The one-time drop of what this device kept for the old order of signed
   *  events, under way (stopped by stop()). */
  private legacyDrop?: { abort: AbortController; done: Promise<void> };

  constructor(private readonly options: {
    storage: StorageService;
    chat: ChatService;
    identity: () => Promise<HubSigningIdentity & { publicKeyDerBase64: string }>;
    /** The User's own server, when she set one up. */
    hubConfig: () => Promise<{ url: string } | undefined>;
    /** The server inside the app, started when she has no server of her own
     *  (the computer only; a machine always has hers). */
    startEmbedded?: (owner: { deviceId: string; publicKeyDerBase64: string }) => Promise<{ url: string; close(): Promise<void> }>;
    machineNames: () => Promise<Array<{ id: string; name: string }>>;
    /** Whether this device moves its chats to the server (the computer, not a machine). */
    movesChats: boolean;
    /** This device's documents: written through the server, its copy kept
     *  from the server's feed (and moved there with the chats, one time). */
    artifacts?: ArtifactClient;
    log: (event: string, payload: Record<string, unknown>) => void;
  }) {}

  /** The link as documents use it. */
  private artifactLink(): ArtifactServerLink {
    return {
      deviceId: () => this.deviceIdValue,
      write: (op, waitMs) => this.writeArtifact(op, waitMs),
      applied: async (seq, timeoutMs) => this.ops ? this.ops.waitApplied(seq, timeoutMs) : false,
      conversationArtifacts: async (conversationId) => (await this.requireClient().artifacts(conversationId)).artifacts,
      // A document the server does not have is said so in an answer; a
      // request that failed (a server without this route answers 404) is an
      // error, tried again, and never taken to mean the document is gone.
      artifact: async (artifactId) => (await this.requireClient().artifact(artifactId)).artifact,
      revision: async (artifactId, versionEventId) => (await this.requireClient().artifactRevision(artifactId, versionEventId)).revision
    };
  }

  private requireClient(): HubClient {
    if (!this.client) throw new Error("This device is not linked to a server.");
    return this.client;
  }

  /**
   * One document action: queued in order with this device's other writes
   * and sent; its answer is awaited up to `waitMs`. Then it is taken back if
   * nothing sent it yet, or given a little longer if a request carries it;
   * an action taken back is never sent later (Д13: a change is shown done
   * only when the server took it).
   */
  private async writeArtifact(op: HubOp, waitMs: number): Promise<ArtifactWriteOutcome> {
    const first = this.requireOps();
    await first.enqueue([op]);
    const answer = await answerWithin(first, op.opId, waitMs);
    if (answer) return answer;
    for (let round = 0; round < 2; round += 1) {
      const ops = this.ops;
      if (!ops) break;
      const taken = await ops.withdraw(op.opId);
      if (taken.status === "answered") return taken.outcome;
      if (taken.status === "withdrawn") return { status: "unconfirmed", reason: await this.unconfirmedReason(taken.attempted) };
      if (taken.status === "missing") break;
      const late = await answerWithin(ops, op.opId, ARTIFACT_IN_FLIGHT_WAIT_MS);
      if (late) return late;
    }
    return { status: "unconfirmed", reason: await this.unconfirmedReason(true) };
  }

  private async unconfirmedReason(attempted: boolean): Promise<string> {
    const status = await this.ops?.status().catch(() => undefined);
    const why = status?.lastError ? ` (${status.lastError})` : "";
    if (attempted) {
      return `Your server did not confirm this change${why}. It may still have reached it: read the document again before trying again.`;
    }
    if (!this.ready) {
      return "Your server is not ready on this device yet (chats and documents are still moving to it), so nothing was changed. Try again in a minute.";
    }
    return `Your server could not be reached${why}, so nothing was changed. Try again when it is back.`;
  }

  /** The link as ChatService uses it. */
  private chatLink(): ChatServerLink {
    return {
      deviceId: () => this.deviceIdValue,
      queueSql: (ops, condition) => this.requireOps().queueSql(ops, condition),
      enqueue: (ops) => this.requireOps().enqueue(ops),
      nudge: () => this.ops?.nudge(),
      messageAccepted: async (conversationId, messageId, signal) => {
        const row = await this.options.storage.hubClientOps().forMessage(conversationId, messageId);
        if (!row) return undefined;
        const outcome = await this.requireOps().waitFor(row.opId, signal);
        return outcome.status === "accepted" ? { status: "accepted", seq: outcome.seq } : outcome;
      },
      opAnswered: (opId, signal) => this.requireOps().waitFor(opId, signal),
      waitingTurns: async () => {
        if (!this.ready || !this.client) return { requested: [], claimed: [] };
        const answer = await this.client.waitingTurns();
        // A turn whose end this device wrote and has not sent yet (it stopped
        // right after) is not one it left behind.
        const claimed: HubTurn[] = [];
        for (const turn of answer.claimed ?? []) {
          const queued = await this.options.storage.hubClientOps().forConversation(turn.conversationId);
          if (!queued.some((row) => row.op.kind === "turn.finish" && row.op.runId === turn.runId)) claimed.push(turn);
        }
        return { requested: answer.turns, claimed };
      },
      machineName: (machineId) => this.machineNames.get(machineId),
      settleMoved: (conversationId) => this.requireOps().settleMoved(conversationId),
      openCards: async () => {
        if (!this.ready || !this.client) return undefined;
        return this.client.openCards();
      },
      readThrough: async (seq, timeoutMs) => this.ops ? this.ops.waitApplied(seq, timeoutMs) : false,
      cardSettleQueued: async (conversationId, cardId) => (await this.options.storage.hubClientOps().forConversation(conversationId))
        .some((row) => row.op.kind === "card.settle" && row.op.cardId === cardId)
    };
  }

  private requireOps(): HubOpsClient {
    if (!this.ops) throw new Error("This device is not linked to a server.");
    return this.ops;
  }

  start(): Promise<void> {
    this.starting ??= this.startNow().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startNow(): Promise<void> {
    this.artifactMovesUnknown = this.options.movesChats && Boolean(this.options.artifacts);
    const identity = await this.options.identity();
    this.deviceIdValue = (identity as { originId?: string }).originId ?? "";
    await this.refreshMachineNames();
    const own = await this.options.hubConfig();
    let url = own?.url;
    if (!url) {
      if (!this.options.startEmbedded) throw new Error("This device has no server to link to.");
      this.embedded ??= await this.options.startEmbedded({ deviceId: this.deviceIdValue, publicKeyDerBase64: identity.publicKeyDerBase64 });
      url = this.embedded.url;
    }
    const client = new HubClient({ url, identity: this.options.identity });
    this.client = client;
    const hub = this.options.storage.hub();
    this.ops = new HubOpsClient({
      store: this.options.storage.hubClientOps(),
      cursor: { get: () => hub.clientState(HUB_FEED_CURSOR_KEY), set: (value) => hub.setClientState(HUB_FEED_CURSOR_KEY, value) },
      client: () => this.ready ? this.client : undefined,
      apply: (entries: HubFeedEntry[]) => this.applyEntries(entries),
      resync: () => this.resync(),
      onAnswered: (row, outcome: HubOpOutcome) => {
        if (outcome.status === "rejected") this.options.log("chat.server.op-rejected", { opId: row.opId, kind: row.kind, conversationId: row.conversationId, reason: outcome.reason });
        // A User's message the server refused says so, with its reason (Д3).
        if (outcome.status === "rejected" && row.kind === "message.create" && row.messageId) {
          void this.options.chat.markMessageRefused(row.conversationId, row.messageId, outcome.reason).catch(() => undefined);
        }
        this.options.chat.noteServerOpAnswered(row.op, outcome);
      },
      log: this.options.log
    });
    // A document action left queued by a run of this device that ended has
    // nobody waiting for its answer: it is never sent (Д13).
    const stale = await this.options.storage.hubClientOps().withdrawKinds("artifact.").catch(() => 0);
    if (stale) this.options.log("artifact.server.withdrawn-at-start", { ops: stale });
    // Installed before the move, so nothing written meanwhile is lost: it is
    // queued here and sent once the chats are on the server.
    this.options.chat.setServerLink(this.chatLink());
    this.options.chat.setServerChatReader((conversationId) => this.readChat(conversationId));
    this.options.artifacts?.setServerLink(this.artifactLink());
    const ops = this.ops;
    ops.onStatusChanged(() => {
      void ops.status().then((status) => {
        const back = this.unreachable !== undefined && status.unreachableSince === undefined;
        this.unreachable = status.unreachableSince;
        // Back after the server could not be reached: cards answered
        // meanwhile are applied, and cards raised meanwhile go up.
        if (back && this.ready) {
          void this.options.chat.resumeServerCards({ messages: false }).catch((error) => {
            this.options.log("chat.server.cards-resume-error", { message: error instanceof Error ? error.message : String(error) });
          });
        }
      });
    });
    this.ops.start();
    this.options.log("chat.server.link-started", { embedded: !own, url: own ? url : "loopback" });
    void this.prepare(client).catch((error) => {
      this.options.log("chat.server.prepare-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Moves the chats (once), then lets writes and the feed through. */
  private async prepare(client: HubClient): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (this.options.movesChats) await this.moveChats(client);
        break;
      } catch (error) {
        this.options.log("chat.server.move-failed", { attempt, message: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt))));
      }
    }
    // Documents are moved (the computer) and read (every device) before
    // writes and the feed go through. A failure here (a lost connection, a
    // server not updated yet) never holds the chats back: it is tried again
    // in the background, and documents not moved meanwhile stay here as they
    // are, never replaced by the server's copy.
    const prepared = await this.prepareDocuments(client).catch((error) => {
      this.options.log("artifact.server.prepare-failed", { message: error instanceof Error ? error.message : String(error) });
      return false;
    });
    if (!prepared) this.retryDocuments(client);
    this.ready = true;
    this.ops?.nudge();
    this.ops?.wakeReader();
    this.dropLegacyTables();
    await this.options.chat.resumeServerTurns().catch((error) => {
      this.options.log("chat.server.resume-error", { message: error instanceof Error ? error.message : String(error) });
    });
    await this.options.chat.resumeServerCards().catch((error) => {
      this.options.log("chat.server.cards-resume-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    const legacy = this.legacyDrop;
    legacy?.abort.abort();
    await legacy?.done;
    await this.ops?.stop();
    this.options.chat.setServerLink(undefined);
    this.options.chat.setServerChatReader(undefined);
    this.options.artifacts?.setServerLink(undefined);
    this.ops = undefined;
    this.client = undefined;
    await this.embedded?.close();
    this.embedded = undefined;
  }

  /**
   * What this device kept for the order of signed events before the User's
   * server owned the chats (agreement Д7) goes, once, in the background: on
   * the computer once its chats are on the server (the move above finished),
   * on a machine once it has read the server (its place in the feed is
   * kept). Nothing reads any of it any more; a stop interrupts it and the
   * next start carries on.
   */
  private dropLegacyTables(): void {
    if (this.legacyDrop) return;
    const abort = new AbortController();
    const hub = this.options.storage.hub();
    const done = (async () => {
      while (!abort.signal.aborted && !this.options.movesChats && await hub.clientState(HUB_FEED_CURSOR_KEY) === undefined) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LEGACY_DROP_CHECK_MS);
          timer.unref?.();
          abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      if (abort.signal.aborted) return;
      await this.options.storage.dropLegacyEventTables({ keepBodies: false, signal: abort.signal, log: this.options.log });
    })().catch((error: unknown) => {
      this.options.log("storage.legacy-tables.error", { message: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (this.legacyDrop?.abort === abort) this.legacyDrop = undefined;
    });
    this.legacyDrop = { abort, done };
  }

  async refreshMachineNames(): Promise<void> {
    this.machineNames = new Map((await this.options.machineNames()).map((machine) => [machine.id, machine.name]));
  }

  /** Whether writes reach the server now (undefined: not linked). */
  reachable(): boolean | undefined {
    if (!this.ops) return undefined;
    return this.unreachable === undefined;
  }

  async status(): Promise<{ queued: number; unreachableSince?: number; lastError?: string; ready: boolean } | undefined> {
    if (!this.ops) return undefined;
    return { ...await this.ops.status(), ready: this.ready };
  }

  async failures(): Promise<ReturnType<ReturnType<StorageService["hubClientOps"]>["failures"]>> {
    return this.options.storage.hubClientOps().failures();
  }

  /** A chat whole, as the server holds it. */
  private async readChat(conversationId: string): Promise<{ conversation: Conversation; turns: HubTurn[] } | undefined> {
    const client = this.client;
    if (!client) return undefined;
    let page;
    try {
      page = await client.chatPage(conversationId);
    } catch (error) {
      if (error instanceof HubHttpError && error.status === 404) return undefined;
      throw error;
    }
    const messages: ChatMessage[] = [...page.messages];
    const turns: HubTurn[] = [...page.turns];
    while (page.more && messages.length > 0) {
      page = await client.chatPage(conversationId, messages[0].id);
      messages.unshift(...page.messages);
      turns.push(...page.turns);
    }
    return {
      conversation: {
        id: conversationId,
        title: page.conversation.title,
        kind: "chat",
        createdAt: page.conversation.createdAt,
        updatedAt: page.conversation.updatedAt,
        ...(page.conversation.repoPath ? { repoPath: page.conversation.repoPath } : {}),
        messages,
        findings: [],
        metadata: { participantSessions: [], warnings: [], running: false, ...page.conversation.metadata } as Conversation["metadata"]
      },
      turns
    };
  }

  /** The feed forgot this device's place: every chat is read again. */
  private async resync(): Promise<number> {
    const client = this.client;
    if (!client) throw new Error("Not linked.");
    const { chats, head } = await client.chats();
    const onServer = new Set(chats.map((chat) => chat.id));
    for (const chat of chats) await this.options.chat.reloadChatFromServer(chat.id);
    // A chat this device holds that the server no longer has (deleted while
    // this device was away), unless this device created it and has not sent it.
    for (const summary of await this.options.storage.listConversations()) {
      if (summary.kind !== "chat" || onServer.has(summary.id)) continue;
      const queued = await this.options.storage.hubClientOps().forConversation(summary.id);
      if (!queued.some((row) => row.kind === "conversation.create" && row.status === "queued")) await this.options.chat.reloadChatFromServer(summary.id);
    }
    // Every chat's documents as the server holds them.
    await this.reloadArtifacts(chats.map((chat) => chat.id));
    this.options.log("chat.server.resynced", { chats: chats.length, head });
    // Cards changed while this device's place was forgotten: read them again
    // (once the feed continues from `head`).
    setTimeout(() => {
      void this.options.chat.resumeServerCards().catch((error) => {
        this.options.log("chat.server.cards-resume-error", { message: error instanceof Error ? error.message : String(error) });
      });
    }, 0).unref?.();
    return head;
  }

  /** What the server accepted: documents to their copy, the rest to the chats. */
  private async applyEntries(entries: HubFeedEntry[]): Promise<void> {
    const documents = entries.filter((entry) => entry.effect.kind.startsWith("artifact."));
    const chats = documents.length ? entries.filter((entry) => !entry.effect.kind.startsWith("artifact.")) : entries;
    if (chats.length) await this.options.chat.applyServerEntries(chats);
    if (documents.length) await this.options.artifacts?.applyServerEntries(documents);
  }

  /** This device's copy of these chats' documents becomes the server's
   *  (except chats whose documents this computer has not moved yet). */
  private async reloadArtifacts(conversationIds: string[]): Promise<void> {
    const documents = this.options.artifacts;
    if (!documents || this.artifactMovesUnknown) return;
    for (const conversationId of conversationIds) {
      if (this.pendingArtifactMoves.has(conversationId)) continue;
      await documents.reloadConversation(conversationId);
    }
  }

  /** Moves (the computer) and reads this device's documents; false while
   *  some chat's documents could not move yet (they are tried again). */
  private async prepareDocuments(client: HubClient): Promise<boolean> {
    if (!this.options.artifacts) return true;
    const moved = this.options.movesChats ? await this.moveDocuments(client, this.options.artifacts) : true;
    await this.syncArtifactsOnce(client);
    return moved;
  }

  private retryDocuments(client: HubClient): void {
    if (this.documentsRetry) return;
    this.documentsRetry = (async () => {
      for (let attempt = 1; this.client === client; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt))).unref?.());
        if (this.client !== client) return;
        try {
          if (await this.prepareDocuments(client)) {
            this.options.log("artifact.server.prepared", { attempt });
            return;
          }
        } catch (error) {
          this.options.log("artifact.server.prepare-failed", { attempt, message: error instanceof Error ? error.message : String(error) });
        }
      }
    })().finally(() => { this.documentsRetry = undefined; });
  }

  /** The first time this device links to a server, its copy of every chat's
   *  documents is read from the server (documents are the server's, Д9). */
  private async syncArtifactsOnce(client: HubClient): Promise<void> {
    if (!this.options.artifacts) return;
    const hub = this.options.storage.hub();
    const key = `artifacts-synced:${(await client.health()).hubId}`;
    if (await hub.clientState(key)) return;
    const { chats } = await client.chats();
    await this.reloadArtifacts(chats.map((chat) => chat.id));
    await hub.setClientState(key, new Date().toISOString());
    this.options.log("artifact.server.synced", { chats: chats.length });
  }

  /** The first link to a server that owns the chats: this computer's chats
   *  move there (it held them until now), page by page, each chat once; the
   *  server keeps messages only it had (written on a phone) in their place.
   *  Then every chat is read back as the server holds it. */
  private async moveChats(client: HubClient): Promise<void> {
    const hub = this.options.storage.hub();
    const health = await client.health();
    const doneKey = `ops-moved:${health.hubId}`;
    if (await hub.clientState(doneKey)) return;
    const started = Date.now();
    const before = await client.chats();
    const local = (await this.options.storage.listConversations()).filter((summary) => summary.kind === "chat");
    let pages = 0;
    for (const summary of local) {
      const chatKey = `ops-moved-chat:${health.hubId}:${summary.id}`;
      if (await hub.clientState(chatKey)) continue;
      await this.options.chat.exportChatForServer(summary.id, async (conversation) => {
        pages += await this.importChat(client, conversation);
      });
      await hub.setClientState(chatKey, new Date().toISOString());
    }
    // Chats deleted here after the server first copied them go there too.
    for (const chat of before.chats) {
      if (await this.options.storage.conversationTombstones().isDeleted(chat.id)) {
        const answer = await client.writeOps([{ opId: newOpId(), kind: "conversation.delete", conversationId: chat.id }]);
        if (answer.results[0]?.status === "rejected") this.options.log("chat.server.move-delete-refused", { conversationId: chat.id, reason: answer.results[0].reason });
      }
    }
    // Read back exactly as the server holds each chat (its places and writers,
    // and the phone's messages this computer never had), from where the feed
    // stands now.
    const { chats, head } = await client.chats();
    await hub.setClientState(HUB_FEED_CURSOR_KEY, String(head));
    for (const chat of chats) await this.options.chat.reloadChatFromServer(chat.id);
    await hub.setClientState(doneKey, new Date().toISOString());
    this.options.log("chat.server.moved", { chats: local.length, pages, serverChats: chats.length, ms: Date.now() - started });
  }

  /**
   * The first link to a server that owns documents: this computer's
   * documents move there, chat by chat, each once, every row as it is (ids,
   * revision ids and hashes, numbering, signatures, drafts, operations);
   * each chat's documents are then read back as the server holds them.
   * Until a chat's documents are on the server, this copy of them is the
   * only one: it is never replaced by the server's (a refused page leaves
   * them here, moved again at the next start).
   */
  private async moveDocuments(client: HubClient, documents: ArtifactClient): Promise<boolean> {
    const hub = this.options.storage.hub();
    const health = await client.health();
    const doneKey = `ops-moved-artifacts:${health.hubId}`;
    if (await hub.clientState(doneKey)) {
      this.pendingArtifactMoves.clear();
      this.artifactMovesUnknown = false;
      return true;
    }
    const chatKey = (conversationId: string) => `ops-moved-artifacts:${health.hubId}:${conversationId}`;
    const local = (await this.options.storage.listConversations()).filter((summary) => summary.kind === "chat");
    for (const summary of local) {
      if (!await hub.clientState(chatKey(summary.id))) this.pendingArtifactMoves.add(summary.id);
    }
    this.artifactMovesUnknown = false;
    const started = Date.now();
    let pages = 0;
    for (const conversationId of [...this.pendingArtifactMoves]) {
      if (await this.options.storage.conversationTombstones().isDeleted(conversationId)) {
        this.pendingArtifactMoves.delete(conversationId);
        continue;
      }
      const moved = await this.importArtifacts(client, documents, conversationId);
      pages += moved.pages;
      if (moved.refusal !== undefined) {
        this.options.log("chat.server.move-artifacts-refused", { conversationId, reason: moved.refusal });
        continue;
      }
      await hub.setClientState(chatKey(conversationId), new Date().toISOString());
      this.pendingArtifactMoves.delete(conversationId);
      await documents.reloadConversation(conversationId);
    }
    if (this.pendingArtifactMoves.size === 0) await hub.setClientState(doneKey, new Date().toISOString());
    this.options.log("artifact.server.moved", { chats: local.length, pages, pending: this.pendingArtifactMoves.size, ms: Date.now() - started });
    return this.pendingArtifactMoves.size === 0;
  }

  /** One chat's documents moved to the server, in pages (every row as it is
   *  here). A page the server refuses stops this chat's move; returns why. */
  private async importArtifacts(client: HubClient, documents: ArtifactClient, conversationId: string): Promise<{ pages: number; refusal?: string }> {
    const rows = await documents.exportConversation(conversationId);
    if (rows.artifacts.length === 0) return { pages: 0 };
    const pages: HubArtifactImportRows[] = [];
    let page: HubArtifactImportRows = {};
    let bytes = 0;
    const add = <K extends keyof HubArtifactImportRows>(key: K, row: NonNullable<HubArtifactImportRows[K]>[number]) => {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes > 0 && bytes + size > IMPORT_PAGE_BYTES) {
        pages.push(page);
        page = {};
        bytes = 0;
      }
      ((page[key] ??= []) as Array<typeof row>).push(row);
      bytes += size;
    };
    // A document before its revisions, revisions before what names them.
    for (const row of rows.artifacts) add("artifacts", row);
    for (const row of rows.revisions) add("revisions", row);
    for (const row of rows.projection) add("projection", row);
    for (const row of rows.signatures) add("signatures", row);
    for (const row of rows.sources) add("sources", row);
    for (const row of rows.drafts) add("drafts", row);
    for (const row of rows.operations) add("operations", row);
    if (bytes > 0) pages.push(page);
    for (let index = 0; index < pages.length; index += 1) {
      const answer = await client.writeOps([{ opId: newOpId(), kind: "artifact.import", conversationId, rows: pages[index] }]);
      const result = answer.results[0];
      if (!result) throw new Error(`The server did not answer for the documents of chat ${conversationId}.`);
      if (result.status === "rejected") return { pages: index, refusal: result.reason };
      const kept = result.artifact?.result;
      const refused = kept?.ok ? (kept.value as { refused?: string[] }).refused ?? [] : [];
      if (refused.length) this.options.log("chat.server.move-artifact-rows-refused", { conversationId, refused: refused.slice(0, 20) });
    }
    return { pages: pages.length };
  }

  /** One chat moved to the server, in pages; returns the pages sent. */
  private async importChat(client: HubClient, conversation: Conversation): Promise<number> {
    const fields = { ...conversationFieldsOf(conversation), updatedAt: conversation.updatedAt };
    const messages = conversation.messages.map(messageForImport);
    const order = messages.map((message) => message.id);
    const pages: ChatMessage[][] = [];
    let current: ChatMessage[] = [];
    let bytes = 0;
    for (const message of messages) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (current.length > 0 && (bytes + size > IMPORT_PAGE_BYTES || current.length >= IMPORT_PAGE_MESSAGES)) {
        pages.push(current);
        current = [];
        bytes = 0;
      }
      current.push(message);
      bytes += size;
    }
    pages.push(current);
    for (let index = 0; index < pages.length; index += 1) {
      const last = index === pages.length - 1;
      const op: HubOp = {
        opId: newOpId(), kind: "chat.import", conversationId: conversation.id, messages: pages[index],
        ...(index === 0 ? { conversation: fields } : {}),
        // The order goes alone when it would make the last page too large.
        ...(last && Buffer.byteLength(JSON.stringify(order)) + bytesOf(pages[index]) < IMPORT_PAGE_BYTES ? { order } : {})
      };
      await this.writeOne(client, op);
      if (last && !("order" in op)) await this.writeOne(client, { opId: newOpId(), kind: "chat.import", conversationId: conversation.id, messages: [], order });
    }
    return pages.length;
  }

  private async writeOne(client: HubClient, op: HubOp): Promise<void> {
    const answer = await client.writeOps([op]);
    const result = answer.results[0];
    if (!result || result.status === "rejected") {
      throw new Error(`The server did not take chat ${op.conversationId}: ${result && result.status === "rejected" ? result.reason : "no answer"}`);
    }
  }
}

function bytesOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0);
}

/** A message as it moves to the server: this device's bookkeeping out,
 *  reactions kept (they are the chat's). */
function messageForImport(message: ChatMessage): ChatMessage {
  const { metadata, ...rest } = message;
  if (!metadata) return { ...rest };
  const shared: Record<string, unknown> = { ...metadata };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete shared[key];
  delete shared.serverSeq;
  delete shared.serverWriter;
  return Object.keys(shared).length ? { ...rest, metadata: shared as ChatMessage["metadata"] } : { ...rest };
}

/** The operation's answer, or undefined when none came within `ms`. */
async function answerWithin(ops: HubOpsClient, opId: string, ms: number): Promise<HubOpOutcome | undefined> {
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), ms);
  try {
    return await ops.waitFor(opId, cancel.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
