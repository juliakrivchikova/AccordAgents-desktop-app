export function formatChatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
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
