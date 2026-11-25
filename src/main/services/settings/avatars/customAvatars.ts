import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AppSettings } from "../../../../shared/types";
import type { CustomAvatarSummary, ReadCustomAvatarResult, SaveCustomAvatarRequest } from "../../../../shared/avatarStudio";
import { customAvatarDir, customAvatarPath, normalizeCustomAvatars } from "./avatarFiles";
import type { SettingsModules } from "../modules";

/** Pictures the User uploaded as avatars. */
export class CustomAvatars {
  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "settingsStore">) {}

  async saveCustomAvatar(request: SaveCustomAvatarRequest): Promise<AppSettings> {
    const bytes = Buffer.from(request.dataBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("Empty picture.");
    }
    const id = randomUUID();
    await mkdir(customAvatarDir(), { recursive: true });
    await writeFile(customAvatarPath(id, request.mediaType), bytes);
    const summary: CustomAvatarSummary = {
      id,
      mediaType: request.mediaType,
      label: request.label.trim() || "Custom avatar",
      createdAt: new Date().toISOString()
    };
    const stored = await this.settings.settingsStore.readStored();
    stored.chatCustomAvatars = [...normalizeCustomAvatars(stored.chatCustomAvatars), summary];
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async readCustomAvatar(id: string): Promise<ReadCustomAvatarResult> {
    const stored = await this.settings.settingsStore.readStored();
    const summary = normalizeCustomAvatars(stored.chatCustomAvatars).find((entry) => entry.id === id);
    if (!summary) {
      throw new Error("Avatar not found.");
    }
    const bytes = await readFile(customAvatarPath(id, summary.mediaType));
    return { id, mediaType: summary.mediaType, dataBase64: bytes.toString("base64") };
  }
}
