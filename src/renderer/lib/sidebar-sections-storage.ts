/** Which parts of the chats sidebar the User folded or opened. */
export interface SidebarSections {
  /** Projects are keyed by their repository path, which stays the same across launches. */
  collapsedProjectKeys: ReadonlySet<string>;
  /** Projects showing all their chats, past the first few. */
  expandedProjectKeys: ReadonlySet<string>;
  pinnedCollapsed: boolean;
  recentsCollapsed: boolean;
  archivedCollapsed: boolean;
}

export const DEFAULT_SIDEBAR_SECTIONS: SidebarSections = {
  collapsedProjectKeys: new Set(),
  expandedProjectKeys: new Set(),
  pinnedCollapsed: false,
  recentsCollapsed: false,
  archivedCollapsed: true
};

/** Reads what an earlier launch saved; anything missing or damaged falls back
 *  to how a new window shows that part. */
export function parseSidebarSections(raw: string | null): SidebarSections {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    // A damaged value is treated as none.
  }
  const keys = (value: unknown): ReadonlySet<string> => new Set(
    Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []
  );
  const flag = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
  return {
    collapsedProjectKeys: keys(stored.collapsedProjectKeys),
    expandedProjectKeys: keys(stored.expandedProjectKeys),
    pinnedCollapsed: flag(stored.pinnedCollapsed, DEFAULT_SIDEBAR_SECTIONS.pinnedCollapsed),
    recentsCollapsed: flag(stored.recentsCollapsed, DEFAULT_SIDEBAR_SECTIONS.recentsCollapsed),
    archivedCollapsed: flag(stored.archivedCollapsed, DEFAULT_SIDEBAR_SECTIONS.archivedCollapsed)
  };
}

export function serializeSidebarSections(sections: SidebarSections): string {
  return JSON.stringify({
    ...sections,
    collapsedProjectKeys: [...sections.collapsedProjectKeys],
    expandedProjectKeys: [...sections.expandedProjectKeys]
  });
}
