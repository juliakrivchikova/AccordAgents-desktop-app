/**
 * The User's own server, for the phone's browser harnesses.
 *
 * The phone talks to nothing but her server, so a harness that drives the
 * real PWA needs a real one: this starts the hub in-process from the compiled
 * main build (`composeHub`, the same composition the program runs), with its
 * own SQLite file, an owner desktop identity that signs the chat changes a
 * desktop would publish, and a one-time invite the page pairs with exactly as
 * it does from the code the desktop shows. Nothing on the phone's side is
 * stood in for: the page enrolls its own key, signs every read and write, and
 * reads the chat list, pages, cards and live progress from the hub's copy.
 *
 * The hub is reached through a small pass-through in front of it, so a
 * harness can hold or refuse a request the way a slow or broken connection
 * would, without touching the hub itself.
 *
 * Build first: `npm run build:main` (dist/main) and `npm run build:mobile`
 * (dist/mobile).
 */
import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const distMain = (file) => path.join(repoRoot, "dist/main", file);
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

export const mobileRoot = path.join(repoRoot, "dist/mobile");
export const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const HUB_PAIRING_KEY = "accordagents.mobile.hub.v1";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function vapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** A chat member as the desktop keeps it. */
export function member(handle, extra = {}) {
  return { id: extra.id || `p-${handle}`, handle, roleConfigId: "software-engineer", kind: "claude-code", ...extra };
}

/**
 * Starts the hub. `options.port` fixes the address phones reach it at (the
 * pass-through's); `options.fetchImpl` stands in for the push service and AWS.
 */
