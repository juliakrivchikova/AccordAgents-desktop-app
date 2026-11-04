import { useSyncExternalStore } from "react";

import type { SpeechToTextState } from "../../shared/types";

/**
 * Speech to text as the desktop knows it, shared by every message field and
 * the settings row: one subscription and one question to the main process,
 * and a field that opens later shows the microphone at once.
 */
let current: SpeechToTextState | undefined;
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;

function publish(next: SpeechToTextState): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopListening) {
    // The last known state renders at once; the answer below replaces it
    // unless a newer change has already arrived.
    let changed = false;
    // Component tests mount message fields without the whole bridge.
    const bridge = window.consensus as Partial<typeof window.consensus> | undefined;
    stopListening = bridge?.onSpeechToTextState?.((next) => {
      changed = true;
      publish(next);
    }) ?? (() => undefined);
    void bridge?.getSpeechToTextState?.().then((state) => {
      if (!changed) publish(state);
    }).catch(() => undefined);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
}

export function useSpeechToTextState(): SpeechToTextState | undefined {
  return useSyncExternalStore(subscribe, () => current);
}
