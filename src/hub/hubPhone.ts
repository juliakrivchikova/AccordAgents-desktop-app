import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ChatSavedPromptConfig, ConversationOpenResult, ConversationSummary } from "../shared/types";
import { CHAT_DELIVERY_POLICY_OPTIONS, resolveChatDeliveryTargets } from "../shared/chatDeliveryPolicy";
import { matchingChatSavedPrompts } from "../shared/chatSavedPrompts";
import { isDeviceEventBlobReference, type DeviceEventBlobReference } from "../shared/deviceEventBlobs";
import type { HubComposerCatalog, HubDevice, HubPhoneScope } from "../shared/hubProtocol";
import { approvalHasCard, controlCardFromApproval, controlCardFromChoiceMessage, type MobileControlCard } from "../shared/mobileControlCards";
import { MOBILE_CHAT_LIST_LIMIT, buildMobileChatList, buildMobileTimelinePage, mobileChatMembers } from "../main/services/mobileChatCatalog";
import type { MobileChatListItem } from "../main/services/mobileTimeline";
import type { StorageService } from "../main/services/storage";
import { liveTimelineEvents, scopeCovers, type HubProgress, type HubWaker } from "./hubPhoneState";
/**
 * The phone reads the User's chats from her own server: the chat list, a
 * chat's pages and what changed, from the server's copy of every chat, and
 * the cards, live progress, composer catalog, pictures and notices that go
 * with them. The desktop does not have to be awake for any of it. A phone
 * proves itself with its own signature (it is on the roster since it
 * enrolled with the owner's invite) and reads only what its invite allowed.
 */

export const HUB_PHONE_PATHS = new Set([
  "/v1/phone/chats", "/v1/phone/timeline", "/v1/phone/changes", "/v1/phone/progress", "/v1/phone/composer",
  "/v1/phone/attachment", "/v1/phone/avatar", "/v1/phone/notices", "/v1/phone/seen", "/v1/phone/machines", "/v1/phone/wake"
]);

export const PHONE_ERROR_NO_SCOPE = "phone_scope_missing";
export const PHONE_ERROR_CHAT_NOT_FOUND = "chat_not_found";

/** How long a changes request waits for news before answering empty. */
const CHANGES_WAIT_MAX_MS = 25_000;
/** Conversations whose last change the feed remembers; older news is a reset. */
const FEED_MEMORY = 2_000;
/** Waiting changes requests, all phones together and per device. */
const WAITERS_MAX = 256;
const WAITERS_PER_DEVICE_MAX = 4;
/** The newest messages read for a chat's live progress (its running rows). */
const LIVE_PROGRESS_WINDOW = 40;
/** Chats whose newest messages are held between phone requests. */
const OPENED_CACHE_MAX = 4;
/** A body this large or larger is compressed for a phone that accepts it. */
const GZIP_MIN_BYTES = 4_096;

/** Which chats changed on the server, in the order their copy changed. Kept
 *  in memory: a restarted server is a new instance, and a phone that saw the
 *  old one reads everything again. */
export class HubChangeFeed {
  readonly instance = randomUUID();
  private seq = 0;
  private floor = 0;
  private readonly changed = new Map<string, number>();
  private readonly waiters = new Set<() => void>();

  note(conversationId: string): void {
    this.seq += 1;
    this.changed.delete(conversationId);
    this.changed.set(conversationId, this.seq);
    while (this.changed.size > FEED_MEMORY) {
      const [oldestId, oldestSeq] = this.changed.entries().next().value as [string, number];
      this.changed.delete(oldestId);
      this.floor = Math.max(this.floor, oldestSeq);
    }
    for (const wake of [...this.waiters]) wake();
  }

  current(): number {
    return this.seq;
  }

  /** The position of a chat's last change this instance can vouch for: a
   *  chat it no longer remembers may have changed as late as the floor. */
  lastChange(conversationId: string): number {
    return this.changed.get(conversationId) ?? this.floor;
  }

  /** What changed after `after`; a position the feed no longer remembers
   *  (or one from another instance) is a reset. */
  since(after: number): { reset: true } | { reset: false; conversationIds: string[] } {
    if (after < this.floor || after > this.seq) return { reset: true };
    return { reset: false, conversationIds: [...this.changed].filter(([, seq]) => seq > after).map(([id]) => id) };
  }

