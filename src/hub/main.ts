import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createChatChangeTransport } from "../main/services/chatChangeTransport";
import { importChatCopy } from "../main/services/chatCopy";
import { ChatSearchService } from "../main/services/chatSearch";
import { deviceIdForPublicKey } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { createHeadlessPlatform, setHostPlatform, userDataPath } from "../main/platform";
import { HubFolder } from "./hubFolder";
import { HubLog } from "./hubLog";
import { HubPush, loadOrCreateVapidKeys } from "./hubPush";
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
    await storage.hub().setOwner({ deviceId: owner.deviceId, publicKeyDerBase64: owner.publicKeyDerBase64, name: owner.name || "Desktop", addedAt: new Date().toISOString() });
    return finish({ ok: true, hubId: hubId() });
  }
  if (args.importChatCopy) {
    const summary = await importChatCopy(storage, args.importChatCopy, {});
    return finish({ ok: true, ...summary });
  }

  const devices = async () => storage.hub().devices();
  // The hub folds chats by the same rules a machine does: shared fields from
  // the desktop, a member's replies from where the member runs.
  const policy = async () => {
    const roster = await devices();
    const owner = roster.find((device) => device.role === "owner");
    return createChatChangeTransport({
      role: "machine",
      storage: storage as never,
      log: undefined as never,
      recipients: () => [],
      desktopOriginId: () => owner?.deviceId,
      machineOriginId: (machineId) => roster.find((device) => device.machineId === machineId)?.deviceId
    }).applyPolicy(undefined);
  };
  const hubLog = new HubLog(storage);
  const folder = new HubFolder(storage, policy, log);
  const search = new ChatSearchService(storage);
  const keys = loadOrCreateVapidKeys(path.join(userDataPath(), "vapid.json"));
  const push = new HubPush({ storage, keys, subject: "mailto:push@accordagents.com", log });
  hubLog.onAppended((head, conversationIds, originId) => {
    folder.enqueue(conversationIds);
    push.noteAppended(head, originId);
  });
  const server = new HubServer({ hubId: hubId(), version: HUB_VERSION, storage, log: hubLog, search, vapidPublicKey: keys.publicKey, acmeWebroot: args.acmeWebroot, debugLog: log });
  if (args.cert && args.key && existsSync(args.cert) && existsSync(args.key)) {
    await server.listenHttps(args.httpsPort, { cert: args.cert, key: args.key }, args.host);
  }
  // Plain HTTP serves the certificate challenge and, before there is a
  // certificate, the health check the setup reads.
  await server.listenHttp(args.httpPort, args.host, { openOnly: !args.insecureHttp });
  await folder.start();
  log("hub.started", { version: HUB_VERSION, https: Boolean(args.cert), httpPort: args.httpPort });
  return async () => {
    push.close();
    await server.close();
    await folder.idle();
  };
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
