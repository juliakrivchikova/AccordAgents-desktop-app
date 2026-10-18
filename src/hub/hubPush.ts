import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { StorageService } from "../main/services/storage";

/** Push services a phone may name (same list the relay allowed). */
const PUSH_ENDPOINT_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/
];

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
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

function vapidJwt(audience: string, subject: string, privateJwk: JsonWebKey, nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: subject })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  // JWS wants the raw r||s signature, not DER.
  const signature = sign("sha256", Buffer.from(signingInput), { key: createPrivateKey({ key: privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Rings a phone when something it has not read arrives: an empty push, and
 * the phone's service worker reads the news from the hub itself. Debounced,
 * so a burst of events is one ring.
 */
export class HubPush {
  private timer?: ReturnType<typeof setTimeout>;
  private lastSentAt = 0;
  /** What arrived since the last ring: the newest position and who wrote. */
  private window?: { head: number; origins: Set<string> };

  constructor(private readonly options: {
    storage: StorageService;
    keys: { publicKey: string; privateJwk: JsonWebKey };
    subject: string;
    minIntervalMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: (event: string, payload: Record<string, unknown>) => void;
  }) {}

  /** New events landed up to `head`, written by `originId`. */
  noteAppended(head: number, originId: string): void {
    this.window ??= { head, origins: new Set() };
    this.window.head = Math.max(this.window.head, head);
    this.window.origins.add(originId);
    if (this.timer) return;
    const now = this.options.now?.() ?? Date.now();
    const wait = Math.max(0, (this.options.minIntervalMs ?? 10_000) - (now - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const window = this.window;
      this.window = undefined;
      if (window) void this.ring(window.head, window.origins).catch((error) => this.options.log?.("hub.push.error", { message: error instanceof Error ? error.message : String(error) }));
    }, wait);
    this.timer.unref?.();
  }

  private async ring(head: number, origins: Set<string>): Promise<void> {
    const hub = this.options.storage.hub();
    const subscriptions = await hub.pushSubscriptions();
    this.lastSentAt = this.options.now?.() ?? Date.now();
    for (const subscription of subscriptions) {
      // A phone that wrote all of the news is not rung for it, nor one that
      // already read it.
      if ((origins.size === 1 && origins.has(subscription.deviceId)) || await hub.cursor(subscription.deviceId) >= head) continue;
      try {
        const audience = new URL(subscription.endpoint).origin;
        const jwt = vapidJwt(audience, this.options.subject, this.options.keys.privateJwk, this.lastSentAt);
        const response = await (this.options.fetchImpl ?? fetch)(subscription.endpoint, {
          method: "POST",
          headers: { TTL: "300", Urgency: "normal", "content-length": "0", Authorization: `vapid t=${jwt}, k=${this.options.keys.publicKey}` },
          signal: AbortSignal.timeout(5_000)
        });
        if (response.status === 404 || response.status === 410) await hub.deletePushSubscription(subscription.deviceId, subscription.endpoint);
        this.options.log?.("hub.push.sent", { deviceId: subscription.deviceId, status: response.status });
      } catch (error) {
        // One push service that does not answer does not keep the others quiet.
        this.options.log?.("hub.push.error", { deviceId: subscription.deviceId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
