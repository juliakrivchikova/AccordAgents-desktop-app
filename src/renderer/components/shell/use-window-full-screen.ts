import { useEffect, useState } from "react";

/** Whether the window is in full screen, where macOS hides the traffic
 *  lights: the title rows then keep no room for them (the User, 2026-11-27). */
export function useWindowFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    const bridge = window.consensus;
    let active = true;
    // A change that comes first is newer than the answer to the question.
    let changed = false;
    const stop = bridge?.onFullScreenChanged?.((value) => {
      changed = true;
      setFullScreen(value);
    });
    void bridge?.isFullScreen?.().then((value) => {
      if (active && !changed) setFullScreen(value);
    }).catch(() => undefined);
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  return fullScreen;
}
