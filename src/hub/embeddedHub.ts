import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { StorageService } from "../main/services/storage";
import { composeHub, hubId } from "./main";
import { loadOrCreateVapidKeys } from "./hubPush";
import { HubRetention, hubRetentionConfig } from "./hubRetention";

/** The computer that owns an embedded server (agreement Д6). */
export interface EmbeddedHubOwner {
  deviceId: string;
  publicKeyDerBase64: string;
  name?: string;
}

export interface EmbeddedHub {
  /** Where the computer reaches it: loopback only. */
  url: string;
  hubId: string;
  close(): Promise<void>;
}

/**
 * The User's server, run inside the app on the computer when the User has no
 * server of her own (agreement Д6): the same program, with its own database
 * beside the app's, answering only on this computer. The computer talks to it
 * exactly as it talks to a server in the cloud; there is no second way of
 * keeping chats.
 */
export async function startEmbeddedHub(options: {
  /** Where its database and keys live (inside the app's user data). */
  dataDir: string;
  owner: EmbeddedHubOwner;
  version: string;
  log: (event: string, payload: Record<string, unknown>) => void;
  sqliteExecutable?: string;
  /** A fixed port; by default any free one. */
  port?: number;
}): Promise<EmbeddedHub> {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const storage = new StorageService({ dbPath: path.join(options.dataDir, "accordagents-hub.sqlite3"), sqliteExecutable: options.sqliteExecutable ?? "sqlite3" });
  await storage.init();
  const owner = (await storage.hub().devices()).find((device) => device.role === "owner");
  if (owner && owner.deviceId !== options.owner.deviceId) throw new Error("The embedded server belongs to another identity of this computer.");
  if (!owner) {
    await storage.hub().setOwner({ deviceId: options.owner.deviceId, publicKeyDerBase64: options.owner.publicKeyDerBase64, name: options.owner.name || "Desktop", addedAt: new Date().toISOString() });
  }
  const id = hubId(options.dataDir);
  const hub = composeHub({ storage, hubId: id, version: options.version, keys: loadOrCreateVapidKeys(path.join(options.dataDir, "vapid.json")), log: options.log });
  // The whole API over plain HTTP, on loopback only: nothing leaves the computer.
  const http = await hub.server.listenHttp(options.port ?? 0, "127.0.0.1", { openOnly: false });
  const retention = new HubRetention({ storage, config: hubRetentionConfig(), log: options.log });
  retention.start();
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  options.log("hub.embedded.started", { url, hubId: id });
  return {
    url,
    hubId: id,
    close: async () => {
      await retention.close();
      await hub.close();
    }
  };
}
