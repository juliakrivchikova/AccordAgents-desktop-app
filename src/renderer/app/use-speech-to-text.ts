import { useEffect, useState } from "react";

import type { SpeechToTextState } from "../../shared/types";

/** Speech to text as the desktop knows it now; undefined until it answers. */
export function useSpeechToTextState(): SpeechToTextState | undefined {
  const [state, setState] = useState<SpeechToTextState | undefined>();
  useEffect(() => {
    let active = true;
    // Component tests mount message fields without the whole bridge.
    const bridge = window.consensus as Partial<typeof window.consensus> | undefined;
    const stop = bridge?.onSpeechToTextState?.((next) => {
      if (active) setState(next);
    });
    void bridge?.getSpeechToTextState?.().then((next) => {
      if (active) setState((current) => current ?? next);
    }).catch(() => undefined);
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  return state;
}
