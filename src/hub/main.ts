import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importChatCopy } from "../main/services/chatCopy";
import { ChatSearchService } from "../main/services/chatSearch";
import { deviceIdForPublicKey } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { createHeadlessPlatform, setHostPlatform, userDataPath } from "../main/platform";
import { HubFolder } from "./hubFolder";
import { hubApplyPolicy } from "./hubPolicy";
import { HubLog } from "./hubLog";
import { HubPush, loadOrCreateVapidKeys } from "./hubPush";
import { HubRelayMailboxes, HubRelayRooms } from "./hubRelay";
import { HubChangeFeed, HubPhoneApi } from "./hubPhone";
import { HubProgress, HubWaker, approvalNotice, foldApprovalCards, phoneMessageHomes, replyNotice } from "./hubPhoneState";
import { HUB_APPROVAL_CARD_EVENT_KIND } from "../shared/hubProtocol";
import { HubServer } from "./hubServer";

declare const __HUB_VERSION__: string | undefined;
const HUB_VERSION = typeof __HUB_VERSION__ === "string" ? __HUB_VERSION__ : "dev";

interface HubArgs {
  userDataDir?: string;
  /** Setup only: the owner desktop's identity on stdin, then exit. */
  setOwner?: boolean;
  /** Setup only: import the desktop's chat copy from this directory, then exit. */
  importChatCopy?: string;
  httpPort: number;
  httpsPort: number;
  host?: string;
  cert?: string;
  key?: string;
  acmeWebroot?: string;
  /** Local runs only: serve the whole API over plain HTTP. */
  insecureHttp?: boolean;
}