  /** Resolves when something changes after `after`, the time runs out, or
   *  the caller goes away. */
  wait(after: number, timeoutMs: number, gone: Promise<void>): Promise<void> {
    if (this.seq > after) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.waiters.add(done);
      void gone.then(done);
    });
  }

  waiting(): number {
    return this.waiters.size;
  }
}

export interface HubPhoneOptions {
  /** The server's copy of every chat, and its own tables. */
  store: StorageService;
  feed: HubChangeFeed;
  /** Cloud machines' names by the desktop's id for them (from the roster). */
  machineNames: () => Promise<Map<string, string>>;
  progress: HubProgress;
  waker?: HubWaker;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

type Answer = { status: number; body: unknown };

/** The picture a phone is sent at most (as the desktop did). */
const PHONE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
/** The cards a chat's page carries at most. */
const PHONE_CARDS_MAX = 30;
const COMPOSER_TARGET_WINDOW = 200;
/** A phone counts as looking at its app while its wait for news is open, and
 *  this long after it ended (the app asks again at once while it is open). */
const PHONE_ACTIVE_GRACE_MS = 8_000;

export class HubPhoneApi {
  private listCache = new Map<string, { seq: number; chats: MobileChatListItem[] }>();
  private readonly waitersByDevice = new Map<string, number>();
  private readonly lastWaitEndedAt = new Map<string, number>();
  /** Each listed chat's row as last built, kept until that chat changes: a
   *  change rebuilds one row, not a read per chat (and the rows are small,
   *  where the chats behind them are not). */
  private readonly rowCache = new Map<string, { seq: number; updatedAt: string; row: MobileChatListItem }>();
  /** A chat's newest messages as last read, while the chat has not changed:
   *  a phone asks for live progress every second or two and for the
   *  composer on every keystroke, and the hub's copy of a big chat is
   *  megabytes to read each time. */
  private readonly openedCache = new Map<string, { stamp: number; limit: number; opened: ConversationOpenResult }>();
  private catalogCache?: { at: number; catalog: HubComposerCatalog | undefined };

  constructor(private readonly options: HubPhoneOptions) {}

  /** Whether the phone's app is open now (it is not rung then). */
  isActive(deviceId: string, now = Date.now()): boolean {
    if ((this.waitersByDevice.get(deviceId) ?? 0) > 0) return true;
    const ended = this.lastWaitEndedAt.get(deviceId);
    return ended !== undefined && now - ended < PHONE_ACTIVE_GRACE_MS;
  }

  /** The catalog was published again. */
  catalogChanged(): void {
    this.catalogCache = undefined;
    this.listCache.clear();
    this.rowCache.clear();
  }

