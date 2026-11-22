import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";

/**
 * One quiet control of a sessions-view composer and its own small menu, the
 * way Claude's desktop app, Codex and T3 Code put the model, the effort and
 * the permission mode under their composers (the User, 2026-11-21): the
 * control names what is chosen; its menu lists the choices, each with the
 * vendor's description wrapped under its name and a check on the chosen one.
 *
 * The menu is laid over the window (fixed, in document.body), never inside
 * the composer or the side panel, so nothing clips it: it opens above its
 * control when there is more room there (below otherwise), is never taller
 * than that room nor wider than the window less a margin, and is pushed
 * inside the window's edges horizontally; a long list scrolls inside it.
 */
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
const ITEM_SELECTOR = "[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled), [role='menuitemcheckbox']:not(:disabled)";
const FIELD_SELECTOR = "select:not(:disabled), input:not(:disabled), button:not(:disabled)";

interface MenuPlace {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  maxWidth: number;
}

function samePlace(a: MenuPlace, b: MenuPlace): boolean {
  return a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight && a.maxWidth === b.maxWidth;
}

export function ComposerMenu(props: {
  /** The control's own content (what is chosen). */
  label: ReactNode;
  /** The control's accessible name ("Model: Opus 5.5"). */
  title: string;
  testId: string;
  /** The menu's widest, in px (never wider than the window allows). */
  width?: number;
  /** Which edge of the control the menu lines up with. */
  align?: "start" | "end";
  disabled?: boolean;
  /** A plain icon button instead of a chip (the … menus). */
  triggerClassName?: string;
  /** No chevron after the label (icon triggers). */
  bare?: boolean;
  children: (close: () => void) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuPlace>();
  const width = props.width ?? 300;

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined);
      return;
    }
    const update = (): void => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger || typeof window === "undefined") return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const maxWidth = Math.max(160, Math.min(width, viewportWidth - VIEWPORT_MARGIN * 2));
      const above = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
      const below = viewportHeight - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const menu = menuRef.current;
      const menuWidth = Math.min(menu?.offsetWidth || maxWidth, maxWidth);
      const menuHeight = menu?.scrollHeight ?? 0;
      const openAbove = above >= Math.min(menuHeight, 240) || above >= below;
      const wantedLeft = props.align === "end" ? trigger.right - menuWidth : trigger.left;
      const left = Math.round(Math.min(Math.max(wantedLeft, VIEWPORT_MARGIN), viewportWidth - VIEWPORT_MARGIN - menuWidth));
      const next: MenuPlace = openAbove
        ? { left, bottom: Math.round(viewportHeight - trigger.top + MENU_GAP), maxHeight: Math.max(0, Math.floor(above)), maxWidth }
        : { left, top: Math.round(trigger.bottom + MENU_GAP), maxHeight: Math.max(0, Math.floor(below)), maxWidth };
      // Unchanged, nothing renders again (a streaming timeline scrolls often).
      setPlace((current) => current && samePlace(current, next) ? current : next);
    };
    update();
    // Once per frame at most: the menu's own size is known after it is laid
    // out once, and changes when its list does (the models arrive, More
    // models opens) or the side panel is dragged.
    let frame: number | undefined;
    const schedule = (): void => {
      if (frame !== undefined || typeof requestAnimationFrame !== "function") return;
      frame = requestAnimationFrame(() => { frame = undefined; update(); });
    };
    schedule();
    const onScroll = (event: Event): void => {
      // The menu's own list scrolling does not move it.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      schedule();
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", onScroll, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined;
    if (observer) {
      if (menuRef.current) observer.observe(menuRef.current);
      if (triggerRef.current) observer.observe(triggerRef.current);
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, true);
      observer?.disconnect();
    };
  }, [open, props.align, width]);

  useEffect(() => {
    if (!open || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // The keyboard lands on the chosen item (else the first, else the menu's
  // first field: where it runs) once it opens, and it is scrolled into view.
  useEffect(() => {
    if (!open || !place) return;
    const menu = menuRef.current;
    if (!menu || typeof menu.querySelector !== "function") return;
    const chosen = menu.querySelector<HTMLElement>("[aria-checked='true']:not(:disabled)") ??
      menu.querySelector<HTMLElement>(ITEM_SELECTOR) ?? menu.querySelector<HTMLElement>(FIELD_SELECTOR);
    chosen?.focus({ preventScroll: true });
    chosen?.scrollIntoView?.({ block: "nearest" });
    // Only when it opens, not on every move of the window.
  }, [open, Boolean(place)]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Tab leaves the menu: it closes and the keyboard goes back to its control.
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // A field in the menu (where it runs) keeps its own keys.
    const target = event.target as HTMLElement;
    if (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? items[(index + 1) % items.length] : items[(index - 1 + items.length) % items.length];
    next?.focus();
  };

  const menu = open ? (
    <div
      ref={menuRef}
      className="composer-menu"
      role="menu"
      aria-label={props.title}
      data-testid={`${props.testId}-menu`}
      style={place
        ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight, maxWidth: place.maxWidth, width: "max-content" }
        : { visibility: "hidden", left: 0, top: 0, maxWidth: width, width: "max-content" }}
      onKeyDown={onMenuKeyDown}
    >
      {props.children(() => {
        setOpen(false);
        triggerRef.current?.focus();
      })}
    </div>
  ) : null;
  // Laid over the window in the control's own document; where the control is
  // no DOM node (a test renderer), in place.
  const ownerBody = (triggerRef.current as { ownerDocument?: Document } | null)?.ownerDocument?.body;
  const portalTarget = ownerBody && typeof ownerBody.appendChild === "function" ? ownerBody : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={props.triggerClassName ?? "chat-model-chip composer-menu-trigger"}
        data-testid={props.testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.title}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {props.label}
        {!props.bare && <CaretDownIcon className="composer-menu-chevron" size={12} aria-hidden />}
      </button>
      {menu && (portalTarget ? createPortal(menu, portalTarget) : menu)}
    </>
  );
}

/** A titled group of a composer menu (the vendor's title: "Permission
 *  mode"). */
export function ComposerMenuSection(props: { label?: string; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <div className="composer-menu-section" role="group" aria-label={props.label} data-testid={props.testId}>
      {props.label && <div className="composer-menu-label">{props.label}</div>}
      {props.children}
    </div>
  );
}

/** One choice: its name, the vendor's description wrapped under it, a check
 *  on the chosen one; a disabled one says why in its muted line. */
export function ComposerMenuItem(props: {
  label: string;
  detail?: string;
  selected?: boolean;
  disabled?: boolean;
  mark?: ReactNode;
  tone?: "danger";
  /** "menuitemradio" (a choice, default), "menuitemcheckbox" (a toggle) or
   *  "menuitem" (an action). */
  role?: "menuitemradio" | "menuitemcheckbox" | "menuitem";
  testId: string;
  value?: string;
  onSelect: () => void;
}): JSX.Element {
  const role = props.role ?? "menuitemradio";
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitem" ? undefined : Boolean(props.selected)}
      disabled={props.disabled}
      className={`composer-menu-item${props.selected ? " is-selected" : ""}${props.tone === "danger" ? " is-danger" : ""}`}
      data-testid={props.testId}
      data-value={props.value}
      onClick={props.onSelect}
    >
      {props.mark && <span className="composer-menu-item-mark">{props.mark}</span>}
      <span className="composer-menu-item-copy">
        <span className="composer-menu-item-label">{props.label}</span>
        {props.detail && <span className="composer-menu-item-detail">{props.detail}</span>}
      </span>
      {role !== "menuitem" && (
        <span className="composer-menu-check" aria-hidden="true">{props.selected && <CheckIcon size={14} />}</span>
      )}
    </button>
  );
}

/** A muted line in a menu (a stated limit, "Reading the models…"). */
export function ComposerMenuNote(props: { children: ReactNode; testId?: string }): JSX.Element {
  return <p className="composer-menu-note" data-testid={props.testId}>{props.children}</p>;
}

/** A row that opens more choices in place (Claude's "More models"). */
export function ComposerMenuDisclosure(props: { label: string; open: boolean; onToggle: () => void; testId: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <button type="button" role="menuitem" className="composer-menu-item composer-menu-disclosure" aria-expanded={props.open}
        data-testid={props.testId} onClick={props.onToggle}>
        <span className="composer-menu-item-copy"><span className="composer-menu-item-label">{props.label}</span></span>
        {props.open ? <CaretDownIcon size={14} aria-hidden /> : <CaretRightIcon size={14} aria-hidden />}
      </button>
      {props.open && props.children}
    </>
  );
}
