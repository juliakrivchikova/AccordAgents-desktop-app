// Reused: toLocaleTimeString builds a formatter on every call, and every message row
// formats its time on every render. Rebuilt when the time zone changes, which a
// formatter does not follow by itself.
let chatTimeFormat: { format: Intl.DateTimeFormat; zoneOffset: number } | undefined;

export function formatChatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString();
  }
  const zoneOffset = new Date().getTimezoneOffset();
  if (!chatTimeFormat || chatTimeFormat.zoneOffset !== zoneOffset) {
    chatTimeFormat = { format: new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }), zoneOffset };
  }
  return chatTimeFormat.format.format(date);
}

export function defaultImageFilename(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return "image.jpg";
  }
  if (mimeType === "image/webp") {
    return "image.webp";
  }
  return "image.png";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
