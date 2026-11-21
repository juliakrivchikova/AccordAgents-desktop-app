import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// The New chat screen's own menus (folder, members, model): closed by a press
// outside them, and as tall as the room above them allows.

const NEW_CHAT_MENU_OFFSET = 8;
const NEW_CHAT_PARTICIPANT_MENU_OVERLAP = 80;
const NEW_CHAT_MENU_VIEWPORT_MARGIN = 16;

export function useCloseOnOutside<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose, open]);

  return ref;
}

export function useNewChatMenuMaxHeight<T extends HTMLElement>(rootRef: RefObject<T>, open: boolean): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number | undefined>();

  useLayoutEffect(() => {
    if (!open) {
      setMaxHeight(undefined);
      return;
    }

    function updateMaxHeight(): void {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const topbarBottom = document.querySelector<HTMLElement>("[data-shell='topbar']")?.getBoundingClientRect().bottom ?? 0;
      const safeTop = Math.max(NEW_CHAT_MENU_VIEWPORT_MARGIN, topbarBottom + NEW_CHAT_MENU_VIEWPORT_MARGIN);
      setMaxHeight(Math.max(0, Math.floor(rect.top - NEW_CHAT_MENU_OFFSET + NEW_CHAT_PARTICIPANT_MENU_OVERLAP - safeTop)));
    }

    updateMaxHeight();
    window.addEventListener("resize", updateMaxHeight);
    window.addEventListener("scroll", updateMaxHeight, true);
    return () => {
      window.removeEventListener("resize", updateMaxHeight);
      window.removeEventListener("scroll", updateMaxHeight, true);
    };
  }, [open, rootRef]);

  return maxHeight;
}