function parseArgs(argv: string[]): HubArgs {
  const args: HubArgs = { httpPort: 80, httpsPort: 443 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a value.`);
      return value;
    };
    if (arg === "--user-data") args.userDataDir = next();
    else if (arg === "--set-owner") args.setOwner = true;
    else if (arg === "--import-chat-copy") args.importChatCopy = path.resolve(next());
    else if (arg === "--http-port") args.httpPort = Number(next());
    else if (arg === "--https-port") args.httpsPort = Number(next());
    else if (arg === "--host") args.host = next();
    else if (arg === "--cert") args.cert = next();
    else if (arg === "--key") args.key = next();
    else if (arg === "--acme-webroot") args.acmeWebroot = next();
    else if (arg === "--insecure-http") args.insecureHttp = true;
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return args;
}

async function readStdin(limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("The setup input is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The storage keeps a sqlite3 child open; a setup command prints one line and exits. */
function finish(result: unknown): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  });
}

/** Who the hub's pushes say they come from. */
const PUSH_SUBJECT = "mailto:push@accordagents.com";

/** Present once the desktop's first copy of the chats is in. */
function chatCopyMark(): string {
  return path.join(userDataPath(), "chat-copy.json");
}

function hubId(): string {
  const file = path.join(userDataPath(), "hub-id.json");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { hubId?: string };
    if (stored.hubId) return stored.hubId;
  }
  const id = `hub-${randomUUID()}`;
  writeFileSync(file, JSON.stringify({ hubId: id }), { mode: 0o600 });
  return id;
}

/**
 * The hub's parts and how they hear of each other: the order, the folding of
 * chats, and what the phone is shown and rung for. Shared by the program and
 * its tests, so a test runs the hub as it is put together.
 */
export function composeHub(options: {
  storage: StorageService;
  hubId: string;
  version: string;
  keys: { publicKey: string; privateJwk: import("node:crypto").JsonWebKey };
  log: (event: string, payload: Record<string, unknown>) => void;
  acmeWebroot?: string;
  relay?: { mailboxes: HubRelayMailboxes; rooms: HubRelayRooms };
  /** Local QA and tests: where the EC2 API is reached instead of AWS. */
  ec2Endpoint?: string;
  /** Tests: the push service and AWS are stand-ins. */
  fetchImpl?: typeof fetch;
  pushDebounceMs?: number;
}) {
  const { storage, log } = options;
  const policy = hubApplyPolicy(storage);
  const hubLog = new HubLog(storage);
  // Which chats' copies changed, for the phones reading them here.
  const feed = new HubChangeFeed();
  const progress = new HubProgress();
  const waker = new HubWaker({ storage, endpointOverride: options.ec2Endpoint, log, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  // Set below: the push asks the phone views whether a phone is looking.
  let phone: HubPhoneApi | undefined;
  const push = new HubPush({
    storage, keys: options.keys, subject: PUSH_SUBJECT, isActive: (deviceId) => phone?.isActive(deviceId) ?? false, log,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.pushDebounceMs !== undefined ? { debounceMs: options.pushDebounceMs, minIntervalMs: options.pushDebounceMs } : {})
  });
  const notify = async (notice: Parameters<ReturnType<StorageService["hub"]>["addNotice"]>[0]): Promise<void> => {
    const seq = await storage.hub().addNotice(notice);
    await push.noteNotice({ seq, conversationId: notice.conversationId });
  };
  const isPhone = async (originId: string): Promise<boolean> =>
    (await storage.hub().devices()).some((device) => device.deviceId === originId && device.role === "phone");
  const folder = new HubFolder(storage, policy, log, (conversationId, details) => {
    feed.note(conversationId);
    for (const message of details.settled) {
      const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : undefined;
      if (runId) progress.settle(runId);
      // A member's line that is not the User's to see rings nobody.
      if (message.metadata?.hiddenFromTimeline === true) continue;
      void notify(replyNotice(details.conversation, message)).catch((error) => log("hub.notice.error", { message: error instanceof Error ? error.message : String(error) }));
    }
    // A message for a member on a machine that is not reading: woken soon.
    for (const { message, hubSeq } of details.phoneMessages) {
      for (const machineId of phoneMessageHomes(details.conversation, message)) waker.noteWork(machineId, hubSeq);
    }
  }, isPhone);
  const search = new ChatSearchService(storage);
  let views: Promise<void> = Promise.resolve();
  hubLog.onAppended(({ changedConversationIds, events }) => {
    folder.enqueue(changedConversationIds);
    // In the order the events were placed: a card answered right after it
    // was raised must not fold before it.
    views = views.then(async () => {
      for (const item of events) {
        if (item.event.kind !== "machine.turn.progress.delta") continue;
        const payload = await storage.deviceEventBlobs().hydrate(item.event.payload).catch(() => undefined);
        progress.note(item.event, payload);
      }
      const pending = await foldApprovalCards(storage, events);
      const touched = new Set(events.filter((item) => item.event.kind === HUB_APPROVAL_CARD_EVENT_KIND || item.event.kind.startsWith("machine.approval.")).map((item) => item.event.conversationId));
      for (const conversationId of touched) feed.note(conversationId);
      if (pending.length === 0) return;
      const summaries = await storage.listConversations().catch(() => []);
      for (const card of pending) {
        const title = summaries.find((summary) => summary.id === card.conversationId)?.title ?? "";
        await notify(approvalNotice(card.conversationId, title, card.approval));
      }
    }).catch((error) => log("hub.phone-views.error", { message: error instanceof Error ? error.message : String(error) }));
  });
  phone = new HubPhoneApi({
    store: storage,
    feed,
    progress,
    waker,
    machineNames: async () => new Map((await storage.hub().devices())
      .filter((device) => device.role === "machine" && device.machineId)
      .map((device) => [device.machineId as string, device.name])),
    log
  });
  const phoneApi = phone;
  const server = new HubServer({
    hubId: options.hubId, version: options.version, storage, log: hubLog, search, vapidPublicKey: options.keys.publicKey,
    ...(options.acmeWebroot ? { acmeWebroot: options.acmeWebroot } : {}), debugLog: log,
    ...(options.relay ? { relay: options.relay } : {}),
    phone: phoneApi,
    onCatalogChanged: () => phoneApi.catalogChanged(),
    onProgress: (frames) => { for (const frame of frames) progress.noteFrame(frame); }
  });
  waker.start();
  return {
    server, folder, push, waker, feed, progress, phone: phoneApi, hubLog,
    /** Resolves once the phone's views have taken in what was placed so far. */
    viewsIdle: async () => { await views; },
    close: async () => {
      push.close();
      waker.close();
      await server.close();
      await folder.idle();
      // What was placed before the stop reaches the phone's views (cards).
      await views;
      folder.close();
    }
  };
}

export async function startHub(args: HubArgs): Promise<() => Promise<void>> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir, appVersion: HUB_VERSION }));
  const storage = new StorageService({ sqliteExecutable: "sqlite3" });
  await storage.init();
  const log = (event: string, payload: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...payload })}\n`);
  };

  if (args.setOwner) {
    const owner = JSON.parse(await readStdin()) as { deviceId?: string; publicKeyDerBase64?: string; name?: string };
    if (typeof owner.publicKeyDerBase64 !== "string" || deviceIdForPublicKey(owner.publicKeyDerBase64) !== owner.deviceId) {
      throw new Error("The owner identity is invalid.");
    }
    const before = (await storage.hub().devices()).find((device) => device.role === "owner");
    if (before && before.deviceId !== owner.deviceId) {
      // Said in a line the setup reads, so it can offer to start over.
      return finish({ ok: false, reason: "another-owner", hubId: hubId() });
    }
    await storage.hub().setOwner({ deviceId: owner.deviceId, publicKeyDerBase64: owner.publicKeyDerBase64, name: owner.name || "Desktop", addedAt: new Date().toISOString() });
    // Already this desktop's, and its chats copied: its cursors stand.
    return finish({ ok: true, hubId: hubId(), alreadyOwner: Boolean(before), chatsCopied: existsSync(chatCopyMark()) });
  }
  if (args.importChatCopy) {
    const summary = await importChatCopy(storage, args.importChatCopy, {});
    // Written last: a copy that stopped half way is copied again.
    writeFileSync(chatCopyMark(), JSON.stringify({ at: new Date().toISOString(), ...summary }), { mode: 0o600 });
    return finish({ ok: true, ...summary });
  }

  const keys = loadOrCreateVapidKeys(path.join(userDataPath(), "vapid.json"));
  // The relay the phone and the machines speak, rung with the same keys.
  const mailboxes = new HubRelayMailboxes({ storage: storage.relay(), vapid: { ...keys, subject: PUSH_SUBJECT }, log });
  await mailboxes.start();
  const hub = composeHub({
    storage, hubId: hubId(), version: HUB_VERSION, keys, log, acmeWebroot: args.acmeWebroot,
    relay: { mailboxes, rooms: new HubRelayRooms() },
    // QA only: a stand-in for AWS on this computer. A signed start request
    // never goes to any other address than AWS's own.
    ec2Endpoint: loopbackEndpoint(process.env.ACCORDAGENTS_HUB_EC2_ENDPOINT)
  });
  const { server, folder } = hub;
  const https = Boolean(args.cert && args.key && existsSync(args.cert) && existsSync(args.key));
  if (https) {
    await server.listenHttps(args.httpsPort, { cert: args.cert!, key: args.key! }, args.host);
  } else if (args.cert) {
    log("hub.tls.missing", { cert: args.cert });
  }
  // Plain HTTP serves the certificate challenge and, before there is a
  // certificate, the health check the setup reads.
  await server.listenHttp(args.httpPort, args.host, { openOnly: !args.insecureHttp });
  await folder.start();
  // Rings the stopped program had scheduled and did not ring.
  await hub.push.rearm().catch((error: unknown) => log("hub.push.rearm-error", { message: error instanceof Error ? error.message : String(error) }));
  log("hub.started", { version: HUB_VERSION, https, httpPort: args.httpPort });
  return hub.close;
}

if (require.main === module) {
  let stop: (() => Promise<void>) | undefined;
  const shutdown = (): void => {
    void (stop ? stop() : Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  startHub(parseArgs(process.argv.slice(2))).then((close) => { stop = close; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function loopbackEndpoint(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url.href : undefined;
  } catch {
    return undefined;
  }
}
