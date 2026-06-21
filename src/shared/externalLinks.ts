export function normalizeExternalUrlForOpen(url: unknown): string {
  if (typeof url !== "string") {
    throw new Error("External URL must be a string.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("External URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("External URL protocol is not allowed.");
  }
  return parsed.toString();
}