export async function startMobileHub(options = {}) {
  const { composeHub } = require(distMain("hub/main.js"));
  const { StorageService } = require(distMain("main/services/storage.js"));
  const { createChatEventDeviceIdentity, createSignedChatEvent } = require(distMain("main/services/chatEventLog.js"));
  const { signHubRequest, signHubText, sha256Hex } = require(distMain("main/services/hubAuth.js"));
  const { hubPhoneInviteSigningText, HUB_APPROVAL_CARD_EVENT_KIND, HUB_APPROVAL_CARD_SCOPE } = require(distMain("shared/hubProtocol.js"));
  const { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope } = require(distMain("main/services/chatChanges.js"));
  const { encodeMachineProgress } = require(distMain("shared/machineProgress.js"));

  const hubId = options.hubId || `hub-${randomBytes(6).toString("hex")}`;
  const dir = await mkdtemp(path.join(tmpdir(), "aa-mobile-hub-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });

  /** What the hub tried to reach outside itself: rings of the push service. */
  const rings = [];
  const fetchImpl = options.fetchImpl || (async (url, init) => {
    rings.push({ url: String(url), at: Date.now(), body: init && init.body });
    return new Response("", { status: 201 });
  });
  const composed = composeHub({
    storage, hubId, version: "test", keys: vapidKeys(), log: options.log || (() => undefined), fetchImpl,
    pushDebounceMs: options.pushDebounceMs ?? 50
  });
  const inner = await composed.server.listenHttp(0, "127.0.0.1");
  const innerPort = inner.address().port;

  /** Every event the hub placed in its order, in order, as it placed them. */
  const placed = [];
  composed.hubLog.onAppended(({ events }) => {
    for (const item of events) placed.push(item.event);
  });

  // The pass-through the phone reaches the hub by. A gate may hold a request
  // ({ delayMs }), answer it itself ({ status, body }), or let it pass.
  let gate;
  const requests = [];
  // Requests the phone has open now, but for its long wait for news.
  let inFlight = 0;
  let lastActivityAt = Date.now();
  const proxy = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const seen = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), at: Date.now() };
    requests.push(seen);
    const counted = url.pathname !== "/v1/phone/changes";
    if (counted) {
      inFlight += 1;
      lastActivityAt = Date.now();
      res.once("close", () => { inFlight -= 1; lastActivityAt = Date.now(); seen.doneAt = Date.now(); });
    }
    const decision = gate ? await gate(seen) : undefined;
    if (decision && decision.delayMs) await sleep(decision.delayMs);
    if (decision && decision.status) {
      res.writeHead(decision.status, {
        "content-type": "application/json", "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, OPTIONS"
      });
      res.end(typeof decision.body === "string" ? decision.body : JSON.stringify(decision.body || {}));
      return;
    }
    if (decision && decision.drop) {
      req.socket.destroy();
      return;
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: innerPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  const port = await listen(proxy, options.port || 0);
  const base = `http://127.0.0.1:${port}`;

  /** A request signed by the owner desktop, straight to the hub. */
  const call = async (method, pathWithQuery, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${innerPort}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(owner, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`hub ${method} ${pathWithQuery} answered ${response.status}: ${JSON.stringify(answer)}`);
    return answer;
  };

  const settle = async () => {
    await composed.folder.idle();
    await composed.viewsIdle();
    await composed.folder.idle();
  };

  // The owner's chains, one per scope, as the desktop keeps them.
  const chains = new Map();
  const ownerEvent = (scope, conversationId, kind, payload) => {
    const head = chains.get(scope) || { seq: 0 };
    const event = createSignedChatEvent(owner, {
      conversationId, logScopeId: scope, kind, payload, originSeq: head.seq + 1,
      ...(head.hash ? { prevHash: head.hash } : {}), createdAt: new Date().toISOString()
    });
    chains.set(scope, { seq: head.seq + 1, hash: event.eventHash });
    return event;
  };
  // The owner's writes go one at a time, as one desktop's do: an event is
  // made and pushed in its chain's order, or the hub sees a gap.
  let ownerQueue = Promise.resolve();
  const serially = (work) => {
    const run = ownerQueue.then(work);
    ownerQueue = run.catch(() => undefined);
    return run;
  };
  const pushOwner = async (events) => {
    const answer = await call("POST", "/v1/events", { events });
    const statuses = (answer.results || []).map((result) => result.status);
    if (statuses.some((status) => status !== "accepted" && status !== "duplicate")) {
      throw new Error(`the hub did not take the owner's events: ${JSON.stringify(answer.results)}`);
    }
    await settle();
    return answer;
  };

  await call("PUT", "/v1/roster", { devices: [
    { deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    ...(options.rosterDevices || [])
  ] });

  const hub = {
    base, hubId, owner, storage, composed, dir, rings, placed, requests,
    call, settle,
    /** Holds, answers or passes the phone's requests (see the pass-through). */
    setGate(next) { gate = next; },
    /** Resolves once the phone has had no request open (but its wait for
     *  news) for `settleMs`: what it asked has been answered and taken in. */
    async quiet({ settleMs = 300, timeoutMs = 15_000 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (inFlight === 0 && Date.now() - lastActivityAt >= settleMs) return;
        await sleep(50);
      }
      throw new Error(`the phone kept asking the server (${inFlight} open)`);
    },
    /** The chat changes of one chat, signed by the owner and folded. */
    async changeChat(conversationId, changes) {
      return serially(() => {
        const payload = { version: 1, conversationId, updatedAt: new Date().toISOString(), changes };
        return pushOwner([ownerEvent(chatChangesLogScope(conversationId), conversationId, CHAT_CHANGES_EVENT_KIND, payload)]);
      });
    },
    /** A chat as the desktop creates it, with its members and messages. */
    async createChat(conversationId, { title = "Chat", participants = [], repoPath, createdAt, messages = [], metadata = {} } = {}) {
      await hub.changeChat(conversationId, [{ type: "conversation.created", conversation: {
        title, kind: "chat", createdAt: createdAt || new Date().toISOString(), ...(repoPath ? { repoPath } : {}),
        metadata: { participants, ...metadata }
      } }]);
      if (messages.length > 0) await hub.addMessages(conversationId, messages);
    },
    async addMessages(conversationId, messages) {
      return hub.changeChat(conversationId, messages.map((message) => ({ type: "message.created", message })));
    },
    async updateMessages(conversationId, messages) {
      return hub.changeChat(conversationId, messages.map((message) => ({ type: "message.updated", message })));
    },
    /** Bytes the owner puts on the server as a body named by its hash. */
    async putBlob(bytes) {
      const { createHash } = await import("node:crypto");
      const reference = { type: "device.event.blob", blobHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, byteLength: bytes.length, fragments: 1 };
      const pathWithQuery = `/v1/blobs/${reference.blobHash}?bytes=${reference.byteLength}&fragments=1&index=0`;
      const response = await fetch(`http://127.0.0.1:${innerPort}${pathWithQuery}`, {
        method: "PUT",
        headers: { authorization: signHubRequest(owner, { method: "PUT", pathWithQuery, body: bytes }), "content-type": "application/octet-stream" },
        body: bytes
      });
      if (!response.ok) throw new Error(`hub PUT blob answered ${response.status}: ${await response.text()}`);
      return reference;
    },
    /** The composer catalog the desktop publishes (roles, prompts, skills, drawn avatars). */
    async publishCatalog(catalog = {}) {
      return call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: {}, prompts: [], skills: [], avatars: {}, ...catalog } });
    },
    /** A permission card the desktop raises for one of its members. */
    async raiseApproval(conversationId, approval) {
      return serially(() => pushOwner([ownerEvent(HUB_APPROVAL_CARD_SCOPE, conversationId, HUB_APPROVAL_CARD_EVENT_KIND, { conversationId, approval })]));
    },
    /** A member's live text, posted the way the desktop posts it. */
    async progress(conversationId, runId, text, extra = {}) {
      const key = `${conversationId}\n${runId}`;
      const stream = hub.progressStreams.get(key) || { streamId: `stream-${randomBytes(4).toString("hex")}`, sequence: 0, previous: undefined };
      const next = {
        runId, phase: "initial", message: "Running", createdAt: new Date().toISOString(),
        agentProgress: { participantLabel: extra.participantLabel || "Agent", state: "running", partialContent: text, ...(extra.agentProgress || {}) }
      };
      const frame = encodeMachineProgress(stream.previous, next, { conversationId, streamId: stream.streamId, sequence: stream.sequence + 1 });
      hub.progressStreams.set(key, { ...stream, sequence: stream.sequence + 1, previous: next });
      await call("POST", "/v1/progress", { frames: [frame] });
    },
    progressStreams: new Map(),
    /** A one-time pairing code, as the desktop's Device Pairing shows it. */
    async invite(scope = { scope: "device" }) {
      const token = randomBytes(32).toString("base64url");
      const invite = {
        version: 1, inviteId: `invite-${randomBytes(8).toString("hex")}`, hubId, issuerDeviceId: owner.originId,
        tokenHash: sha256Hex(token), scope, name: "Phone", issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString()
      };
      await call("PUT", "/v1/phone-invites", { invite, signature: signHubText(owner, hubPhoneInviteSigningText(invite)) });
      return { token, invite, url: (siteOrigin) => `${siteOrigin}/?pair=server#hub=${encodeURIComponent(base)}&t=${token}&id=${encodeURIComponent(hubId)}` };
    },
    /** The phones the hub holds, as its roster says. */
    async phones() {
      return (await storage.hub().devices()).filter((device) => device.role === "phone");
    },
    /** What the phone placed in the hub's order, by kind. */
    phoneEvents(kind) {
      return placed.filter((event) => event.originId !== owner.originId && (!kind || event.kind === kind));
    },
    async close() {
      gate = undefined;
      await closeServer(proxy);
      await composed.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return hub;
}

/**
 * Serves the built PWA under the origin's real headers. The hub runs over
 * plain HTTP on this computer, which the shipped policy (https: only) would
 * refuse, so only for this harness the hub's own address is added to
 * connect-src; everything else is the policy the CDN applies.
 */
export async function serveMobileShell({ port = 0, hubOrigins = [], intercept } = {}) {
  const originHeaders = loadMobileOriginHeaders(mobileRoot);
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
    ".webmanifest": "application/manifest+json", ".json": "application/json"
  };
  const widen = (headers) => {
    const policy = headers["Content-Security-Policy"];
    if (!policy || hubOrigins.length === 0) return headers;
    return { ...headers, "Content-Security-Policy": policy.replace(/connect-src ([^;]*)/, (_, value) => `connect-src ${value} ${hubOrigins.join(" ")}`) };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (intercept && await intercept(req, res, url)) return;
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(mobileRoot, rel);
    if (!file.startsWith(mobileRoot)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", ...widen(mobileOriginHeadersForPath(originHeaders, url.pathname)) });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  const bound = await listen(server, port);
  return { server, origin: `http://127.0.0.1:${bound}`, port: bound, close: () => closeServer(server) };
}

/** Headless Chrome on its own profile and debugging port. */
export function launchChrome({ port, profile, url, width = 390, height = 844, args = [] }) {
  try { execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
  return spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    ...args, url
  ], { stdio: "ignore" });
}

/** A page of the app, attached over CDP, with the waits every harness uses. */
export async function attachApp({ port, title = "AccordAgents", attempts = 60 }) {
  const { attach } = require("./cdp.cjs");
  let app;
  for (let index = 0; index < attempts && !app; index += 1) {
    try { app = await attach({ port, title }); } catch { await sleep(250); }
  }
  if (!app) throw new Error(`could not attach to the app on port ${port}`);
  const raw = app.evaluate;
  const evaluate = async (expression) => {
    const result = await raw(expression);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, what, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try { last = await evaluate(expression); } catch (error) { last = String(error && error.message || error); }
      if (last === true) return last;
      await sleep(100);
    }
    throw new Error(`${what || expression}: last saw ${JSON.stringify(last)}`);
  };
  return Object.assign(app, { rawEvaluate: raw, evaluate, waitFor });
}

