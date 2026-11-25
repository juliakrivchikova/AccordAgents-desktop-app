import type { ChatImageMimeType } from "../../../../shared/types";

export const CHAT_IMAGE_EXTENSION_BY_MIME: Record<ChatImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};