  /** Answers one phone request; the status is returned for the server's log. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const answer = await this.answer(request, response, url, device, body).catch((error: unknown) => {
      this.options.log?.("hub.phone.error", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
      return { status: 500, body: { ok: false, error: "The server could not answer." } } satisfies Answer;
    });
    send(request, response, answer);
    return answer.status;
  }

  private async answer(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<Answer> {
    const scope = device.scope;
    // A phone the owner listed without saying what it may read reads nothing.
    if (!scope) return { status: 403, body: { ok: false, error: PHONE_ERROR_NO_SCOPE } };
    const post = request.method === "POST";
    if (post !== (url.pathname === "/v1/phone/seen" || url.pathname === "/v1/phone/wake")) {
      return { status: 405, body: { ok: false, error: "method not allowed" } };
    }
    switch (url.pathname) {
      case "/v1/phone/chats":
        return { status: 200, body: { ok: true, type: "mobile.chat-list", chats: await this.chats(scope), generatedAt: new Date().toISOString() } };
      case "/v1/phone/timeline": return this.timeline(scope, url.searchParams);
      case "/v1/phone/changes": return this.changes(scope, device.deviceId, url.searchParams, response);
      case "/v1/phone/progress": return this.liveProgress(scope, url.searchParams);
      case "/v1/phone/composer": return this.composer(scope, url.searchParams);
      case "/v1/phone/attachment": return this.attachment(scope, url.searchParams);
      case "/v1/phone/avatar": return this.avatar(scope, url.searchParams);
      case "/v1/phone/notices": return this.notices(scope, device.deviceId, url.searchParams);
      case "/v1/phone/seen": {
        const parsed = parseBody(body) as { through?: unknown } | undefined;
        const through = Number(parsed?.through);
        if (!Number.isSafeInteger(through) || through < 0) return { status: 400, body: { ok: false, error: "through required" } };
        await this.options.store.hub().setPhoneSeenNotice(device.deviceId, through, new Date().toISOString());
        return { status: 200, body: { ok: true } };
      }
      case "/v1/phone/machines":
        return { status: 200, body: { ok: true, machines: this.options.waker ? await this.options.waker.status() : [] } };
      case "/v1/phone/wake": {
        const parsed = parseBody(body) as { machineId?: unknown } | undefined;
        const machineId = typeof parsed?.machineId === "string" && parsed.machineId.length <= 128 ? parsed.machineId : "";
        if (!machineId || !this.options.waker) return { status: 400, body: { ok: false, error: "machineId required" } };
        const woken = await this.options.waker.wakeNow(machineId);
        return { status: 200, body: { ok: true, started: woken.ok, message: woken.message } };
      }
      default:
        return { status: 404, body: { ok: false, error: "Not found." } };
    }
  }

  private async catalog(): Promise<HubComposerCatalog | undefined> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 30_000) return this.catalogCache.catalog;
    const stored = await this.options.store.hub().document("composer-catalog").catch(() => undefined);
    const value = stored?.value as HubComposerCatalog | undefined;
    const catalog = value && value.version === 1 ? value : undefined;
    this.catalogCache = { at: Date.now(), catalog };
    return catalog;
  }

  private async chats(scope: HubPhoneScope): Promise<MobileChatListItem[]> {
    const key = scope.scope === "device" ? "device" : `conversation:${scope.conversationId}`;
    const feed = this.options.feed;
    const seq = feed.current();
    const cached = this.listCache.get(key);
    if (cached && cached.seq === seq) return cached.chats;
    const include = (summary: ConversationSummary) => scopeCovers(scope, summary.id);
    if (this.rowCache.size > 4_000) this.rowCache.clear();
    const summaries = await this.options.store.listConversations();
    const listed = summaries
      .filter((summary) => summary.kind === "chat" && summary.archived !== true && include(summary))
      .slice(0, MOBILE_CHAT_LIST_LIMIT);
    const stale = new Set(listed.filter((summary) => {
      const row = this.rowCache.get(summary.id);
      return !row || row.updatedAt !== summary.updatedAt || feed.lastChange(summary.id) > row.seq;
    }).map((summary) => summary.id));
    if (stale.size > 0) {
      const machineNames = await this.options.machineNames().catch(() => new Map<string, string>());
      const catalog = await this.catalog();
      // Every card is here now: a choice from the copy, an approval as the
      // device holding it last said. So the list names them all, and the
      // phone drops a card the list leaves out.
      const approvals = new Map<string, ChatAppToolApproval[]>();
      for (const row of await this.options.store.hub().pendingApprovalCards([...stale])) {
        const list = approvals.get(row.conversationId) ?? [];
        list.push(JSON.parse(row.approvalJson) as ChatAppToolApproval);
        approvals.set(row.conversationId, list);
      }
      const built = await buildMobileChatList(this.options.store, {
        roleLabels: new Map(Object.entries(catalog?.roles ?? {})),
        machineNames,
        pendingCards: true,
        approvalsFor: (conversationId) => approvals.get(conversationId) ?? [],
        runningFromMessages: true,
        summaries,
        include: (summary: ConversationSummary) => stale.has(summary.id) && include(summary)
      });
      const updatedAt = new Map(listed.map((summary) => [summary.id, summary.updatedAt]));
      for (const row of built) {
        this.rowCache.set(row.id, {
          seq,
          updatedAt: updatedAt.get(row.id) ?? row.updatedAt,
          row: catalog ? row : { ...row, members: row.members?.map((member) => ({ ...member, roleLabel: roleLabelFor(member.roleLabel) })) }
        });
      }
    }
    const chats = listed.flatMap((summary) => {
      const row = this.rowCache.get(summary.id)?.row;
      return row ? [row] : [];
    });
    if (this.listCache.size > 16) this.listCache = new Map();
    this.listCache.set(key, { seq, chats });
    return chats;
  }

  private conversationParam(scope: HubPhoneScope, query: URLSearchParams): string | Answer {
    const conversationId = query.get("conversationId") ?? "";
    if (!conversationId || conversationId.length > 200 || /[\u0000-\u001f\u007f]/.test(conversationId)) {
      return { status: 400, body: { ok: false, error: "conversationId required" } };
    }
    if (!scopeCovers(scope, conversationId)) return { status: 404, body: { ok: false, error: PHONE_ERROR_CHAT_NOT_FOUND } };
    return conversationId;
  }

  private async timeline(scope: HubPhoneScope, query: URLSearchParams): Promise<Answer> {
    const conversationId = this.conversationParam(scope, query);
    if (typeof conversationId !== "string") return conversationId;
    const beforeRaw = query.get("beforeMessageId")?.trim() ?? "";
    const before = beforeRaw && beforeRaw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(beforeRaw) ? beforeRaw : undefined;
    const presence = await this.options.store.conversationPresence(conversationId);
    if (!presence || presence.kind !== "chat") return { status: 404, body: { ok: false, error: PHONE_ERROR_CHAT_NOT_FOUND } };
    const page = await buildMobileTimelinePage(this.options.store, conversationId, before ? { beforeMessageId: before } : {});
    const conversation = page.conversation;
    // Every chat the desktop would show: an archived one only to the pairing
    // made for it.
    if (!conversation || (scope.scope === "device" && conversation.metadata.archived === true)) {
      return { status: 404, body: { ok: false, error: PHONE_ERROR_CHAT_NOT_FOUND } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        type: "mobile.timeline.events",
        conversationId,
        events: page.events,
        // The newest page states the chat's cards, as the desktop's did.
        ...(before ? {} : { cards: await this.cards(conversationId, conversation.messages) }),
        page: {
          hasMoreBefore: page.hasMoreBefore,
          ...(page.beforeMessageId ? { beforeMessageId: page.beforeMessageId } : {}),
          ...(before ? { earlier: true } : {})
        }
      }
    };
  }

  /** A chat's cards: its pending approvals, as the device holding each last
   *  said, and the choices its members asked (pending anywhere in the chat,
   *  answered ones in the page). */
  private async cards(conversationId: string, pageMessages: ChatMessage[]): Promise<MobileControlCard[]> {
    const cards = new Map<string, MobileControlCard>();
    const hub = this.options.store.hub();
    for (const row of [...await hub.waitingApprovalCards(conversationId, PHONE_CARDS_MAX), ...await hub.approvalCards(conversationId, PHONE_CARDS_MAX)]) {
      const approval = JSON.parse(row.approvalJson) as ChatAppToolApproval;
      if (approvalHasCard(approval)) cards.set(approval.id, controlCardFromApproval(conversationId, approval));
    }
    const pendingChoices = await this.options.store.listPendingChoiceMessages([conversationId]).catch(() => ({ rows: [] as Array<{ conversationId: string; message: ChatMessage }> }));
    for (const message of [...pageMessages, ...pendingChoices.rows.map((row) => row.message)]) {
      const card = controlCardFromChoiceMessage(conversationId, message);
      if (card) cards.set(card.id, card);
    }
    return [...cards.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-PHONE_CARDS_MAX);
  }

