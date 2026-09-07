import { useEffect, useSyncExternalStore } from "react";

import type { CustomAvatarSummary } from "../../../shared/avatarStudio";
import { avatarImageDataUrl } from "../../../shared/avatarStudio";

// Generated avatars are files in userData, not settings payload, so the renderer
// fetches their bytes once per session and keeps them in a module-level cache.
// `avatarForChatParticipant` is synchronous and called from every surface, so it
// reads this cache directly instead of every call site learning to await.
const urlById = new Map<string, string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function customAvatarUrl(id: string): string | undefined {
  return urlById.get(id);
}

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function load(id: string): Promise<void> {
  if (urlById.has(id) || inFlight.has(id)) {
    return;
  }
  inFlight.add(id);
  try {
    const result = await window.consensus.readCustomAvatar(id);
    urlById.set(id, avatarImageDataUrl(result.mediaType, result.dataBase64));
    notify();
  } catch {
    // A missing file must not break the surface that asked; the avatar falls
    // back to initials and a later save can still succeed.
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Loads every saved custom avatar and re-renders the caller when new bytes
 * arrive. Mounted once at the app root so members drawn in the studio show up in
 * the timeline and the roster, not only inside the picker that saved them.
 */
export function useCustomAvatarLibrary(summaries: CustomAvatarSummary[]): number {
  const signature = summaries.map((entry) => entry.id).join("|");
  const current = useSyncExternalStore(subscribe, () => version, () => version);

  useEffect(() => {
    for (const entry of summaries) {
      void load(entry.id);
    }
    // The id list is the only input that can add work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return current;
}

/** Puts a freshly saved avatar in the cache so it shows without a round trip. */
export function rememberCustomAvatar(id: string, dataUrl: string): void {
  urlById.set(id, dataUrl);
  notify();
}
