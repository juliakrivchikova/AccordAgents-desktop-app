import { createHash, createHmac } from "node:crypto";
import {
  MAILBOX_AUTH_TOKEN_INFO,
  MAILBOX_DELETE_PATH,
  MAILBOX_REGISTER_PATH,
  MAILBOX_REVOKE_PATH,
  MAILBOX_SCOPE_ID_INFO,
  MAILBOX_SCOPE_ID_LENGTH,
  MAILBOX_SCOPE_ID_PREFIX,
  isSealedMailboxPayload
} from "../../shared/mailboxSealedPayload";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

// Both credentials are one-way derivations from the pairing seal key: the
// relay learns the scope id and (the hash of) the token but can never recover
// the key, and the phone can derive the same values from the pairing link
// without any new package fields.
export function mailboxScopeIdForSealKey(relaySealKeyBase64: string): string {
  const digest = hmacBase64Url(relaySealKeyBase64, MAILBOX_SCOPE_ID_INFO);
  return `${MAILBOX_SCOPE_ID_PREFIX}${digest.slice(0, MAILBOX_SCOPE_ID_LENGTH)}`;
}

export function mailboxAccessTokenForSealKey(relaySealKeyBase64: string): string {
  return hmacBase64Url(relaySealKeyBase64, MAILBOX_AUTH_TOKEN_INFO);
}

export function mailboxTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export interface MailboxAccess {
  scopeId: string;
  token: string;
  tokenHash: string;
}

export function mailboxAccessForSealKey(relaySealKeyBase64: string): MailboxAccess {
  const token = mailboxAccessTokenForSealKey(relaySealKeyBase64);
  return {
    scopeId: mailboxScopeIdForSealKey(relaySealKeyBase64),
    token,
    tokenHash: mailboxTokenHash(token)
  };
}

// Rewrites any mailbox endpoint so it targets the pairing's own locked
// mailbox, regardless of what mailboxId (if any) the stored URL carries.
// Older pairings persisted URLs pointing at the shared default mailbox; the
// scope override is what lets them converge on the locked one without
// re-pairing.
export function mailboxEndpointForSealKey(url: string, relaySealKeyBase64: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("mailboxId", mailboxScopeIdForSealKey(relaySealKeyBase64));
  return parsed.toString();
}

export function mailboxAuthHeaders(relaySealKeyBase64: string): Record<string, string> {
  return { authorization: `Bearer ${mailboxAccessTokenForSealKey(relaySealKeyBase64)}` };
}

// Transport sealing: hashes and signatures on an envelope stay computed over
// the plaintext payload, so sealing wraps only what travels and readers
// unseal before the existing verification pipeline runs.
export async function sealMailboxEventPayloads(
  events: unknown[],
  relaySealKeyBase64: string
): Promise<unknown[]> {
  return Promise.all(events.map(async (event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return event;
    }
    const envelope = event as { payload?: unknown };
    if (isSealedMailboxPayload(envelope.payload)) {
      return event;
    }
    const sealed = JSON.parse(await sealMobileRelayPayload(envelope.payload, relaySealKeyBase64)) as unknown;
    return { ...envelope, payload: sealed };
  }));
}

export interface OpenedMailboxEvents {
  events: ChatEventEnvelope[];
  unreadableEventIds: string[];
}

export async function openMailboxEventPayloads(
  events: unknown[],
  relaySealKeyBase64: string
): Promise<OpenedMailboxEvents> {
  const opened: ChatEventEnvelope[] = [];
  const unreadableEventIds: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const envelope = event as { eventId?: unknown; payload?: unknown };
    if (!isSealedMailboxPayload(envelope.payload)) {
      // A plaintext payload in a locked mailbox means a writer that bypassed
      // the client contract; never process it.
      unreadableEventIds.push(typeof envelope.eventId === "string" ? envelope.eventId : "");
      continue;
    }
    try {
      const payload = await openMobileRelayPayload<unknown>(JSON.stringify(envelope.payload), relaySealKeyBase64);
      opened.push({ ...(event as ChatEventEnvelope), payload });
    } catch {
      unreadableEventIds.push(typeof envelope.eventId === "string" ? envelope.eventId : "");
    }
  }
  return { events: opened, unreadableEventIds };
}

