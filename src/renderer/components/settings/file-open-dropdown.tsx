import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Code2, ExternalLink, FolderOpen, HelpCircle, PanelRight } from "lucide-react";

import type { RepoFileOpenAction } from "../../../shared/types";

// The file-open choices in General settings: what a click on a file link does,
// and what the side panel's Open button does.
export interface FileOpenOption {
  key: "panel" | "open" | "reveal" | "intellij-idea" | "ask";
  value: RepoFileOpenAction | null;
  pillLabel: string;
  menuLabel: string;
  icon: typeof ExternalLink;
}

export const EXTERNAL_OPEN_OPTIONS: FileOpenOption[] = [
  { key: "open", value: "open", pillLabel: "Open with default app", menuLabel: "Open with default app", icon: ExternalLink },
  { key: "intellij-idea", value: "intellij-idea", pillLabel: "Open in IntelliJ IDEA", menuLabel: "Open in IntelliJ IDEA", icon: Code2 },
  { key: "ask", value: null, pillLabel: "Ask every time", menuLabel: "Ask every time", icon: HelpCircle }
];

export const FILE_OPEN_OPTIONS: FileOpenOption[] = [
  { key: "panel", value: "panel", pillLabel: "Open in side panel", menuLabel: "Open in side panel", icon: PanelRight },
  { key: "open", value: "open", pillLabel: "Open with default app", menuLabel: "Open with default app", icon: ExternalLink },
  { key: "reveal", value: "reveal", pillLabel: "Reveal in file manager", menuLabel: "Reveal in file manager", icon: FolderOpen },
  { key: "intellij-idea", value: "intellij-idea", pillLabel: "Open in IntelliJ IDEA", menuLabel: "Open in IntelliJ IDEA", icon: Code2 },
  { key: "ask", value: null, pillLabel: "Ask every time", menuLabel: "Reset to ask", icon: HelpCircle }
];

export function FileOpenDropdown(props: {
  options: FileOpenOption[];
  action: RepoFileOpenAction | null;
  onChange: (action: RepoFileOpenAction | null) => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = props.options.find((option) => option.value === props.action)
    ?? props.options.find((option) => option.key === "ask")
    ?? props.options[0];

  const closeMenu = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  };

  const openMenu = (): void => {
    // Anchor to the trigger's viewport rect and render in a portal so the
    // settings pane's overflow:auto can't clip the menu near the pane edge.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setOpen(true);
  };

  const menuItems = (): HTMLButtonElement[] =>
    menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")) : [];

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu(false);
    };
    const dismiss = (): void => closeMenu(false);
    const onKeyDown = (event: KeyboardEvent): void => {
      const items = menuItems();
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) {
          return;
        }
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // A fixed menu would drift on scroll/resize; dismiss instead of repositioning.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    const focusFrame = requestAnimationFrame(() => {
      const items = menuItems();
      const selected = items.find((item) => item.getAttribute("aria-checked") === "true");
      (selected ?? items[0])?.focus();
    });
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      cancelAnimationFrame(focusFrame);
    };
  }, [open]);

  const select = (value: RepoFileOpenAction | null): void => {
    closeMenu(true);
    void props.onChange(value);
  };

  const CurrentIcon = current.icon;
  return (
    <div className="gen-dropdown">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`gen-pill ${open ? "is-open" : ""}`}
        onClick={() => (open ? closeMenu(true) : openMenu())}
      >
        <span className="gen-pill-lead"><CurrentIcon size={16} /></span>
        <span className="gen-pill-label">{current.pillLabel}</span>
        <ChevronDown size={16} className="gen-pill-chev" />
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="gen-menu"
          role="menu"
          style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
        >
          {props.options.map((option) => {
            const Icon = option.icon;
            const selected = option.key === current.key;
            return (
              <button
                type="button"
                key={option.key}
                role="menuitemradio"
                aria-checked={selected}
                className={`gen-menu-item ${selected ? "is-selected" : ""}`}
                onClick={() => select(option.value)}
              >
                <span className="gen-menu-item-icon"><Icon size={16} /></span>
                <span className="gen-menu-item-label">{option.menuLabel}</span>
                {selected && <Check size={15} className="gen-menu-item-check" />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}
