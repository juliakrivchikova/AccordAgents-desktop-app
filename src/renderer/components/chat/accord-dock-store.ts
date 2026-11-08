// The pinned Accord card's own choices on this device: which Accords' cards
// the User closed and which she folded into one line, by launch message id.
// Closing brings the Accord's notes back into the chat, so the timeline reads
// the closed set too and redraws when it changes.

const DOCK_STORAGE_KEY = "accordagents.accordDock.v2";
/** Launch ids kept per choice; the oldest go first. */
const DOCK_CHOICES_MAX = 200;

interface DockChoices {
  closed: string[];
  folded: string[];
}

let cached: DockChoices | undefined;
let version = 0;
const listeners = new Set<() => void>();

function read(): DockChoices {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(DOCK_STORAGE_KEY) ?? "{}") as Partial<DockChoices>;
    const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    cached = { closed: list(parsed.closed), folded: list(parsed.folded) };
  } catch {
    cached = { closed: [], folded: [] };
  }
  return cached;
}

function write(next: DockChoices): void {
  cached = next;
  version += 1;
  try {
    globalThis.localStorage?.setItem(DOCK_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage only forgets the choice after a restart.
  }
  for (const listener of listeners) listener();
}

export function accordDockClosed(launchId: string): boolean {
  return read().closed.includes(launchId);
}

export function accordDockFolded(launchId: string): boolean {
  return read().folded.includes(launchId);
}

/** Launches whose card the User closed. */
export function closedAccordDockLaunches(): ReadonlySet<string> {
  return new Set(read().closed);
}

export function setAccordDockChoice(choice: keyof DockChoices, launchId: string, on: boolean): void {
  const current = read();
  const rest = current[choice].filter((id) => id !== launchId);
  write({ ...current, [choice]: on ? [...rest, launchId].slice(-DOCK_CHOICES_MAX) : rest });
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
  version += 1;
}
