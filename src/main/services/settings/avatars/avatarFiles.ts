import path from "node:path";
import { userDataPath } from "../../../platform";
import type { AvatarImageMediaType, CustomAvatarSummary } from "../../../../shared/avatarStudio";
import { avatarImageExtension } from "../../../../shared/avatarStudio";

// Generated avatars are stored as files next to the settings file: a base64 PNG
// inside settings.json would be read on every getSettings and grow it without limit.
export function customAvatarDir(): string {
  // userDataPath, not electron's app: this service also runs on a machine,
  // where there is no Electron to ask.
  return path.join(userDataPath(), "avatars");
}

export function customAvatarPath(id: string, mediaType: AvatarImageMediaType): string {
  return path.join(customAvatarDir(), `${id}.${avatarImageExtension(mediaType)}`);
}

export function normalizeCustomAvatars(value: unknown): CustomAvatarSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const mediaType = record.mediaType === "image/png" || record.mediaType === "image/svg+xml"
      ? record.mediaType
      : undefined;
    if (!id || !mediaType) {
      return [];
    }
    return [{
      id,
      mediaType,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : "Custom avatar",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString()
    }];
  });
}
