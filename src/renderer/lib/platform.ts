export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);
}
