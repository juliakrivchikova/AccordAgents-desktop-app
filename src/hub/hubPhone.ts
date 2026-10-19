import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { ConversationSummary } from "../shared/types";
import { parseMobilePhoneScope, type MobilePhoneScope } from "../shared/mobilePairing";
import type { HubRelayStorage } from "../main/services/hubRelayStorage";
import { MOBILE_CHAT_LIST_LIMIT, buildMobileChatList, buildMobileTimelinePage, type MobileCatalogStore } from "../main/services/mobileChatCatalog";
import type { MobileRelayChatListItem } from "../main/services/mobileRelayControl";

/**
 * The phone reads the User's chats from her own server: the chat list, a
 * chat's pages and what changed, from the server's copy of every chat. The
 * desktop does not have to be awake for any of it. A phone proves itself
 * with its pairing's mailbox key (the one it already uses for the mailbox),
 * and reads only what the desktop that made the pairing allowed it.
 */

export const HUB_PHONE_PATHS = new Set(["/v1/phone/chats", "/v1/phone/timeline", "/v1/phone/changes"]);

export const PHONE_ERROR_UNAUTHORIZED = "phone_unauthorized";
export const PHONE_ERROR_NO_SCOPE = "phone_scope_missing";
export const PHONE_ERROR_REVOKED = "phone_revoked";
export const PHONE_ERROR_EXPIRED = "phone_expired";
export const PHONE_ERROR_CHAT_NOT_FOUND = "chat_not_found";
export const PHONE_ERROR_UNKNOWN = "phone_unknown";

/** How long a changes request waits for news before answering empty. */
const CHANGES_WAIT_MAX_MS = 25_000;
/** Conversations whose last change the feed remembers; older news is a reset. */
const FEED_MEMORY = 2_000;
/** Waiting changes requests, all phones together and per mailbox. */
const WAITERS_MAX = 256;
const WAITERS_PER_MAILBOX_MAX = 4;
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
  /** The server's copy of every chat. */
  store: MobileCatalogStore;
  relayStorage: HubRelayStorage;
  feed: HubChangeFeed;
  /** Cloud machines' names by the desktop's id for them (from the roster). */
  machineNames: () => Promise<Map<string, string>>;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

type Answer = { status: number; body: unknown };

export class HubPhoneApi {
  private listCache = new Map<string, { seq: number; chats: MobileRelayChatListItem[] }>();
  private readonly waitersByMailbox = new Map<string, number>();
  /** Each listed chat's row as last built, kept until that chat changes: a
   *  change rebuilds one row, not a read per chat (and the rows are small,
   *  where the chats behind them are not). */
  private readonly rowCache = new Map<string, { seq: number; updatedAt: string; row: MobileRelayChatListItem }>();

  constructor(private readonly options: HubPhoneOptions) {}

