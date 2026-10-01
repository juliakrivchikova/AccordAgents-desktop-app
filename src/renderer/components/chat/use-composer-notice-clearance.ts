import { useLayoutEffect } from "react";

// The notice stack (app/app-notices.tsx) sits in the bottom-right corner, just
// above the composers. A composer grows with its draft, chips and images, so
// each one reports how far its top edge is from the window's bottom and the
// stack clears the tallest.
const clearanceByComposer = new Map<object, number>();

function publishClearance(): void {
  const clearance = Math.max(0, ...clearanceByComposer.values());
  document.documentElement.style.setProperty("--chat-composer-clearance", `${Math.ceil(clearance)}px`);
}

export function useComposerNoticeClearance(ref: React.RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const key = {};
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      // A composer that is not laid out (a hidden pane) needs no room.
      clearanceByComposer.set(key, rect.height > 0 ? window.innerHeight - rect.top : 0);
      publishClearance();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      clearanceByComposer.delete(key);
      publishClearance();
    };
  }, [ref]);
}
