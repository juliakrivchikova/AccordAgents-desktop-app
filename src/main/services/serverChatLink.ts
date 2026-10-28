import { HubClient, HubHttpError } from "./hubClient";
import { HubOpsClient, HUB_FEED_CURSOR_KEY, type HubOpOutcome } from "./hubOpsClient";
import { conversationFieldsOf, newOpId, type ChatServerLink } from "./chatServerOps";
import { LOCAL_MESSAGE_METADATA_KEYS } from "./chatChanges";
import type { HubSigningIdentity } from "./hubAuth";
import type { StorageService } from "./storage";
import type { ChatService } from "./chat";
import { HUB_OP_MAX_BYTES, type HubFeedEntry, type HubOp, type HubTurn } from "../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../shared/types";

/** Messages in one page of a chat moving to the server (well under the
 *  server's limit for one operation). */
const IMPORT_PAGE_BYTES = Math.floor(HUB_OP_MAX_BYTES * 0.8);
const IMPORT_PAGE_MESSAGES = 200;

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
    log: (event: string, payload: Record<string, unknown>) => void;
  }) {}

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
      waitingTurns: async () => this.ready && this.client ? (await this.client.waitingTurns()).turns : [],
      machineName: (machineId) => this.machineNames.get(machineId),
      settleMoved: (conversationId) => this.requireOps().settleMoved(conversationId)
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
    const client = new HubClient({ url, identity: this.options.identity, storage: this.options.storage });
    this.client = client;
    const hub = this.options.storage.hub();
    this.ops = new HubOpsClient({
      store: this.options.storage.hubClientOps(),
      cursor: { get: () => hub.clientState(HUB_FEED_CURSOR_KEY), set: (value) => hub.setClientState(HUB_FEED_CURSOR_KEY, value) },
      client: () => this.ready ? this.client : undefined,
      apply: (entries: HubFeedEntry[]) => this.options.chat.applyServerEntries(entries),
      resync: () => this.resync(),
      onAnswered: (row, outcome: HubOpOutcome) => {
        if (outcome.status === "rejected") this.options.log("chat.server.op-rejected", { opId: row.opId, kind: row.kind, conversationId: row.conversationId, reason: outcome.reason });
      },
      log: this.options.log
    });
    // Installed before the move, so nothing written meanwhile is lost: it is
    // queued here and sent once the chats are on the server.
    this.options.chat.setServerLink(this.chatLink());
    this.options.chat.setServerChatReader((conversationId) => this.readChat(conversationId));
    const ops = this.ops;
    ops.onStatusChanged(() => { void ops.status().then((status) => { this.unreachable = status.unreachableSince; }); });
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
    this.ready = true;
    this.ops?.nudge();
    this.ops?.wakeReader();
    await this.options.chat.resumeServerTurns().catch((error) => {
      this.options.log("chat.server.resume-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.ops?.stop();
    this.options.chat.setServerLink(undefined);
    this.options.chat.setServerChatReader(undefined);
    this.ops = undefined;
    this.client = undefined;
    await this.embedded?.close();
    this.embedded = undefined;
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
    this.options.log("chat.server.resynced", { chats: chats.length, head });
    return head;
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