  /** Answers one phone request; the status is returned for the server's log. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<number> {
    const answer = await this.answer(request, response, url).catch((error: unknown) => {
      this.options.log?.("hub.phone.error", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
      return { status: 500, body: { ok: false, error: "The server could not answer." } } satisfies Answer;
    });
    send(request, response, answer);
    return answer.status;
  }

  private async answer(request: IncomingMessage, response: ServerResponse, url: URL): Promise<Answer> {
    if (request.method !== "GET") return { status: 405, body: { ok: false, error: "method not allowed" } };
    // A phone sends no body; anything sent with one is let through unread.
    request.resume();
    const access = await this.authorize(url.searchParams.get("mailboxId"), request.headers.authorization);
    if ("status" in access) return access;
    const { scope, mailboxId } = access;
    if (url.pathname === "/v1/phone/chats") return { status: 200, body: { ok: true, type: "mobile.chat-list", chats: await this.chats(scope), generatedAt: new Date().toISOString() } };
    if (url.pathname === "/v1/phone/timeline") return this.timeline(scope, url.searchParams);
    return this.changes(scope, mailboxId, url.searchParams, response);
  }

  private async authorize(mailboxIdParam: string | null, authorization: string | undefined): Promise<{ scope: MobilePhoneScope; mailboxId: string } | Answer> {
    const mailboxId = typeof mailboxIdParam === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(mailboxIdParam) ? mailboxIdParam : "";
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim() ?? "";
    if (!mailboxId || !token) return { status: 401, body: { ok: false, error: PHONE_ERROR_UNAUTHORIZED } };
    const row = await this.options.relayStorage.mailbox(mailboxId);
    if (row?.revokedAt) return { status: 401, body: { ok: false, error: PHONE_ERROR_REVOKED } };
    if (!row?.tokenHash || !sameText(row.tokenHash, createHash("sha256").update(token, "utf8").digest("base64url"))) {
      return { status: 401, body: { ok: false, error: PHONE_ERROR_UNAUTHORIZED } };
    }
    const scope = parseMobilePhoneScope(row.phoneScope);
    // A pairing the desktop made before it told the server what it may read:
    // the phone keeps asking the desktop until the desktop says.
    if (!scope) return { status: 403, body: { ok: false, error: PHONE_ERROR_NO_SCOPE } };
    // A link the desktop no longer lists among the phones it knows (its record
    // was lost): nothing here until it lists it again.
    if (row.phoneKnown === 0) return { status: 403, body: { ok: false, error: PHONE_ERROR_UNKNOWN } };
    // A link no phone has used yet is good only within its window; once the
    // desktop says a phone used it, the window no longer applies.
    if (!row.phoneClaimed) {
      const expiresAt = Date.parse(row.phoneExpiresAt ?? "");
      if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return { status: 401, body: { ok: false, error: PHONE_ERROR_EXPIRED } };
    }
    // The phone has used its link: the desktop reads this with the box and
    // keeps the pairing. Written at most once a minute.
    const seenAt = Date.parse(row.phoneSeenAt ?? "");
    if (!Number.isFinite(seenAt) || Date.now() - seenAt > 60_000) {
      await this.options.relayStorage.updateMailbox(mailboxId, { phoneSeenAt: new Date().toISOString() }).catch(() => undefined);
    }
    return { scope, mailboxId };
  }

  private async chats(scope: MobilePhoneScope): Promise<MobileRelayChatListItem[]> {
    const key = scope.scope === "device" ? "device" : `conversation:${scope.conversationId}`;
    const feed = this.options.feed;
    const seq = feed.current();
    const cached = this.listCache.get(key);
    if (cached && cached.seq === seq) return cached.chats;
    const include = (summary: ConversationSummary) => scope.scope === "device" || summary.id === scope.conversationId;
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
      const built = await buildMobileChatList(this.options.store, {
        roleLabels: new Map(),
        machineNames,
        // Approvals live on the desktop and the machines; a list that cannot
        // name them all names none, and the phone keeps the cards it holds.
        pendingCards: false,
        runningFromMessages: true,
        summaries,
        include: (summary: ConversationSummary) => stale.has(summary.id) && include(summary)
      });
      const updatedAt = new Map(listed.map((summary) => [summary.id, summary.updatedAt]));
      for (const row of built) {
        this.rowCache.set(row.id, {
          seq,
          updatedAt: updatedAt.get(row.id) ?? row.updatedAt,
          row: { ...row, members: row.members?.map((member) => ({ ...member, roleLabel: roleLabelFor(member.roleLabel) })) }
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

  private async timeline(scope: MobilePhoneScope, query: URLSearchParams): Promise<Answer> {
    const conversationId = query.get("conversationId") ?? "";
    if (!conversationId || conversationId.length > 200 || /[\u0000-\u001f\u007f]/.test(conversationId)) {
      return { status: 400, body: { ok: false, error: "conversationId required" } };
    }
    const beforeRaw = query.get("beforeMessageId")?.trim() ?? "";
    const before = beforeRaw && beforeRaw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(beforeRaw) ? beforeRaw : undefined;
    if (scope.scope === "conversation" && scope.conversationId !== conversationId) return { status: 404, body: { ok: false, error: PHONE_ERROR_CHAT_NOT_FOUND } };
    const opened = await this.options.store.openConversation(conversationId, 1);
    const conversation = opened?.conversation;
    // Every chat the desktop would show: an archived one only to the pairing
    // made for it.
    if (!conversation || conversation.kind !== "chat" || (scope.scope === "device" && conversation.metadata.archived === true)) {
      return { status: 404, body: { ok: false, error: PHONE_ERROR_CHAT_NOT_FOUND } };
    }
    const page = await buildMobileTimelinePage(this.options.store, conversationId, before ? { beforeMessageId: before } : {});
    return {
      status: 200,
      body: {
        ok: true,
        type: "mobile.timeline.events",
        conversationId,
        events: page.events,
        page: {
          hasMoreBefore: page.hasMoreBefore,
          ...(page.beforeMessageId ? { beforeMessageId: page.beforeMessageId } : {}),
          ...(before ? { earlier: true } : {})
        }
      }
    };
  }

  private async changes(scope: MobilePhoneScope, mailboxId: string, query: URLSearchParams, response: ServerResponse): Promise<Answer> {
    const feed = this.options.feed;
    const instance = query.get("instance") ?? "";
    const after = Number(query.get("after") ?? "");
    const waitMs = Math.max(0, Math.min(CHANGES_WAIT_MAX_MS, Number(query.get("waitMs") ?? CHANGES_WAIT_MAX_MS) || 0));
    const reset = () => ({ status: 200, body: { ok: true, instance: feed.instance, seq: feed.current(), reset: true } });
    if (instance !== feed.instance || !Number.isSafeInteger(after) || after < 0) return reset();
    const mine = (ids: string[]) => scope.scope === "device" ? ids : ids.filter((id) => id === scope.conversationId);
    let news = feed.since(after);
    if (news.reset) return reset();
    let conversationIds = mine(news.conversationIds);
    if (conversationIds.length === 0 && waitMs > 0) {
      const waiting = this.waitersByMailbox.get(mailboxId) ?? 0;
      // Too many waiting: answered at once, and told when to ask again.
      if (feed.waiting() >= WAITERS_MAX || waiting >= WAITERS_PER_MAILBOX_MAX) {
        return { status: 200, body: { ok: true, instance: feed.instance, seq: after, conversationIds: [], retryAfterMs: 5_000 } };
      }
      this.waitersByMailbox.set(mailboxId, waiting + 1);
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
        const left = (this.waitersByMailbox.get(mailboxId) ?? 1) - 1;
        if (left > 0) this.waitersByMailbox.set(mailboxId, left);
        else this.waitersByMailbox.delete(mailboxId);
      }
    }
    return { status: 200, body: { ok: true, instance: feed.instance, seq: feed.current(), conversationIds } };
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

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