  /** A chat's newest `limit` messages, read again only once it changed. */
  private async openedRecent(conversationId: string, limit: number): Promise<ConversationOpenResult | undefined> {
    const stamp = this.options.feed.lastChange(conversationId);
    const cached = this.openedCache.get(conversationId);
    if (cached && cached.stamp === stamp && cached.limit >= limit) {
      this.openedCache.delete(conversationId);
      this.openedCache.set(conversationId, cached);
      return cached.opened;
    }
    const opened = await this.options.store.openConversation(conversationId, Math.max(limit, cached?.limit ?? 0));
    if (!opened) return undefined;
    this.openedCache.delete(conversationId);
    this.openedCache.set(conversationId, { stamp, limit: Math.max(limit, cached?.limit ?? 0), opened });
    while (this.openedCache.size > OPENED_CACHE_MAX) this.openedCache.delete(this.openedCache.keys().next().value!);
    return opened;
  }

  private async liveProgress(scope: HubPhoneScope, query: URLSearchParams): Promise<Answer> {
    const conversationId = this.conversationParam(scope, query);
    if (typeof conversationId !== "string") return conversationId;
    const opened = await this.openedRecent(conversationId, LIVE_PROGRESS_WINDOW);
    if (!opened || opened.conversation.kind !== "chat") return { status: 404, body: { ok: false, error: PHONE_ERROR_CHAT_NOT_FOUND } };
    const events = liveTimelineEvents(opened.conversation, this.options.progress.forConversation(conversationId));
    return { status: 200, body: { ok: true, type: "mobile.timeline.events", conversationId, events, live: true } };
  }

