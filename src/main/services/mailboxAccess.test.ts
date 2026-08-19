import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  classifyMailboxRegistrationFailure,
  mailboxAccessForSealKey,
  mailboxAccessTokenForSealKey,
  mailboxAuthHeaders,
  mailboxEndpointForSealKey,
  mailboxScopeIdForSealKey,
  mailboxTokenHash,
  openMailboxEventPayloads,
  registerMailboxForSealKey,
  revokeMailboxForSealKey,
  sealMailboxEventPayloads
} from "./mailboxAccess";
import {
  MAILBOX_AUTH_TOKEN_INFO,
  MAILBOX_SCOPE_ID_INFO,
  isSealedMailboxPayload
} from "../../shared/mailboxSealedPayload";

const requireScript = createRequire(__filename);
const { createReferenceMailboxServer } = requireScript(path.join(process.cwd(), "scripts/mailbox-reference-server.cjs")) as {
  createReferenceMailboxServer(options?: { locked?: boolean }): {
    listen(): Promise<{ url: string }>;
    close(): Promise<void>;
  };
};

const SEAL_KEY = "kA5cW1zXhKfQ2m9v4B7nR8tY3uJ6pL0sD1gF5hE9qZc";

test("mailbox access derivations are deterministic, distinct, and never expose the seal key", () => {
  const access = mailboxAccessForSealKey(SEAL_KEY);
  assert.equal(access.scopeId, mailboxScopeIdForSealKey(SEAL_KEY));
  assert.equal(access.token, mailboxAccessTokenForSealKey(SEAL_KEY));
  assert.equal(access.tokenHash, mailboxTokenHash(access.token));
  assert.match(access.scopeId, /^mb-[A-Za-z0-9_-]{32}$/);
  assert.match(access.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(access.token, SEAL_KEY);
  assert.equal(access.token.includes(SEAL_KEY), false);
  assert.equal(access.scopeId.includes(SEAL_KEY.slice(0, 12)), false);
  // Scope and auth derivations must differ so learning one reveals nothing
  // about the other.
  assert.notEqual(access.scopeId.slice(3), access.token.slice(0, 32));
});

test("desktop implementation reproduces the single-source known-answer fixture", async () => {
  const vectors = JSON.parse(
    await (await import("node:fs/promises")).readFile(path.join(process.cwd(), "scripts/mailbox-contract-vectors.json"), "utf8")
  ) as { sealKey: string; expectedToken: string; expectedScopeId: string; sealedSample: unknown; sealedSamplePayload: unknown };
  const access = mailboxAccessForSealKey(vectors.sealKey);
  assert.equal(access.token, vectors.expectedToken);
  assert.equal(access.scopeId, vectors.expectedScopeId);
  const opened = await openMailboxEventPayloads([
    { eventId: "vector-event", payload: vectors.sealedSample }
  ], vectors.sealKey);
  assert.equal(opened.unreadableEventIds.length, 0);
  assert.deepEqual(opened.events[0]?.payload, vectors.sealedSamplePayload);
});

test("mailbox access derivation matches the WebCrypto HMAC the phone computes", async () => {
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(SEAL_KEY, "base64url"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const token = Buffer.from(
    await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(MAILBOX_AUTH_TOKEN_INFO))
  ).toString("base64url");
  const scopeDigest = Buffer.from(
    await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(MAILBOX_SCOPE_ID_INFO))
  ).toString("base64url");

  assert.equal(token, mailboxAccessTokenForSealKey(SEAL_KEY));
  assert.equal(`mb-${scopeDigest.slice(0, 32)}`, mailboxScopeIdForSealKey(SEAL_KEY));
});

test("mailbox endpoint override always targets the pairing's own mailbox", () => {
  const scoped = mailboxEndpointForSealKey("https://relay.example.test/v1/mailbox/events?mailboxId=managed", SEAL_KEY);
  const url = new URL(scoped);
  assert.equal(url.searchParams.get("mailboxId"), mailboxScopeIdForSealKey(SEAL_KEY));
  const bare = mailboxEndpointForSealKey("https://relay.example.test/v1/mailbox/events", SEAL_KEY);
  assert.equal(new URL(bare).searchParams.get("mailboxId"), mailboxScopeIdForSealKey(SEAL_KEY));
});

