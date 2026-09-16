/**
 * Answering a cloud member's question from the phone, with the desktop up.
 *
 * The real PWA in a real browser, the real card projection the desktop sends
 * (`controlCardsFromConversation`), the real chat-action publication the
 * desktop performs for a phone answer, the real machine runtime applying it,
 * and the machine's result travelling back into the desktop's copy.
 *
 * Stood in for: the relay tunnel wrappers only. The mailbox is the reference
 * server the other mobile checks use, and the desktop's snapshot loop is
 * driven here rather than by Electron's conversation callback -- it calls the
 * same card builder with the same conversation.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require(path.join(repoRoot, "scripts/relay-reference-server.cjs"));
const { createReferenceMailboxServer } = require(path.join(repoRoot, "scripts/mailbox-reference-server.cjs"));
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require(path.join(repoRoot, "scripts/mobile-origin-headers.cjs"));
const { attach } = require(path.join(repoRoot, "scripts/cdp.cjs"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));
const { controlCardsFromConversation } = require(path.join(repoRoot, "dist/main/shared/mobileControlCards.js"));

const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const CONVERSATION = "cloud-choice-phone";
const MACHINE_ID = "machine-one";
const ROOM = "room-choice-phone";
const PARTICIPANT_ID = "p-one";
const CHOICE_ID = "choice-phone-1";
const CHOICE_MESSAGE_ID = "m-choice-phone-1";
const SITE_PORT = 8185;
const MAILBOX_PORT = 8186;
const CDP_PORT = 9375;

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);

const seal = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64url") };
};
const open = (sealed) => {
  if (!sealed || sealed.alg !== "A256GCM") return undefined;
  try {
    const raw = Buffer.from(sealed.ct, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKeyBuffer, Buffer.from(sealed.iv, "base64url"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8"));
  } catch { return undefined; }
};

const spawned = new Set();
function stopSpawned() {
  for (const child of spawned) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  spawned.clear();
}
process.on("exit", stopSpawned);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopSpawned(); process.exit(1); });

const log = (...args) => console.log("[phone-choice]", ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await wait(300);
  }
}
async function machineLog(userData, output) {
  try {
    const files = await readdir(path.join(userData, "debug-logs"));
    const parts = await Promise.all(files.map((f) => readFile(path.join(userData, "debug-logs", f), "utf8").catch(() => "")));
    return parts.join("") + output.join("");
  } catch { return output.join(""); }
}

function desktopSettings(records, pairings) {
  return {
    listMachines: async () => records,
    saveMachine: async (next) => {
      const index = records.findIndex((record) => record.id === next.id);
      if (index >= 0) Object.assign(records[index], next); else records.push(next);
      return records;
    },
    removeMachine: async () => records,
    getMachinePairing: async (key) => pairings.get(key),
    exportMachineSettingsSnapshot: async () => ({
      version: 1, exportedAt: new Date().toISOString(),
      settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer", label: "Phone choice QA", version: 1,
        instructions: "Isolated transport verification.", updatedAt: "2026-09-07T00:00:00Z" }] }),
      agentEnvironment: []
    })
  };
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-phone-choice-"));

  const mailbox = createReferenceMailboxServer({ locked: true });
  const mailboxServer = mailbox.server ?? mailbox;
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));

  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  const root = path.join(repoRoot, "dist/mobile");
  const originHeaders = loadMobileOriginHeaders(root);
  const site = createServer(async (req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/v1/mailbox/") || url.startsWith("/v1/push/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch(`http://127.0.0.1:${MAILBOX_PORT}${url}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] || "application/json",
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks)
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    const rel = url.split("?")[0];
    const file = path.join(root, rel === "/" ? "index.html" : rel);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        ...mobileOriginHeadersForPath(originHeaders, rel) });
      res.end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

  await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
  }).then((r) => assert.ok(r.ok, "mailbox registration failed"));

  // --- the machine, and the desktop's link to it ----------------------------
  const relay = createReferenceRelayServer({});
  const address = await relay.listen();
  const ownerStorage = new StorageService({ dbPath: path.join(dir, "owner.sqlite3") });
  const ownerLog = new ChatEventLogService(ownerStorage);
  const owner = await ownerLog.getOrCreateDeviceIdentity();
  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: { originId: owner.originId, keyId: owner.keyId, publicKeyDerBase64: owner.publicKeyDerBase64 },
    rendezvousId: ROOM, stableRoutingId: "route-choice-phone",
    relaySealKeyBase64: Buffer.alloc(32, 47).toString("base64url"), relayUrl: address.url,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "PHONE-CHOICE", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const pairings = new Map([[ROOM, pairing]]);
  const records = [{ id: MACHINE_ID, name: "Machine one", deviceId: "", pairingKey: ROOM, createdAt: new Date().toISOString() }];
  const enrollmentPath = path.join(dir, "enrollment.json");
  await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");
  const machineUserData = path.join(dir, "machine");
  const machineOutput = [];
  const machineChild = spawn(process.execPath, [
    path.join(repoRoot, "dist/machine/accordagents-machine.cjs"),
    "--enrollment", enrollmentPath, "--user-data", machineUserData, "--name", "Machine one"
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ACCORD_AGENTS_DEBUG_LOGS: "1" } });
  machineChild.stdout.on("data", (c) => machineOutput.push(String(c)));
  machineChild.stderr.on("data", (c) => machineOutput.push(String(c)));
  spawned.add(machineChild);

  // The desktop's copy of the chat, kept here and updated by the machine's
  // back delta exactly as ChatService.applyMachineBackDelta does.
  const now = new Date().toISOString();
  const participant = { id: PARTICIPANT_ID, handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: MACHINE_ID };
  const conversation = {
    id: CONVERSATION, kind: "chat", title: "Phone choice", createdAt: now, updatedAt: now,
    messages: [
      { id: "seed-1", role: "user", content: "Setting up.", status: "done", createdAt: now },
      { id: CHOICE_MESSAGE_ID, role: "participant", participantId: PARTICIPANT_ID, participantHandle: "one",
        participantLabel: "@one", content: "I need one decision.", status: "done", createdAt: now,
        metadata: { pendingChoice: { id: CHOICE_ID, title: "Investment horizon", question: "Which horizon?",
          options: [{ id: "o1", label: "Long term" }, { id: "o2", label: "Short term" }], status: "pending" } } }
    ],
    findings: [], metadata: { participants: [participant] }
  };

  const ownerLink = new MachineLinkService(desktopSettings(records, pairings), { write: async () => undefined }, {
    eventStorage: ownerStorage, eventLog: ownerLog, appVersion: "phone-choice",
    desktopDeviceId: owner.originId, reconnectDelayMs: 50,
    trustedDevices: async () => []
  });
  ownerLink.setConversationLoader?.(async (id) => (id === CONVERSATION ? conversation : undefined));
  if (typeof ownerLink.onConversationBackDelta === "function") {
    ownerLink.onConversationBackDelta(async (delta) => {
      for (const message of delta.messages) {
        const index = conversation.messages.findIndex((item) => item.id === message.id);
        if (index >= 0) conversation.messages[index] = message; else conversation.messages.push(message);
      }
      conversation.updatedAt = new Date().toISOString();
      log("desktop stored the machine's back delta:",
        JSON.stringify(conversation.messages.find((m) => m.id === CHOICE_MESSAGE_ID)?.metadata?.pendingChoice?.status));
    });
  }
  await ownerLink.start();
  assert.ok(await waitFor(() => ownerLink.isMachineConnected(MACHINE_ID), 90_000), "the desktop never reached the machine");
  assert.ok(await waitFor(() => Boolean(records[0].deviceId), 60_000), "the machine never introduced itself");
  await ownerLink.replicateConversation(conversation);
  await ownerStorage.saveConversation(conversation);
  log("machine connected and holding the chat");

  // --- the desktop's snapshots to the phone --------------------------------
  let envelopeSeq = 0;
  let lastCardsJson = "";
  const publishSnapshot = async (force = false) => {
    const cards = controlCardsFromConversation(conversation);
    const json = JSON.stringify(cards);
    if (!force && json === lastCardsJson) return;
    lastCardsJson = json;
    envelopeSeq += 1;
    const events = conversation.messages.map((message) => ({
      id: message.id, messageId: message.id,
      role: message.role === "user" ? "you" : message.role === "system" ? "system" : "participant",
      participantLabel: message.participantLabel, content: message.content, status: "done", createdAt: message.createdAt
    }));
    await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
      body: JSON.stringify({ events: [{ eventId: `snapshot-${envelopeSeq}`, conversationId: CONVERSATION,
        logScopeId: CONVERSATION, originId: "desktop-origin", originSeq: envelopeSeq, eventHash: `hash-${envelopeSeq}`,
        kind: "mobile.timeline.events",
        payload: seal({ type: "mobile.timeline.events", conversationId: CONVERSATION, events, cards }) }] })
    });
    log("desktop published cards:", json);
  };
  await publishSnapshot(true);

  // --- the phone ------------------------------------------------------------
  const profile = await mkdtemp(path.join(tmpdir(), "aa-phone-choice-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--window-size=430,860",
    `http://127.0.0.1:${SITE_PORT}/`], { stdio: "ignore" });
  spawned.add(chrome);

  let app;
  for (let attempt = 0; attempt < 60 && !app; attempt += 1) {
    try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); } catch { await wait(500); }
  }
  assert.ok(app, "could not attach to Chrome");
  const evaluate = async (expr) => {
    const result = await app.evaluate(expr);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await evaluate(`(() => {
    localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
      endpoint: "http://127.0.0.1:${SITE_PORT}/",
      outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
      conversationId: "${CONVERSATION}",
      relaySealKeyBase64: "${SEAL_KEY}",
      pairedAt: new Date(0).toISOString()
    }));
    localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
      { id: "${CONVERSATION}", title: "Phone choice", group: "AccordAgents", snippet: "QA",
        updatedAt: new Date(0).toISOString(), participants: ["@one"] }
    ]));
    localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
    return true;
  })()`);
  await evaluate("location.reload()");
  await wait(2500);
  app = await attach({ port: CDP_PORT, title: "AccordAgents" });

  const cardText = () => evaluate(`(() => {
    const card = document.querySelector('[data-card-id="${CHOICE_ID}"]');
    return card ? card.innerText : null;
  })()`);
  assert.ok(await waitFor(async () => Boolean(await cardText()), 60_000), "the choice card never appeared on the phone");
  log("card on the phone:", (await cardText()).replace(/\n/g, " | "));

  // Tap the first option, in the page.
  await evaluate(`(() => {
    document.querySelector('[data-card-id="${CHOICE_ID}"] [data-option-id="o1"]').click();
    return true;
  })()`);
  log("tapped Long term");

  // --- the desktop takes the answer off the mailbox and publishes it --------
  const drainDecisions = async () => {
    const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}&limit=100`,
      { headers: { authorization: `Bearer ${MAILBOX_TOKEN}` } }).then((r) => r.json());
    const found = [];
    for (const event of res.events || []) {
      if (event.kind !== "choice.answered" && event.kind !== "permission.decided") continue;
      const payload = open(event.payload) ?? event.payload;
      if (payload && typeof payload.operationId === "string") {
        found.push({ kind: event.kind, conversationId: event.conversationId, payload });
      }
    }
    return found;
  };
  let decisions = [];
  if (!await waitFor(async () => { decisions = await drainDecisions(); return decisions.length > 0; }, 60_000)) {
    const phoneState = await evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("accordagents-mobile-control");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (name) => new Promise((resolve) => {
        try {
          const tx = db.transaction(name, "readonly");
          const all = tx.objectStore(name).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        } catch { resolve([]); }
      });
      const events = await read("events");
      const outbox = await read("outbox");
      db.close();
      return JSON.stringify({
        events: events.map((e) => ({ id: e.eventId, kind: e.kind, target: e.payload && e.payload.targetKey })),
        outbox: outbox.map((e) => ({ id: e.eventId, status: e.status, error: e.lastError, via: e.deliveredVia })),
        debug: (globalThis.__relayDebug || []).slice(-25),
        cardState: (document.querySelector('[data-card-id="${CHOICE_ID}"] .control-card-state') || {}).innerText || "",
        cardText: (document.querySelector('[data-card-id="${CHOICE_ID}"]') || {}).innerText || ""
      });
    })()`);
    console.error("[phone-choice] phone state:", phoneState);
    const raw = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}&limit=100`,
      { headers: { authorization: `Bearer ${MAILBOX_TOKEN}` } }).then((r) => r.json());
    console.error("[phone-choice] mailbox kinds:", JSON.stringify((raw.events || []).map((e) => e.kind)));
    throw new Error("the phone's answer never reached the desktop's mailbox");
  }
  log("the phone's answer:", JSON.stringify(decisions[0]));

  // The same publication main.ts performs for a phone answer.
  const decision = decisions[0];
  const published = await ownerLink.publishChatAction({
    conversationId: decision.conversationId ?? CONVERSATION,
    kind: decision.kind,
    payload: decision.payload,
    eventId: `chat-action:${decision.payload.operationId}`
  });
  log("desktop forwarded to", published, "machine(s)");

  const applied = await waitFor(async () => {
    const text = await machineLog(machineUserData, machineOutput);
    return /machine-host\.action\.applied/.test(text) && text.includes(CHOICE_ID);
  }, 90_000);
  if (!applied) {
    const text = await machineLog(machineUserData, machineOutput);
    console.error("[phone-choice] machine tail:\n" + text.split("\n").slice(-20).join("\n"));
  }
  assert.ok(applied, "the machine never applied the phone's answer");
  log("the machine applied the phone's answer");

  // The machine's result must reach the desktop's copy, and the desktop must
  // then tell the phone the card is answered.
  const cleared = await waitFor(async () => {
    await publishSnapshot();
    const card = await evaluate(`(() => {
      const item = document.querySelector('[data-card-id="${CHOICE_ID}"]');
      return item ? item.innerText : null;
    })()`);
    return card === null;
  }, 90_000);

  const stillThere = await cardText();
  log("card after the answer:", stillThere === null ? "(gone)" : stillThere.replace(/\n/g, " | "));
  log("desktop's choice status:",
    JSON.stringify(conversation.messages.find((m) => m.id === CHOICE_MESSAGE_ID)?.metadata?.pendingChoice));
  assert.ok(cleared, "the answered card is still pinned above the composer on the phone");
  log("PASS: the card cleared on the phone");
}

main().then(() => { stopSpawned(); process.exit(0); })
  .catch((error) => { console.error("[phone-choice] FAILED:", error.message); stopSpawned(); process.exit(1); });