  /** What the composer offers after `/`, as the desktop's composer would for
   *  the same draft, from the catalog the owner desktop published. */
  private async composer(scope: HubPhoneScope, query: URLSearchParams): Promise<Answer> {
    const conversationId = this.conversationParam(scope, query);
    if (typeof conversationId !== "string") return conversationId;
    const text = (query.get("query") ?? "").slice(0, 200);
    const content = (query.get("content") ?? "").slice(0, 4_000);
    const catalog = await this.catalog();
    const opened = await this.openedRecent(conversationId, COMPOSER_TARGET_WINDOW);
    const conversation = opened?.conversation;
    const empty = { ok: true, type: "mobile.composer", conversationId, query: text, commands: [], prompts: [], skills: [] };
    if (!conversation || conversation.kind !== "chat") return { status: 200, body: empty };
    const participants = mobileChatMembers(conversation) as ChatParticipant[];
    const target = resolveChatDeliveryTargets({ conversation, participants, content, options: CHAT_DELIVERY_POLICY_OPTIONS });
    const clear = target.targets.length > 0 && target.unknownHandles.length === 0;
    const needle = text.trim().toLowerCase();
    const commands = clear && target.targets.length === 1 ? [
      ...("compact".startsWith(needle) ? [{ id: "compact", label: "/compact", description: "Compact the mentioned member context" }] : []),
      ...("goal".startsWith(needle) ? [{ id: "goal", label: "/goal", description: "Run the mentioned member until the goal is finished" }] : [])
    ] : [];
    if (!catalog) {
      return { status: 200, body: { ...empty, commands, catalogMissing: true } };
    }
    const prompts = matchingChatSavedPrompts(catalog.prompts.map((prompt) => ({ ...prompt, version: 1, updatedAt: catalog.publishedAt })) as ChatSavedPromptConfig[], text, { includeBody: false })
      .slice(0, 8)
      .map((prompt) => ({ id: prompt.id, label: prompt.label, trigger: prompt.trigger, body: prompt.body }));
    const kinds = new Set(target.targets.map((participant) => participant.kind));
    const skills = catalog.skills
      .filter((skill) => skill.capabilityState === "invocable")
      .filter((skill) => kinds.size === 0 || skill.providerKinds.some((kind) => kinds.has(kind)))
      .filter((skill) => !needle || skill.frontmatterName.toLowerCase().includes(needle) || (skill.description ?? "").toLowerCase().includes(needle))
      .sort((left, right) => skillRank(left.frontmatterName, needle) - skillRank(right.frontmatterName, needle) || left.frontmatterName.localeCompare(right.frontmatterName))
      .slice(0, 8)
      .map(({ providerKinds: _providerKinds, ...mention }) => mention);
    return { status: 200, body: { ...empty, commands, prompts, skills } };
  }

  private async blobBase64(reference: DeviceEventBlobReference): Promise<string | undefined> {
    if (reference.byteLength > PHONE_ATTACHMENT_MAX_BYTES) return undefined;
    const blobs = this.options.store.deviceEventBlobs();
    const parts: Buffer[] = [];
    for (let index = 0; index < reference.fragments; index += 1) {
      const fragment = await blobs.fragment(reference, index).catch(() => undefined);
      if (!fragment) return undefined;
      parts.push(Buffer.from(fragment.bytesBase64, "base64"));
    }
    return Buffer.concat(parts).toString("base64");
  }