test("transport sealing wraps payloads and unsealing restores them; plaintext is never processed", async () => {
  const events = [{
    eventId: "event-1",
    conversationId: "conversation-1",
    payload: { type: "mobile.timeline.events", events: [{ id: "m1", content: "secret" }] }
  }];
  const sealed = await sealMailboxEventPayloads(events, SEAL_KEY);
  const sealedPayload = (sealed[0] as { payload: unknown }).payload;
  assert.equal(isSealedMailboxPayload(sealedPayload), true);
  assert.equal(JSON.stringify(sealedPayload).includes("secret"), false);

  const opened = await openMailboxEventPayloads(sealed, SEAL_KEY);
  assert.equal(opened.unreadableEventIds.length, 0);
  assert.deepEqual(opened.events[0]?.payload, events[0].payload);

  const mixed = await openMailboxEventPayloads([
    ...sealed,
    { eventId: "plaintext-1", payload: { content: "not sealed" } }
  ], SEAL_KEY);
  assert.deepEqual(mixed.unreadableEventIds, ["plaintext-1"]);
  assert.equal(mixed.events.length, 1);

  const wrongKey = await openMailboxEventPayloads(sealed, "A".repeat(43));
  assert.deepEqual(wrongKey.unreadableEventIds, ["event-1"]);
  assert.equal(wrongKey.events.length, 0);
});

test("register and revoke clients drive the locked mailbox lifecycle end to end", async () => {
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const outboxUrl = `${address.url}/v1/mailbox/events`;
  const access = mailboxAccessForSealKey(SEAL_KEY);
  try {
    // Locked mailboxes answer nothing before registration.
    const before = await fetch(mailboxEndpointForSealKey(outboxUrl, SEAL_KEY), {
      headers: mailboxAuthHeaders(SEAL_KEY)
    });
    assert.equal(before.status, 401);

    const registered = await registerMailboxForSealKey(outboxUrl, SEAL_KEY);
    assert.equal(registered.ok, true);
    const again = await registerMailboxForSealKey(outboxUrl, SEAL_KEY);
    assert.equal(again.ok, true);

    const sealed = await sealMailboxEventPayloads([{
      eventId: "event-1",
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      originId: "device-1",
      originSeq: 1,
      logicalTs: "0000000000000001:device-1:conversation-1",
      kind: "mobile.timeline.events",
      payload: { type: "mobile.timeline.events", events: [] },
      payloadHash: "sha256:payload",
      eventHash: "sha256:event",
      createdAt: "2026-08-16T00:00:00.000Z"
    }], SEAL_KEY);
    const append = await fetch(mailboxEndpointForSealKey(outboxUrl, SEAL_KEY), {
      method: "POST",
      headers: { "content-type": "application/json", ...mailboxAuthHeaders(SEAL_KEY) },
      body: JSON.stringify({ events: sealed })
    });
    assert.equal(append.status, 200);

    // A caller without the token is refused even after registration.
    const unauthorized = await fetch(mailboxEndpointForSealKey(outboxUrl, SEAL_KEY));
    assert.equal(unauthorized.status, 401);

    const revoked = await revokeMailboxForSealKey(outboxUrl, SEAL_KEY);
    assert.equal(revoked.ok, true);
    const after = await fetch(mailboxEndpointForSealKey(outboxUrl, SEAL_KEY), {
      headers: { authorization: `Bearer ${access.token}` }
    });
    assert.equal(after.status, 401);
  } finally {
    await mailbox.close();
  }
});

// W-I: the retry decision is the security behavior — a refused token means
// the trust-on-first-use slot is already taken, and retrying forever would
// keep the lockout silent.
test("classifyMailboxRegistrationFailure separates revoked, lockout and transient", () => {
  assert.equal(
    classifyMailboxRegistrationFailure({ ok: false, status: 401, error: '{"ok":false,"error":"mailbox_revoked"}' }),
    "revoked"
  );
  assert.equal(
    classifyMailboxRegistrationFailure({ ok: false, status: 401, error: '{"ok":false,"error":"mailbox_unauthorized"}' }),
    "lockout"
  );
  assert.equal(classifyMailboxRegistrationFailure({ ok: false, status: 500, error: "upstream error" }), "transient");
  assert.equal(classifyMailboxRegistrationFailure({ ok: false, status: 401, error: "" }), "transient");
  assert.equal(classifyMailboxRegistrationFailure({ ok: true, status: 200 }), "transient");
});
