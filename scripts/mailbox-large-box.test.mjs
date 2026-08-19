// A mailbox holding more than an isolate can hold must still answer.
//
// This is the defect that took the phone offline on 2026-08-17: every read and
// every append swept the box by listing all of it into memory, so once a busy
// day had filled the mailbox with sealed timeline envelopes the Durable
// Object's isolate exceeded its memory limit and reset — and because the next
// request repeated the same read, it reset again. The desktop logged "Durable
// Object's isolate exceeded its memory limit and was reset", then "Worker threw
// exception", and messages sent from the phone stopped arriving entirely.
//
// Miniflare does not enforce the production isolate ceiling, so this cannot
// assert "does not OOM" directly. What it can assert is the property that
// caused the OOM: the work a single read does is bounded by what the reader
// asked for, not by how much the mailbox holds. A box far larger than the
// ceiling answers, and answers with a bounded page.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import path from "node:path";

import { Miniflare } from "miniflare";

const repoRoot = path.resolve(import.meta.dirname, "..");
const CEILING_BYTES = 6 * 1024 * 1024;
const EVENT_BYTES = 96 * 1024;
const EVENT_COUNT = 200; // ~19 MB in the box: several times the read ceiling.

function credentials(label) {
  const sealKey = createHash("sha256").update(`accord-large-${label}`, "utf8").digest();
  const token = createHmac("sha256", sealKey).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
  const mailboxId = "mb-" + createHmac("sha256", sealKey).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);
  return { token, mailboxId, tokenHashBase64Url: createHash("sha256").update(token, "utf8").digest("base64url") };
}

function bigEvent(index) {
  return {
    eventId: `large-${index}`,
    conversationId: "conversation-large",
    logScopeId: "conversation-large",
    originId: "device-desktop",
    originSeq: index,
    logicalTs: `${String(index).padStart(16, "0")}:device-desktop:conversation-large`,
    kind: "mobile.timeline.events",
    payload: {
      v: 1,
      alg: "A256GCM",
      iv: randomBytes(12).toString("base64url"),
      // A sealed whole-conversation timeline is this order of magnitude once a
      // chat has been running for a day.
      ct: randomBytes(EVENT_BYTES).toString("base64url")
    },
    payloadHash: `sha256-payload-${index}`,
    eventHash: `sha256-event-${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 17, 0, 0, index % 60)).toISOString()
  };
}

test("a mailbox larger than the read ceiling still answers, in bounded pages", async (t) => {
  const mf = new Miniflare({
    scriptPath: path.join(repoRoot, "dist/relay-worker/index.mjs"),
    modules: true,
    compatibilityDate: "2026-08-08",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      RELAY_ROOMS: { className: "RelayRoom", useSQLite: true },
      MAILBOXES: { className: "SealedMailboxStore", useSQLite: true }
    },
    bindings: { ACCORD_RELAY_PROVIDER: "cloudflare-durable-object" }
  });
  await mf.ready;

  const creds = credentials("box");
  const call = (pathname, { method = "GET", body, query = {} } = {}) => {
    const url = new URL(pathname, "https://relay.test");
    url.searchParams.set("mailboxId", creds.mailboxId);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return mf.dispatchFetch(url.toString(), {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  };

  try {
    assert.equal((await call("/v1/mailbox/register", {
      method: "POST",
      body: { tokenHashBase64Url: creds.tokenHashBase64Url }
    })).status, 200);

    for (let index = 1; index <= EVENT_COUNT; index += 1) {
      const response = await call("/v1/mailbox/events", { method: "POST", body: { events: [bigEvent(index)] } });
      assert.equal(response.status, 200, `append ${index} must succeed on a filling mailbox`);
    }

    // 1. The box answers at all. Before the fix this is where a production
    //    isolate died and stayed dead.
    const cursorRead = await call("/v1/mailbox/events", { query: { afterArrival: 0, limit: 1000 } });
    assert.equal(cursorRead.status, 200, "a full mailbox must still answer a cursor read");
    const cursorBody = await cursorRead.json();
    assert.ok(cursorBody.events.length > 0, "a cursor read returns progress, not an empty page");

    // 2. The answer is bounded by the ceiling rather than by the box. The
    //    reader asked for 1000 events and the box holds 200 of them, so an
    //    unbounded read would return every one — about 19 MB.
    const cursorBytes = JSON.stringify(cursorBody.events).length;
    assert.ok(
      cursorBytes <= CEILING_BYTES * 1.1,
      `a cursor page must stay near the ceiling, got ${(cursorBytes / 1024 / 1024).toFixed(1)} MB`
    );
    assert.ok(cursorBody.events.length < EVENT_COUNT, "the whole box must not come back in one page");

    // 3. The cursor still advances to the end: bounded pages must not mean a
    //    reader that can never catch up.
    let cursor = 0;
    let seen = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await call("/v1/mailbox/events", { query: { afterArrival: cursor, limit: 1000 } });
      assert.equal(response.status, 200, "every page must answer");
      const body = await response.json();
      if (body.events.length === 0) {
        break;
      }
      for (const event of body.events) {
        assert.ok(event.arrivalSeq > cursor, "pages are strictly ascending and contiguous");
        cursor = event.arrivalSeq;
      }
      seen += body.events.length;
    }
    assert.equal(seen, EVENT_COUNT, "paging reaches every event in the box");

    // 4. Tail reads are bounded the same way — the phone uses them on open.
    const tailRead = await call("/v1/mailbox/events", { query: { tail: "true", limit: 1000 } });
    assert.equal(tailRead.status, 200, "a full mailbox must still answer a tail read");
    const tailBody = await tailRead.json();
    const tailBytes = JSON.stringify(tailBody.events).length;
    assert.ok(
      tailBytes <= CEILING_BYTES * 1.1,
      `a tail page must stay near the ceiling, got ${(tailBytes / 1024 / 1024).toFixed(1)} MB`
    );
    // Tail means newest: the last event stored must be in it.
    assert.equal(
      tailBody.events[tailBody.events.length - 1].eventId,
      `large-${EVENT_COUNT}`,
      "a bounded tail page still ends at the newest event"
    );

    t.diagnostic(`box ~${((EVENT_COUNT * EVENT_BYTES) / 1024 / 1024).toFixed(0)} MB; cursor page ${(cursorBytes / 1024 / 1024).toFixed(1)} MB; tail page ${(tailBytes / 1024 / 1024).toFixed(1)} MB`);
  } finally {
    await mf.dispose();
  }
});