  /** A picture of a message, from the body the device that posted it put on
   *  the server. */
  private async attachment(scope: HubPhoneScope, query: URLSearchParams): Promise<Answer> {
    const conversationId = this.conversationParam(scope, query);
    if (typeof conversationId !== "string") return conversationId;
    const attachmentId = query.get("attachmentId") ?? "";
    const messageId = query.get("messageId") ?? "";
    const base = { ok: true, type: "mobile.attachment", conversationId, attachmentId };
    if (!attachmentId || attachmentId.length > 200 || !messageId || messageId.length > 256) return { status: 400, body: { ok: false, error: "attachmentId and messageId required" } };
    const page = await this.options.store.listConversationMessages({ conversationId, aroundMessageId: messageId, limit: 1 }).catch(() => undefined);
    const message = page?.messages.find((item) => item.id === messageId);
    const record = message?.metadata?.imageAttachments?.find((item) => item.id === attachmentId) as { mimeType?: string; sizeBytes?: number; hubBlob?: unknown } | undefined;
    if (!record) return { status: 200, body: { ...base, reason: "unavailable" } };
    if (typeof record.sizeBytes === "number" && record.sizeBytes > PHONE_ATTACHMENT_MAX_BYTES) return { status: 200, body: { ...base, reason: "too-large" } };
    if (!isDeviceEventBlobReference(record.hubBlob)) return { status: 200, body: { ...base, reason: "unavailable" } };
    const dataBase64 = await this.blobBase64(record.hubBlob);
    return { status: 200, body: dataBase64 ? { ...base, mimeType: record.mimeType, dataBase64 } : { ...base, reason: "unavailable" } };
  }

  private async avatar(scope: HubPhoneScope, query: URLSearchParams): Promise<Answer> {
    const conversationId = this.conversationParam(scope, query);
    if (typeof conversationId !== "string") return conversationId;
    const avatarId = query.get("avatarId") ?? "";
    const base = { ok: true, type: "mobile.avatar", conversationId, avatarId };
    const entry = (await this.catalog())?.avatars?.[avatarId];
    if (!entry || !isDeviceEventBlobReference(entry.blob)) return { status: 200, body: { ...base, reason: "unavailable" } };
    const dataBase64 = await this.blobBase64(entry.blob);
    return { status: 200, body: dataBase64 ? { ...base, mimeType: entry.mimeType, dataBase64 } : { ...base, reason: "unavailable" } };
  }

  /** What a phone is rung for, after the notices it has seen. */
  private async notices(scope: HubPhoneScope, deviceId: string, query: URLSearchParams): Promise<Answer> {
    const hub = this.options.store.hub();
    // From where the phone has seen, unless it names a place of its own.
    const afterRaw = query.has("after") ? Number(query.get("after")) : NaN;
    const after = Number.isSafeInteger(afterRaw) && afterRaw >= 0 ? afterRaw : await hub.phoneSeenNotice(deviceId);
    const notices = (await hub.notices(after, 50)).filter((notice) => scopeCovers(scope, notice.conversationId));
    return { status: 200, body: { ok: true, notices, head: await hub.noticeHead(), seen: await hub.phoneSeenNotice(deviceId) } };
  }

