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
import { HubRetention, hubRetentionConfig } from "./hubRetention";
import { HubChangeFeed, HubPhoneApi } from "./hubPhone";
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

  const policy = hubApplyPolicy(storage);
  const hubLog = new HubLog(storage);
  // Which chats' copies changed, for the phones reading them here.
  const feed = new HubChangeFeed();
  const folder = new HubFolder(storage, policy, log, (conversationId) => feed.note(conversationId));
  const search = new ChatSearchService(storage);
  const keys = loadOrCreateVapidKeys(path.join(userDataPath(), "vapid.json"));
  const push = new HubPush({ storage, keys, subject: PUSH_SUBJECT, log });
  hubLog.onAppended(({ head, changedConversationIds, originId }) => {
    folder.enqueue(changedConversationIds);
    // A phone is rung when a chat's content changed, not for every progress
    // frame a running turn writes.
    if (changedConversationIds.length > 0) push.noteAppended(head, originId);
  });
  // The relay the phone and the machines speak, rung with the same keys.
  const mailboxes = new HubRelayMailboxes({ storage: storage.relay(), vapid: { ...keys, subject: PUSH_SUBJECT }, log });
  await mailboxes.start();
  const server = new HubServer({
    hubId: hubId(), version: HUB_VERSION, storage, log: hubLog, search, vapidPublicKey: keys.publicKey, acmeWebroot: args.acmeWebroot, debugLog: log,
    relay: { mailboxes, rooms: new HubRelayRooms() },
    phone: new HubPhoneApi({
      store: storage,
      relayStorage: storage.relay(),
      feed,
      machineNames: async () => new Map((await storage.hub().devices())
        .filter((device) => device.role === "machine" && device.machineId)
        .map((device) => [device.machineId as string, device.name])),
      log
    })
  });
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
  // The order stays bounded: what every reader read, past its grace period.
  const retention = new HubRetention({ storage, config: hubRetentionConfig(), log });
  retention.start();
  log("hub.started", { version: HUB_VERSION, https, httpPort: args.httpPort });
  return async () => {
    push.close();
    // The folding stops after the chat it is on; what is left is folded on
    // the next start (it is read from the order, not kept in memory).
    folder.close();
    await server.close();
    await retention.close();
    await folder.idle();
  };
}

/** A stop that has not finished by then exits anyway: everything the hub
 *  keeps is written in transactions, and a stop that hangs only makes the
 *  service manager wait for its kill timeout. */
const SHUTDOWN_DEADLINE_MS = 5_000;

if (require.main === module) {
  let stop: (() => Promise<void>) | undefined;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const started = Date.now();
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ event: "hub.stop.deadline", at: new Date().toISOString(), ms: Date.now() - started })}\n`);
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS).unref();
    void (stop ? stop() : Promise.resolve()).finally(() => {
      process.stdout.write(`${JSON.stringify({ event: "hub.stopped", at: new Date().toISOString(), ms: Date.now() - started })}\n`, () => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  startHub(parseArgs(process.argv.slice(2))).then((close) => { stop = close; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
