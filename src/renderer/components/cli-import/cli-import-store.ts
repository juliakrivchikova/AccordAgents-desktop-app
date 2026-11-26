import { useSyncExternalStore } from "react";
import type { CliImportListResult } from "../../../shared/types";

// The import dialog's state for the window: whether it is open (and for
// which folder), and the last list of the User's CLI threads, read once and
// kept, so New chat can offer a folder's threads at its first paint without
// waiting (a list that arrives later would move the screen).

export interface CliImportDialogRequest {
  /** Opened for one folder (from New chat): its threads are shown first. */
  folder?: string;
}

interface CliImportState {
  open: CliImportDialogRequest | undefined;
  list: CliImportListResult | undefined;
}

let state: CliImportState = { open: undefined, list: undefined };
const listeners = new Set<() => void>();
let reading: Promise<CliImportListResult> | undefined;

function set(next: Partial<CliImportState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openCliImport(request: CliImportDialogRequest = {}): void {
  set({ open: request });
}

export function closeCliImport(): void {
  set({ open: undefined });
}

/** Reads the list again from the CLIs' stores (and remembers it). */
export function refreshCliImportList(): Promise<CliImportListResult> {
  const read = window.consensus.listCliImportThreads();
  reading = read;
  void read.then((list) => {
    if (reading === read) set({ list });
  }, () => undefined);
  return read;
}

/** The remembered list, read once in the background if it was never read. */
export function warmCliImportList(): void {
  if (!state.list && !reading) void refreshCliImportList().catch(() => undefined);
}

export function useCliImportDialog(): CliImportDialogRequest | undefined {
  return useSyncExternalStore(subscribe, () => state.open);
}

export function useCliImportList(): CliImportListResult | undefined {
  return useSyncExternalStore(subscribe, () => state.list);
}