export interface MailboxRegistrationResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** W-G(e)/W-I: how a failed registration must be treated.
 *  - "revoked": the mailbox is tombstoned — terminal, stop everything.
 *  - "lockout": the relay refused our token outright. Registration is
 *    trust-on-first-use, so this means someone else registered the scope id
 *    first (the pre-registration window W-I names). Retrying can never
 *    succeed and must stop loudly, not silently.
 *  - "transient": everything else — network, 5xx — keeps the existing
 *    self-heal retry behavior. */
export function classifyMailboxRegistrationFailure(
  result: MailboxRegistrationResult
): "revoked" | "lockout" | "transient" {
  if (result.ok) {
    return "transient";
  }
  const error = result.error ?? "";
  if (error.includes("mailbox_revoked")) {
    return "revoked";
  }
  if (result.status === 401 && error.includes("mailbox_unauthorized")) {
    return "lockout";
  }
  return "transient";
}

export async function registerMailboxForSealKey(
  outboxUrl: string,
  relaySealKeyBase64: string,
  fetchImpl: typeof fetch = fetch
): Promise<MailboxRegistrationResult> {
  const access = mailboxAccessForSealKey(relaySealKeyBase64);
  const url = new URL(outboxUrl);
  url.pathname = MAILBOX_REGISTER_PATH;
  url.search = "";
  url.searchParams.set("mailboxId", access.scopeId);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${access.token}`
    },
    body: JSON.stringify({ tokenHashBase64Url: access.tokenHash }),
    signal: AbortSignal.timeout(8_000)
  });
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    ...(response.ok ? {} : { error: body.slice(0, 500) })
  };
}

export async function revokeMailboxForSealKey(
  outboxUrl: string,
  relaySealKeyBase64: string,
  fetchImpl: typeof fetch = fetch
): Promise<MailboxRegistrationResult> {
  const access = mailboxAccessForSealKey(relaySealKeyBase64);
  return revokeMailboxWithToken(outboxUrl, access.scopeId, access.token, fetchImpl);
}

// Revoke retries run after the pairing (and its seal key) has been dropped,
// so they carry only the derived scope id and token.
export async function revokeMailboxWithToken(
  outboxUrl: string,
  scopeId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<MailboxRegistrationResult> {
  const url = new URL(outboxUrl);
  url.pathname = MAILBOX_REVOKE_PATH;
  url.search = "";
  url.searchParams.set("mailboxId", scopeId);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000)
  });
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    ...(response.ok ? {} : { error: body.slice(0, 500) })
  };
}

// W3: the owner deletes its own superseded progress envelopes once a run's
// terminal snapshot is durable. Ids only; nothing new is disclosed.
export async function deleteMailboxEvents(
  outboxUrl: string,
  relaySealKeyBase64: string,
  eventIds: string[],
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status: number; deletedEventIds: string[] }> {
  const access = mailboxAccessForSealKey(relaySealKeyBase64);
  const url = new URL(outboxUrl);
  url.pathname = MAILBOX_DELETE_PATH;
  url.search = "";
  url.searchParams.set("mailboxId", access.scopeId);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${access.token}`
    },
    body: JSON.stringify({ eventIds }),
    signal: AbortSignal.timeout(8_000)
  });
  const body = await response.json().catch(() => ({})) as { deletedEventIds?: unknown };
  return {
    ok: response.ok,
    status: response.status,
    deletedEventIds: Array.isArray(body.deletedEventIds)
      ? body.deletedEventIds.filter((id): id is string => typeof id === "string")
      : []
  };
}

function hmacBase64Url(relaySealKeyBase64: string, info: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(relaySealKeyBase64)) {
    throw new Error("Mailbox access derivation requires a base64url seal key.");
  }
  return createHmac("sha256", Buffer.from(relaySealKeyBase64, "base64url"))
    .update(info, "utf8")
    .digest("base64url");
}
