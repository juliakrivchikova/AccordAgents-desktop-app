import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { StorageService } from "../dist/main/main/services/storage.js";
import { ChatEventLogService } from "../dist/main/main/services/chatEventLog.js";

const directory = await mkdtemp(path.join(tmpdir(), "accord-machine-test-events-"));
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function device(name) {
  const eventStorage = new StorageService({ dbPath: path.join(directory, `${name}.sqlite3`) });
  const eventLog = new ChatEventLogService(eventStorage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  return { eventStorage, eventLog, publicKeyDerBase64: identity.publicKeyDerBase64, identity };
}

export const desktopEvents = await device("desktop");
export const hostEvents = await device("host");
export const DESKTOP_ID = desktopEvents.identity.originId;
export const MACHINE_ID = hostEvents.identity.originId;
export const DESKTOP_ISSUER = {
  originId: DESKTOP_ID,
  keyId: desktopEvents.identity.keyId,
  publicKeyDerBase64: desktopEvents.identity.publicKeyDerBase64
};
