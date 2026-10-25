import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { StorageService } from "../main/services/storage";
import { scopeCovers } from "./hubPhoneState";

/** A phone that looked open when it was to be rung is asked again this
 *  often (an app put away keeps its last wait open for a while), at most
 *  this many times. */
const ACTIVE_RECHECK_MS = 40_000;
const ACTIVE_RECHECKS_MAX = 4;
/** After a restart, notices this recent that a phone has not seen ring it. */
const REARM_WITHIN_MS = 10 * 60_000;

/** Push services a phone may name (same list the relay allowed). */
const PUSH_ENDPOINT_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/
];

/** Local QA only: a push service on this computer that stands in for a
 *  real one (`ACCORDAGENTS_HUB_TEST_PUSH_ORIGIN`). */
function testPushOrigin(): string | undefined {
  const value = process.env.ACCORDAGENTS_HUB_TEST_PUSH_ORIGIN?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    const test = testPushOrigin();
    if (test && url.origin === test) return true;
    return url.protocol === "https:" && PUSH_ENDPOINT_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

/** The hub's VAPID key pair, made once and kept beside its data. */
export function loadOrCreateVapidKeys(file: string): { publicKey: string; privateJwk: JsonWebKey } {
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { publicKey: string; privateJwk: JsonWebKey };
    if (stored.publicKey && stored.privateJwk) return stored;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  // Uncompressed point 0x04 || X || Y, base64url: what PushManager.subscribe takes.
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const keys = { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function vapidJwt(audience: string, subject: string, privateJwk: JsonWebKey, nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: subject })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  // JWS wants the raw r||s signature, not DER.
  const signature = sign("sha256", Buffer.from(signingInput), { key: createPrivateKey({ key: privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Rings a phone when something it has not seen happened: a member's reply
 * settled, or a card is waiting for the User. An empty push; the phone's
 * service worker reads the notice from the hub itself and shows it. Not while
 * the phone's app is open (it shows the news there), and not for a notice the
 * phone already marked seen. Debounced per phone, so a burst is one ring.
 */
export class HubPush {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSentAt = new Map<string, number>();
  /** The newest notice each phone has a ring scheduled for. */
  private readonly pendingFor = new Map<string, number>();
  /** How many times each phone's ring found the app open. */
  private readonly activeChecks = new Map<string, number>();

  constructor(private readonly options: {
    storage: StorageService;
    keys: { publicKey: string; privateJwk: JsonWebKey };
    subject: string;
    /** Whether the phone's app is open now. */
    isActive?: (deviceId: string) => boolean;
    debounceMs?: number;
    minIntervalMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: (event: string, payload: Record<string, unknown>) => void;
  }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A notice landed: every phone it is for is rung, unless it is looking. */
  async noteNotice(notice: { seq: number; conversationId: string }): Promise<void> {
    const devices = (await this.options.storage.hub().devices())
      .filter((device) => device.role === "phone" && scopeCovers(device.scope, notice.conversationId));
    for (const device of devices) {
      this.activeChecks.delete(device.deviceId);
      this.schedule(device.deviceId, notice.seq);
    }
  }

  /** After a restart: a phone that has not seen a recent notice is rung (its
   *  ring was scheduled in the program that stopped). */
  async rearm(): Promise<void> {
    const hub = this.options.storage.hub();
    const head = await hub.noticeHead();
    if (head === 0) return;
    for (const device of (await hub.devices()).filter((item) => item.role === "phone")) {
      const seen = await hub.phoneSeenNotice(device.deviceId);
      if (seen >= head) continue;
      const unseen = (await hub.notices(seen, 50)).filter((notice) => scopeCovers(device.scope, notice.conversationId) &&
        this.now() - Date.parse(notice.createdAt) < REARM_WITHIN_MS);
      const newest = unseen.at(-1);
      if (newest) this.schedule(device.deviceId, newest.seq);
    }
  }

  private schedule(deviceId: string, noticeSeq: number, delayMs?: number): void {
    this.pendingFor.set(deviceId, Math.max(this.pendingFor.get(deviceId) ?? 0, noticeSeq));
    if (this.timers.has(deviceId)) return;
    const sinceLast = this.now() - (this.lastSentAt.get(deviceId) ?? 0);
    const wait = delayMs ?? Math.max(this.options.debounceMs ?? 2_000, (this.options.minIntervalMs ?? 10_000) - sinceLast);
    const timer = setTimeout(() => {
      this.timers.delete(deviceId);
      const seq = this.pendingFor.get(deviceId) ?? 0;
      this.pendingFor.delete(deviceId);
      void this.ring(deviceId, seq).catch((error) => this.options.log?.("hub.push.error", { deviceId, message: error instanceof Error ? error.message : String(error) }));
    }, wait);
    timer.unref?.();
    this.timers.set(deviceId, timer);
  }

  private async ring(deviceId: string, noticeSeq: number): Promise<void> {
    const hub = this.options.storage.hub();
    if (this.options.isActive?.(deviceId)) {
      // Asked again a little later: an app just put away still looks open,
      // and what it did not see then still rings it (unless it saw it).
      const checks = (this.activeChecks.get(deviceId) ?? 0) + 1;
      this.activeChecks.set(deviceId, checks);
      this.options.log?.("hub.push.skipped", { deviceId, reason: "app-open", checks });
      if (checks < ACTIVE_RECHECKS_MAX) this.schedule(deviceId, noticeSeq, ACTIVE_RECHECK_MS);
      return;
    }
    this.activeChecks.delete(deviceId);
    if (await hub.phoneSeenNotice(deviceId) >= noticeSeq) {
      this.options.log?.("hub.push.skipped", { deviceId, reason: "seen" });
      return;
    }
    const subscriptions = (await hub.pushSubscriptions()).filter((subscription) => subscription.deviceId === deviceId);
    if (subscriptions.length === 0) return;
    this.lastSentAt.set(deviceId, this.now());
    for (const subscription of subscriptions) {
      try {
        const audience = new URL(subscription.endpoint).origin;
        const jwt = vapidJwt(audience, this.options.subject, this.options.keys.privateJwk, this.now());
        const response = await (this.options.fetchImpl ?? fetch)(subscription.endpoint, {
          method: "POST",
          headers: { TTL: "300", Urgency: "high", "content-length": "0", Authorization: `vapid t=${jwt}, k=${this.options.keys.publicKey}` },
          signal: AbortSignal.timeout(5_000)
        });
        if (response.status === 404 || response.status === 410) await hub.deletePushSubscription(subscription.deviceId, subscription.endpoint);
        this.options.log?.("hub.push.sent", { deviceId: subscription.deviceId, status: response.status, noticeSeq });
      } catch (error) {
        // One push service that does not answer does not keep the others quiet.
        this.options.log?.("hub.push.error", { deviceId: subscription.deviceId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
