// Contract shared by the desktop app, the relay worker, the mobile PWA, and
// the cloud runner script for the locked, sealed mailbox path. The relay only
// ever stores sealed payloads and only answers callers that present the
// per-pairing bearer token; both sides derive their credentials from the
// pairing seal key with the info strings below, so the pairing package needs
// no extra fields and the relay never learns the seal key itself.

export const MAILBOX_AUTH_TOKEN_INFO = "accord-mailbox-auth-v1";
export const MAILBOX_SCOPE_ID_INFO = "accord-mailbox-scope-v1";
export const MAILBOX_SCOPE_ID_PREFIX = "mb-";
export const MAILBOX_SCOPE_ID_LENGTH = 32;

export const MAILBOX_REGISTER_PATH = "/v1/mailbox/register";
export const MAILBOX_REVOKE_PATH = "/v1/mailbox/revoke";
export const MAILBOX_DELETE_PATH = "/v1/mailbox/delete";
export const MAILBOX_PUSH_SUBSCRIPTION_PATH = "/v1/mailbox/push-subscription";
export const PUSH_VAPID_PATH = "/v1/push/vapid";

// The doorbell (W5) sends EMPTY pushes on purpose: a push with no body needs
// no payload encryption and structurally cannot carry routing authority or
// content — the service worker fetches its stored endpoint and nothing else.
export const MAILBOX_PUSH_MIN_INTERVAL_MS = 10_000;

// Retention: events expire this long after ARRIVAL at the mailbox (the relay
// stamps arrival itself; client-supplied createdAt has no authority over
// retention). Overridable per deployment via ACCORD_MAILBOX_EVENT_TTL_MS.
export const MAILBOX_EVENT_TTL_MS_DEFAULT = 72 * 60 * 60 * 1000;

export const MAILBOX_ERROR_UNREGISTERED = "mailbox_unregistered";
export const MAILBOX_ERROR_UNAUTHORIZED = "mailbox_unauthorized";
export const MAILBOX_ERROR_UNSEALED_PAYLOAD = "mailbox_unsealed_payload";
export const MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED = "mailbox_push_endpoint_rejected";
// W-G: a revoked mailbox is terminal and says so. It must be distinguishable
// from a mailbox that was simply never registered: the phone clears its
// mirrored credentials and shows the re-pair screen for one, and stays in the
// quiet-wait state for the other. Without the distinction, a legitimately
// revoked pairing would look identical to the pre-registration hijack W-I
// warns about.
export const MAILBOX_ERROR_REVOKED = "mailbox_revoked";

// W-D: the only hosts the relay will ever send a wake push to. Without this,
// an authenticated caller can point the subscription at any https host and use
// our worker as an egress hop. Exploit value is low — the push body is empty
// and the caller already owns the mailbox — but it is an unbounded egress
// primitive in our own worker and it costs nothing to close.
//
// Entries are matched as an exact host or as a suffix on a dot boundary, never
// as a substring: "evil-push.apple.com.attacker.test" must not match. Keep in
// sync with the reference server, which the parity suite enforces.
export const MAILBOX_PUSH_ENDPOINT_ALLOWLIST: readonly string[] = [
  // Google (Chrome, Edge, and every Chromium browser on Android)
  "fcm.googleapis.com",
  "android.googleapis.com",
  // Apple (Safari, and the only path that works on iOS)
  "push.apple.com",
  // Mozilla (Firefox)
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
  // Microsoft (legacy Edge / Windows)
  "notify.windows.com"
];

export function isAllowedPushEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  return MAILBOX_PUSH_ENDPOINT_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export interface SealedMailboxPayload {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
}

export function isSealedMailboxPayload(value: unknown): value is SealedMailboxPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<SealedMailboxPayload>;
  return payload.v === 1 &&
    payload.alg === "A256GCM" &&
    isBase64Url(payload.iv) &&
    isBase64Url(payload.ct);
}

export function mailboxBearerToken(headers: { get(name: string): string | null }): string {
  const raw = headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(raw.trim());
  return match ? match[1] : "";
}

function isBase64Url(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}
