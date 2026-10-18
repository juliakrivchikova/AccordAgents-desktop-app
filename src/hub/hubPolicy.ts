import { createChatChangeApplyPolicy } from "../main/services/chatChangeTransport";
import type { ChatChangeApplyPolicy } from "../main/services/chatChanges";
import type { StorageService } from "../main/services/storage";

/**
 * The hub folds chats by the rules a machine applies: shared fields from the
 * desktop that set it up (the owner), a member's replies from the machine it
 * runs on. Read from the roster at each fold, so a machine added since is known.
 */
export function hubApplyPolicy(storage: StorageService): () => Promise<ChatChangeApplyPolicy> {
  return async () => {
    const roster = await storage.hub().devices();
    const owner = roster.find((device) => device.role === "owner");
    return createChatChangeApplyPolicy({
      role: "machine",
      desktopOriginId: () => owner?.deviceId,
      machineOriginId: (machineId) => roster.find((device) => device.machineId === machineId)?.deviceId
    });
  };
}
