import { useSyncExternalStore } from "react";

import { persistSidebarSections, readSidebarSections } from "../../app/storage";
import type { SidebarSections } from "../../lib/sidebar-sections-storage";

// What the User folded or opened in the chats sidebar. It lives outside the
// sidebar because Settings puts its own sidebar in that place, and it is saved
// so the next launch opens the sidebar the way the User left it.
let current: SidebarSections | undefined;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = (): SidebarSections => {
  current ??= readSidebarSections();
  return current;
};

export const useSidebarSections = (): SidebarSections => useSyncExternalStore(subscribe, snapshot, snapshot);

export const updateSidebarSections = (change: (sections: SidebarSections) => Partial<SidebarSections>): void => {
  const sections = snapshot();
  current = { ...sections, ...change(sections) };
  persistSidebarSections(current);
  listeners.forEach((listener) => listener());
};

/** Forgets what this window holds, so the next read comes from storage, the
 *  way a freshly opened window starts. */
export const reloadSidebarSections = (): void => {
  current = undefined;
  listeners.forEach((listener) => listener());
};

export const withKeyToggled = (keys: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
};
