// The pinned Accord card's own choices on this device, by launch message id:
// which she folded into one line (kept), and which she just pressed the
// cross on (this window only: the card leaves at once, and the chat's record
// of its line takes over, conversation.metadata.accordClosedLaunchIds). The
// cross used to close a card for good on one device ("closed", before
// 2026-11-16): that list is left as it was and no longer read.

const DOCK_STORAGE_KEY = "accordagents.accordDock.v2";
/** Launch ids kept per choice; the oldest go first. */
const DOCK_CHOICES_MAX = 200;

interface DockChoices {
  folded: string[];
}

let cached: DockChoices | undefined;
let stored: Record<string, unknown> = {};
let version = 0;
const listeners = new Set<() => void>();
const closing = new Set<string>();

function read(): DockChoices {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(DOCK_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    stored = parsed && typeof parsed === "object" ? parsed : {};
    const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    cached = { folded: list(stored.folded) };
  } catch {
    stored = {};
    cached = { folded: [] };
  }
  return cached;
}

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function write(next: DockChoices): void {
  cached = next;
  try {
    globalThis.localStorage?.setItem(DOCK_STORAGE_KEY, JSON.stringify({ ...stored, ...next }));
  } catch {
    // A full or blocked storage only forgets the choice after a restart.
  }
  changed();
}

export function accordDockFolded(launchId: string): boolean {
  return read().folded.includes(launchId);
}

export function setAccordDockFolded(launchId: string, on: boolean): void {
  const current = read();
  if (current.folded.includes(launchId) === on) return;
  const rest = current.folded.filter((id) => id !== launchId);
  write({ folded: on ? [...rest, launchId].slice(-DOCK_CHOICES_MAX) : rest });
}

/** She pressed the cross on this Accord's card in this window, and the
 *  chat's record of its line has not come yet. */
export function accordDockClosing(launchId: string): boolean {
  return closing.has(launchId);
}

export function setAccordDockClosing(launchId: string, on: boolean): void {
  if (closing.has(launchId) === on) return;
  if (on) closing.add(launchId);
  else closing.delete(launchId);
  changed();
}

export function subscribeAccordDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function accordDockVersion(): number {
  return version;
}

/** Tests: forget what was read, so a fresh storage is read again. */
export function resetAccordDockStoreForTests(): void {
  cached = undefined;
  stored = {};
  closing.clear();
  version += 1;
}