  private async changes(scope: HubPhoneScope, deviceId: string, query: URLSearchParams, response: ServerResponse): Promise<Answer> {
    const feed = this.options.feed;
    const instance = query.get("instance") ?? "";
    const after = Number(query.get("after") ?? "");
    const waitMs = Math.max(0, Math.min(CHANGES_WAIT_MAX_MS, Number(query.get("waitMs") ?? CHANGES_WAIT_MAX_MS) || 0));
    const reset = () => ({ status: 200, body: { ok: true, instance: feed.instance, seq: feed.current(), reset: true } });
    if (instance !== feed.instance || !Number.isSafeInteger(after) || after < 0) return reset();
    const mine = (ids: string[]) => ids.filter((id) => scopeCovers(scope, id));
    let news = feed.since(after);
    if (news.reset) return reset();
    let conversationIds = mine(news.conversationIds);
    if (conversationIds.length === 0 && waitMs > 0) {
      const waiting = this.waitersByDevice.get(deviceId) ?? 0;
      // Too many waiting: answered at once, and told when to ask again.
      if (feed.waiting() >= WAITERS_MAX || waiting >= WAITERS_PER_DEVICE_MAX) {
        return { status: 200, body: { ok: true, instance: feed.instance, seq: after, conversationIds: [], retryAfterMs: 5_000 } };
      }
      this.waitersByDevice.set(deviceId, waiting + 1);
      try {
        // The phone hanging up (an unfinished answer's close) ends the wait.
        let goneNow = false;
        const gone = new Promise<void>((resolve) => response.once("close", () => { goneNow = true; resolve(); }));
        const deadline = Date.now() + waitMs;
        let seen = after;
        // Another chat's change is no news to a pairing for one chat (and
        // must not tell it when the User is busy elsewhere): it waits on.
        while (!goneNow && conversationIds.length === 0 && Date.now() < deadline) {
          await feed.wait(seen, deadline - Date.now(), gone);
          news = feed.since(after);
          if (news.reset) return reset();
          conversationIds = mine(news.conversationIds);
          seen = feed.current();
        }
      } finally {
        const left = (this.waitersByDevice.get(deviceId) ?? 1) - 1;
        if (left > 0) this.waitersByDevice.set(deviceId, left);
        else this.waitersByDevice.delete(deviceId);
        this.lastWaitEndedAt.set(deviceId, Date.now());
        if (this.lastWaitEndedAt.size > 1_000) this.lastWaitEndedAt.clear();
      }
    }
    return { status: 200, body: { ok: true, instance: feed.instance, seq: feed.current(), conversationIds } };
  }
}

function skillRank(name: string, needle: string): number {
  const lower = name.toLowerCase();
  if (!needle) return 0;
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  return lower.includes(needle) ? 2 : 3;
}

function parseBody(body: Buffer): unknown {
  try {
    return body.length ? JSON.parse(body.toString("utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/** The server does not hold the desktop's role settings: a built-in role
 *  reads as the desktop names it, any other as a plain member. */
function roleLabelFor(roleConfigId: string): string {
  return BUILT_IN_ROLE_LABELS[roleConfigId] ?? "Member";
}

/** The desktop's built-in roles as Settings names them (settings.ts keeps
 *  the roles themselves); a role the User made shows as a plain member. */
const BUILT_IN_ROLE_LABELS: Record<string, string> = {
  "administrator": "Chat Assistant",
  "generic-participant": "Generic Member",
  "synthesizer": "Synthesizer",
  "arbiter": "Arbiter",
  "software-engineer": "Software Engineer",
  "product-strategist": "Product Strategist",
  "brand-strategist": "Brand Strategist",
  "naming-consultant": "Naming Consultant",
  "product-marketer": "Product Marketer",
  "ux-content-strategist": "UX Content Strategist",
  "trademark-attorney": "Trademark Attorney",
  "domain-seo-specialist": "Domain & SEO Specialist",
  "engineering-manager": "Engineering Manager",
  "product-designer": "Product Designer",
  "devex-reviewer": "Developer Experience Reviewer",
  "debugger": "Debugger",
  "qa-lead": "QA Lead",
  "security-reviewer": "Security Reviewer",
  "release-engineer": "Release Engineer",
  "code-reviewer": "Code Reviewer",
  "workflow-manager": "Workflow Manager"
};

function send(request: IncomingMessage, response: ServerResponse, answer: Answer): void {
  if (response.headersSent) return;
  const text = JSON.stringify(answer.body);
  const accepts = String(request.headers["accept-encoding"] ?? "");
  const headers: Record<string, string | number> = { "content-type": "application/json", "cache-control": "no-store", vary: "accept-encoding" };
  if (text.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(accepts)) {
    const compressed = gzipSync(text);
    response.writeHead(answer.status, { ...headers, "content-encoding": "gzip", "content-length": compressed.length });
    response.end(compressed);
    return;
  }
  response.writeHead(answer.status, { ...headers, "content-length": Buffer.byteLength(text) });
  response.end(text);
}
