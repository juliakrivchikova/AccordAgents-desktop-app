import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

test("mobile shell builds static installable PWA assets", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });

  const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/mobile/manifest.webmanifest"), "utf8"));
  const worker = await readFile(path.join(repoRoot, "dist/mobile/service-worker.js"), "utf8");
  const app = await readFile(path.join(repoRoot, "dist/mobile/mobile-app.js"), "utf8");
  const icon = await stat(path.join(repoRoot, "dist/mobile/assets/accordagents-mark.png"));

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, ".");
  assert.equal(manifest.background_color, "#eceef2");
  assert.equal(manifest.theme_color, "#eceef2");
  assert.equal(manifest.icons[0].src, "assets/accordagents-mark.png");
  assert.ok(icon.size > 0);
  for (const asset of ["./index.html", "./mobile-app.css?v=", "./mobile-app.js?v=", "./manifest.webmanifest"]) {
    assert.ok(worker.includes(asset), `service worker must precache ${asset}`);
  }
  assert.match(worker, /self\.addEventListener\("push"/);
  assert.match(worker, /accordagents-mobile-shell-v51/);
  assert.match(worker, /Open AccordAgents to sync updates\./);
  // W5 acceptance, static half (necessary but insufficient on its own — the
  // behavioral storage sweep lives in the browser harness):
  // 1. The push handler never reads the push payload; routing authority
  //    comes only from device storage.
  const pushHandler = /self\.addEventListener\("push",[\s\S]*?\n\}\);/.exec(worker)?.[0] ?? "";
  assert.ok(pushHandler, "service worker must have a push handler");
  assert.doesNotMatch(pushHandler, /event\.data/);
  // 2. The service worker never references the seal key or the crypto
  //    contract: it stores sealed envelopes and cannot open them.
  assert.doesNotMatch(worker, /relaySealKeyBase64/);
  assert.doesNotMatch(worker, /AccordMailboxCrypto/);
  assert.doesNotMatch(worker, /openEnvelope\(|deriveAccess\(|crypto\.subtle/);
  assert.doesNotMatch(worker, /localStorage/);
  assert.match(worker, /backgroundMailboxSync/);
  assert.match(worker, /sealedEnvelopes/);
  assert.match(worker, /accord-test-push/);
  // W-B: every IndexedDB write in the background sync must be awaited before
  // returning. The epoch-reset branch previously fired its put and returned
  // straight into db.close(), so a lost reset left a stale cursor against
  // renumbered storage — a silent gap. Pins that the reset branch awaits its
  // transaction, matching the cursor-advance path.
  // Both slice bounds are checked before slicing: a missing end marker makes
  // indexOf return -1, and slice(start, -1) would span nearly the whole file —
  // including the cursor-advance path's own awaited transaction — so the regex
  // would pass with the reset branch's await deleted.
  const resetStart = worker.indexOf("epoch && access.epoch");
  const resetEnd = worker.indexOf("reason: \"epoch reset\"");
  assert.ok(
    resetStart >= 0 && resetEnd > resetStart,
    "epoch-reset branch must exist in the service worker between its two markers"
  );
  assert.match(worker.slice(resetStart, resetEnd), /await new Promise[\s\S]+oncomplete/);
  const html = await readFile(path.join(repoRoot, "dist/mobile/index.html"), "utf8");
  const headers = await readFile(path.join(repoRoot, "dist/mobile/_headers"), "utf8");
  assert.match(headers, /\/service-worker\.js\n\s+Cache-Control: public, max-age=0, must-revalidate/);
  assert.match(headers, /\/mobile-app\.js\n\s+Cache-Control: public, max-age=0, must-revalidate/);
  // W-E: the mobile origin holds a pairing seal key, so the policy that guards
  // it is pinned here rather than trusted. The behavioural proof is the browser
  // harness, which serves the app under this exact policy; this pin is what
  // fails fast if a directive is weakened or dropped in a hurry.
  assert.match(headers, /^\/\*$/m, "the policy must apply to every path, not just the shell");
  const policy = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? "";
  assert.ok(policy, "the mobile origin must ship a Content-Security-Policy");
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ]) {
    assert.ok(policy.includes(directive), `policy must contain ${directive}: ${policy}`);
  }
  // wss: is not redundant with https: — whether one matches the other is
  // engine-dependent, and this gate runs Chromium while the field runs Safari.
  assert.ok(policy.includes("connect-src 'self' https: wss:"), `policy must allow wss: explicitly: ${policy}`);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/, "no escape hatch may be added to the policy");
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(headers, /Permissions-Policy: camera=\(self\)/);
  assert.match(html, /mobile-app\.css\?v=2026-08-19-failed-run-ends-its-rows-v1/);
  assert.match(html, /mobile-app\.js\?v=2026-08-19-failed-run-ends-its-rows-v1/);
  assert.match(html, /data-screen-label="Mobile control"/);
  assert.match(html, /id="chats-screen"/);
  assert.match(html, />Chats</);
  assert.match(html, /id="chat-list"/);
  assert.match(html, /id="timeline-screen"/);
  assert.match(html, /mobile-status-bar/);
  assert.doesNotMatch(html, /aria-label="Participants"/);
  assert.match(html, /mobile-header-spacer/);
  // The composer pill must not be a <label> around the textarea: a tap landing
  // on the label rather than the field focuses it by label activation, which on
  // iOS shows a caret and the accessory bar but never raises the keyboard.
  assert.match(html, /<div class="composer-input-wrap">/);
  assert.doesNotMatch(html, /<label class="composer-input-wrap"/);
  assert.match(html, /<textarea id="composer-input"[^>]*aria-label="Message the room"/);
  // W-M: the live reply opens in its own view, and only a row that can actually
  // be followed advertises itself as openable.
  assert.match(html, /id="stream-view"/);
  assert.match(html, /id="stream-body"/);
  assert.match(app, /function applyStreamableState/);
  // Live relay frames arrive as bytes; stringifying them yielded "[object
  // Blob]" and every live frame was dropped. This is what made streaming show
  // nothing at all.
  assert.match(app, /socket\.binaryType = "arraybuffer"/);
  assert.match(app, /function relayFrameText/);
  assert.doesNotMatch(app, /JSON\.parse\(String\(event\.data\)\)/);
  // A terminal that predates a pending row cannot be that row's ending. This
  // guard is what stops an upstream mislabelling from deleting a live row.
  assert.match(app, /entry\.status === "Running" && entry\.runId/);
  // A phone-started turn's answer runs under a fan-out run id the phone has
  // never seen, so requiring BOTH the run id and the mobile event id to match
  // meant the placeholder never cleared: the answer landed and "Thinking"
  // stayed above it forever. Either key may clear a row, but the mobile event
  // id — which every participant on one phone message shares — clears only
  // placeholder scaffolding, or the first agent to finish would delete a
  // second agent's live row.
  assert.match(app, /const matchesMessage = Boolean\(messageId\) &&/);
  assert.match(app, /const matchesScaffolding = isPlaceholderTimelineContent\(entry\.content\) &&/);
  // A finished message ends its own row, not every pending row of its run: a
  // turn that posts an intermediate note mid-run must keep writing afterwards.
  assert.doesNotMatch(app, /const matchesRun = Boolean\(runId\) && entry\.runId === runId;/);
  assert.doesNotMatch(app, /\(mobileEventId \? entry\.mobileEventId === mobileEventId : true\)/);
  // Stale rows are swept by node identity. Sweeping by "is this key still
  // wanted" kept every node sharing a wanted key, so two nodes under one key
  // left an orphan on screen forever — an answer or a "Thinking" the store no
  // longer had.
  // The in-progress row is published before routing has picked anyone, so a
  // mentionless send has no one to name. Showing "Agent" with a letter avatar
  // invented a member and then swapped identity mid-run.
  assert.match(app, /identified: Boolean\(entry\.participantLabel\)/);
  assert.match(app, /function applyRowIdentity/);
  assert.match(app, /return entry\.identified === false \? "" : \(entry\.participantLabel \|\| "Agent"\)/);
  assert.doesNotMatch(app, /handle\.textContent = participantLabel;/);
  assert.match(
    await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"),
    /\.message-avatar\[data-identified="0"\]/
  );
  // Scaffolding is not a message and must not dress as one: no avatar slot, no
  // handle, no status, no running clock — those belong to a real member. It
  // shows a small pulsing indication where the answer will appear, and it
  // respects reduced motion.
  assert.match(app, /scaffolding: isScaffoldingEntry\(entry\)/);
  assert.match(app, /function renderScaffoldingInto/);
  assert.match(app, /dots\.className = "message-typing"/);
  assert.match(app, /aria-label", "Waiting for a reply"/);
  const css = await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8");
  assert.match(css, /\.message-typing span \{/);
  assert.match(css, /@keyframes typing-pulse/);
  assert.match(
    css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {", css.indexOf(".message-typing"))),
    /\.message-typing span \{\s*animation: none;/
  );
  // Whoever is at the end is following: arriving rows come into sight instead
  // of landing below the fold. Whoever left the end is reading history and is
  // never yanked back — the pill offers the way back instead. The measurement
  // must happen BEFORE the rows are mounted, or appending content is itself
  // what makes the answer "not at the bottom" and the view follows nothing.
  assert.match(app, /const wasAtBottom = isNearBottom\(threadSurface\(\)\);\s*reconcileMessageRows\(list, rows\);/);
  assert.match(app, /if \(wasAtBottom\) \{\s*scrollToLatestWhenSettled\("auto"\);/);
  // A run that dies produces no terminal of its own: the control service's
  // catch writes one under the INGEST run's name, which matches no member's
  // row. Scoped to that name on purpose — one member erroring while another
  // writes carries the same mobile event id and must not clear the other.
  assert.match(app, /function isPhoneMessageFailure/);
  assert.match(app, /status === "error" && Boolean\(mobileEventId\) && runId === "mobile-" \+ mobileEventId/);
  // One writer for the timeline store, so the scaffolding rule cannot be
  // bypassed: the direct put helper is gone.
  assert.doesNotMatch(app, /function putTimelineEntry\(/);
  assert.match(app, /function dedupeRenderRowsByKey/);
  assert.match(app, /if \(!kept\.has\(child\)\) \{/);
  assert.doesNotMatch(app, /if \(!nextKeys\.has\(child\.dataset\.rowKey\)\)/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /width: 390px;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /height: 844px;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /border-radius: 44px;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /background: #eceef2;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /border-radius: 18px 18px 6px 18px;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /height: 46px;/);
  assert.match(app, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(app, /ackedEventIds\.includes\(entry\.eventId\)/);
  assert.match(app, /\/v1\/mailbox\/events/);
  assert.match(app, /return await flushOutboxViaMailbox\(entries, endpoint\)/);
  assert.match(app, /flushOutboxViaMailbox/);
  assert.match(app, /return await flushOutboxViaRelay\(entries, pairing\)[\s\S]+return await flushOutboxViaMailbox\(entries, endpoint\)/);
  // Mailbox traffic is locked and sealed: outbox appends seal the payload
  // with the pairing key, and every mailbox call carries the derived bearer
  // token plus the derived per-pairing mailbox id.
  assert.match(app, /const event = mailboxEventForAppend\(syncing\)/);
  assert.match(app, /event\.payload = JSON\.parse\(await sealRelayPayload\(event\.payload, pairing\.relaySealKeyBase64\)\)/);
  assert.match(app, /events: \[event\]/);
  assert.match(app, /authorization: "Bearer " \+ access\.token/);
  assert.match(app, /openMailboxEnvelopePayload/);
  assert.match(app, /mailboxAuthRejected/);
  // W-N: only a participant's finished message may end a run. The behavioral
  // proof is scripts/mobile-inprogress-row.test.mjs; this pin fails fast if the
  // role guard is dropped, since without it the user's own message comes back
  // in a snapshot as "done" carrying the run's identity and deletes the
  // in-progress row.
  assert.match(app, /status !== "pending" && role === "participant" && \(runId \|\| mobileEventId \|\| messageId\)/);
  // W-K: a refused push endpoint must be recorded and stated, never swallowed.
  // The behavioral proof is scripts/mobile-push-unavailable.test.mjs.
  assert.match(app, /PUSH_ENDPOINT_REJECTED_ERROR = "mailbox_push_endpoint_rejected"/);
  assert.match(app, /pushEndpointRejected = true/);
  assert.match(app, /alertsState = "unavailable"/);
  // The phone cannot import the shared contract module, so it hardcodes the
  // derivation constants. Pin them to src/shared/mailboxSealedPayload.ts:
  // moving the shared contract without updating the phone must fail here,
  // not ship a phone that derives the wrong mailbox and token.
  const sharedContract = await readFile(path.join(repoRoot, "src/shared/mailboxSealedPayload.ts"), "utf8");
  const sharedConstant = (name) => {
    const match = new RegExp(`${name} = "([^"]+)"`).exec(sharedContract);
    assert.ok(match, `shared contract must define ${name}`);
    return match[1];
  };
  const scopeLength = /MAILBOX_SCOPE_ID_LENGTH = (\d+)/.exec(sharedContract)?.[1];
  assert.ok(scopeLength, "shared contract must define MAILBOX_SCOPE_ID_LENGTH");
  assert.match(app, new RegExp(`MAILBOX_AUTH_TOKEN_INFO = "${sharedConstant("MAILBOX_AUTH_TOKEN_INFO")}"`));
  assert.match(app, new RegExp(`MAILBOX_SCOPE_ID_INFO = "${sharedConstant("MAILBOX_SCOPE_ID_INFO")}"`));
  assert.match(app, new RegExp(`MAILBOX_SCOPE_ID_PREFIX = "${sharedConstant("MAILBOX_SCOPE_ID_PREFIX")}"`));
  assert.match(app, new RegExp(`MAILBOX_SCOPE_ID_LENGTH = ${scopeLength}`));
  assert.match(app, new RegExp(sharedConstant("MAILBOX_ERROR_UNREGISTERED")));
  // W4: the crypto section is generated from the single canonical source.
  assert.match(app, /churn without a driver|generated: mailbox-crypto/);
  assert.match(app, /globalThis\.AccordMailboxCrypto = \{/);
  // W1 arrival cursor: the phone remembers one (epoch, cursor) pair instead
  // of a capped ledger of every envelope id, asks only for what is new, and
  // refills once when events expired beneath its cursor.
  assert.match(app, /MAILBOX_CURSOR_KEY = "accordagents\.mobile\.mailboxCursor\.v1"/);
  assert.match(app, /afterArrival/);
  assert.match(app, /oldestArrivalSeq/);
  assert.match(app, /lastStaleRefillKey/);
  assert.doesNotMatch(app, /ingestedMailboxEventIds/);
  assert.match(app, /originSeq/);
  assert.match(app, /logicalTs/);
  assert.match(app, /payloadHash/);
  assert.match(app, /eventHash/);
  assert.match(app, /"sha256:" \+ await sha256Hex\(stableJson\(payload\)\)/);
  assert.match(app, /"mobile:" \+ originId/);
  assert.match(app, /sha256Hex/);
  assert.match(app, /mobile\.timeline\.events/);
  assert.match(app, /pollMailboxTimeline/);
  assert.match(app, /MAILBOX_TIMELINE_POLL_MS = 2_500/);
  assert.match(app, /mobile\.chat-list\.request/);
  assert.match(app, /mobile\.timeline\.request/);
  assert.match(app, /TIMELINE_STORE/);
  assert.match(app, /fragment\.get\("pairing"\)/);
  assert.match(app, /fragment\.get\("k"\)/);
  assert.match(app, /relaySealKeyBase64/);
  assert.match(app, /sealRelayPayload/);
  assert.match(app, /handleRelayTimelinePayload/);
  assert.match(app, /RELAY_ACK_TIMEOUT_MS = 20_000/);
  assert.match(app, /RELAY_TIMELINE_IDLE_MS = 15 \* 60_000/);
  assert.match(app, /activeFlushOutboxPromise/);
  assert.match(app, /Tunnel reconnecting/);
  assert.match(app, /renderMessageContentIfChanged\(content, entry\.content\)/);
  assert.match(app, /appendInlineMarkdown/);
  assert.doesNotMatch(app, /content\.textContent = entry\.content/);
  assert.match(app, /putTimelineEntryDeduped/);
  assert.match(app, /timelineEntryDedupeKey/);
  assert.match(app, /dedupeTimelineEntries/);
  assert.match(app, /reconcileMessageRows\(list, rows\)/);
  assert.match(app, /timelineRenderRowKey/);
  assert.match(app, /updateMessageRow\(item, entry\)/);
  assert.match(app, /renderMessageContentIfChanged/);
  assert.doesNotMatch(app, /list\.textContent = ""/);
  assert.match(app, /const flushResult = await flushOutbox\(\);\n\s*await pollMailboxTimeline\(\)\.catch/);
  assert.match(app, /requestTimelineViaRelay\(pairing, chat\.id\)[\s\S]+pollMailboxTimeline\(\)\.catch/);
  assert.match(app, /globalThis\.AccordAgentsMobile/);
});

test("mobile shell sends only sealed relay frames that the desktop can decrypt by pairing key", async () => {
  await execFileAsync("npm", ["run", "build:main"], {
    cwd: repoRoot
  });
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const mobile = globalThis.AccordAgentsMobile;
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const key = bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const desktop = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "rv-mobile-shell",
      role: "desktop",
      capability: "PAIRING-FINGERPRINT",
      streamId: "route-mobile-shell:phone"
    });
    const received = nextMessage(desktop);

    await desktop.connect();
    const phone = await openPhoneSocket(address.url, "rv-mobile-shell", "PAIRING-FINGERPRINT");
    const sealed = await mobile.sealRelayPayload({
      type: "mobile.outbox.events",
      events: [{ eventId: "event-mobile-1", payload: { content: "relay secret text" } }]
    }, key);
    assert.doesNotMatch(sealed, /relay secret text/);
    const frames = mobile.chunkRelayCiphertext({
      streamId: "route-mobile-shell:phone",
      logicalMessageId: "event-mobile-1",
      ciphertext: sealed
    });
    for (const frame of frames) {
      phone.send(JSON.stringify(frame));
    }

    const message = await received;
    assert.equal(message.logicalMessageId, "event-mobile-1");
    assert.doesNotMatch(message.ciphertext, /relay secret text/);
    const opened = await mobile.openRelayPayload(message.ciphertext, key);
    assert.equal(opened.events[0].payload.content, "relay secret text");
    phone.close();
    desktop.close();
  } finally {
    await relay.close();
  }
});

test("mobile shell collapses duplicate terminal timeline entries by run identity", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const rows = mobile.dedupeTimelineEntries([
    {
      id: "conversation:progress-message",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same terminal result",
      status: "done",
      createdAt: "2026-08-13T00:00:00.000Z",
      runId: "mobile-event-1"
    },
    {
      id: "conversation:snapshot-message",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same terminal result",
      status: "done",
      createdAt: "2026-08-13T00:00:01.000Z",
      runId: "mobile-event-1"
    }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "conversation:snapshot-message");
});

test("mobile shell collapses duplicate terminal timeline entries by mobile event identity", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const rows = mobile.dedupeTimelineEntries([
    {
      id: "conversation:cloud-worker-message",
      conversationId: "conversation-1",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same visible cloud result",
      status: "done",
      createdAt: "2026-08-13T00:00:00.000Z",
      runId: "mobile-event-1",
      messageId: "cloud-worker-message",
      mobileEventId: "event-1"
    },
    {
      id: "conversation:desktop-snapshot-message",
      conversationId: "conversation-1",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same visible cloud result",
      status: "done",
      createdAt: "2026-08-13T00:00:01.000Z",
      runId: "desktop-replay-event-1",
      messageId: "desktop-snapshot-message",
      mobileEventId: "event-1"
    }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "conversation:desktop-snapshot-message");
});

test("mobile shell gives scaffolding one row and every real message its own", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const pending = {
    id: "conversation:pending",
    conversationId: "conversation-1",
    role: "participant",
    participantLabel: "@codex",
    content: "@codex is running...",
    status: "pending",
    runId: "mobile-run-1",
    mobileEventId: "mobile-event-1"
  };
  const terminal = {
    id: "conversation:done",
    conversationId: "conversation-1",
    role: "participant",
    participantLabel: "@codex",
    content: "final result",
    status: "done",
    runId: "mobile-run-1",
    mobileEventId: "mobile-event-1",
    messageId: "conversation:done",
    sourceId: "conversation:done"
  };
  // These used to share a row key so the placeholder could BECOME the answer in
  // one stable DOM node. That contract cannot survive a turn that posts more
  // than one message: keyed by the phone message, an intermediate note and the
  // still-live answer collapsed into one row, so the note ate the live row and
  // the turn looked finished while it was still writing. Scaffolding is now
  // retired when a real row arrives — in the same write transaction, so the two
  // cannot both be on screen — and every real message keeps its own row.
  assert.notEqual(mobile.timelineRenderRowKey(pending), mobile.timelineRenderRowKey(terminal));
  assert.match(mobile.timelineRenderRowKey(pending), /^timeline-mobile\0conversation-1\0mobile-event-1\0@codex$/);
  assert.match(mobile.timelineRenderRowKey(terminal), /^timeline-message\0conversation-1\0conversation:done\0@codex$/);
  // Two real messages from one run are two rows, not one.
  const interim = { ...terminal, id: "conversation:interim", messageId: "conversation:interim", sourceId: "conversation:interim", content: "an interim note" };
  assert.notEqual(mobile.timelineRenderRowKey(interim), mobile.timelineRenderRowKey(terminal));
  // Replayed scaffolding for the same phone message stays one row.
  assert.equal(
    mobile.timelineRenderRowKey({ ...pending, id: "conversation:pending-again" }),
    mobile.timelineRenderRowKey(pending)
  );
});

function openPhoneSocket(relayUrl, rendezvousId, capability) {
  const url = new URL(relayUrl);
  url.searchParams.set("rid", rendezvousId);
  url.searchParams.set("role", "phone");
  url.searchParams.set("cap", capability);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(client) {
  return new Promise((resolve) => {
    const off = client.on("message", (message) => {
      off();
      resolve(message);
    });
  });
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
