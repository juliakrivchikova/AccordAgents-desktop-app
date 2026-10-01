import { useEffect, useRef } from "react";
import { isMacPlatform } from "../lib/platform";

export type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

export function chatSearchShortcutLabel(mac = isMacPlatform()): string {
  return mac ? "⌘K" : "Ctrl K";
}

export function chatSearchShortcutAria(mac = isMacPlatform()): string {
  return mac ? "Meta+K" : "Control+K";
}

// Falls back to the physical K key only when the layout types a non-Latin
// letter there (Cyrillic, Greek, ...); on Dvorak or Colemak that key is
// another Latin letter and must not open search.
export function isChatSearchShortcut(event: ShortcutKeyEvent, mac = isMacPlatform()): boolean {
  if (event.altKey || event.shiftKey) {
    return false;
  }
  const key = (event.key ?? "").toLowerCase();
  const physicalK = event.code === "KeyK" && !/^[a-z]$/.test(key);
  if (key !== "k" && !physicalK) {
    return false;
  }
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function useChatSearchShortcut(onOpen: () => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    const mac = isMacPlatform();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || !isChatSearchShortcut(event, mac)) {
        return;
      }
      // Another dialog owns the keyboard; stacking search over it would let a
      // result change the chat underneath a half-finished dialog.
      if (document.querySelector(OPEN_DIALOG_SELECTOR)) {
        return;
      }
      event.preventDefault();
      onOpenRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