/**
 * Pairs the page with the hub the way the User does: the page is opened at
 * the link the desktop's code carries, makes its key, enrolls it and reads
 * the chats. Resolves once the pairing is stored and the chat list read.
 */
export async function pairPage(app, { hub, siteOrigin, scope, query, expectChats = true } = {}) {
  const code = await hub.invite(scope);
  // Other parameters of the address (the qa flag) stay once pairing has
  // scrubbed the code from it.
  const url = code.url(siteOrigin);
  await app.send("Page.navigate", { url: query ? url.replace("/?pair=server", `/?${query}&pair=server`) : url });
  await app.waitFor(`Boolean(localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}))`, "the phone stored its pairing with the server", 20_000);
  if (expectChats) {
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").length > 0`,
      "the phone read the chat list from the server", 20_000);
  }
  return code;
}

/** Opens a chat from the list, as a tap on its row does. */
export async function openChat(app, conversationId) {
  await app.waitFor(`Boolean(document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(conversationId)}]'))`, `the chat ${conversationId} is listed`);
  await app.evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(conversationId)}]').click()`);
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && document.getElementById("message-list").dataset.conversationId === ${JSON.stringify(conversationId)}`,
    `the chat ${conversationId} is open`);
}

/** A fresh temporary profile directory. */
export function tempProfile(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export function newId() {
  return randomUUID();
}
