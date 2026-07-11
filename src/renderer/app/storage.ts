import {
  ACCORD_LAUNCHER_STORAGE_KEY,
  ACTIVITY_ITEM_PREFERENCES_STORAGE_KEY,
  CHAT_SIDEBAR_WIDTH_STORAGE_KEY,
  DISMISSED_WARNINGS_STORAGE_KEY,
  LAST_VIEWED_AT_STORAGE_KEY,
  SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_COLLAPSED_STORAGE_KEY
} from "./constants";
import {
  type AccordLauncherPreferences,
  normalizeAccordLauncherPreferences,
  parseAccordLauncherPreferencesJson
} from "../../shared/accordLauncherPreferences";
import type { ChatActivityItemPreferences } from "../../shared/chatActivity";
import {
  type InitialAppSidebarWidths,
  persistActivityListWidth as persistActivityListWidthToStorage,
  persistAppSidebarWidth,
  readInitialActivityListWidth as readInitialActivityListWidthFromStorage,
  readInitialAppSidebarWidths as readInitialAppSidebarWidthsFromStorage
} from "../lib/sidebar-width-storage";

export type { AccordLauncherPreferences } from "../../shared/accordLauncherPreferences";

export type DismissedWarningMap = Record<string, string[]>;

export type ActivityItemPreferences = ChatActivityItemPreferences;

const MAX_STORED_ACTIVITY_ITEM_IDS = 1_000;

export function readActivityItemPreferencesFromStorage(): ActivityItemPreferences {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_ITEM_PREFERENCES_STORAGE_KEY);
    if (!raw) return emptyActivityItemPreferences();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyActivityItemPreferences();
    }
    const record = parsed as Record<string, unknown>;
    const clearedRecentThrough = storedTimestamp(record.clearedRecentThrough);
    return {
      readItemIds: storedActivityItemIds(record.readItemIds),
      clearedItemIds: storedActivityItemIds(record.clearedItemIds),
      ...(clearedRecentThrough ? { clearedRecentThrough } : {})
    };
  } catch {
    return emptyActivityItemPreferences();
  }
}

export function persistActivityItemPreferences(preferences: ActivityItemPreferences): void {
  try {
    window.localStorage.setItem(ACTIVITY_ITEM_PREFERENCES_STORAGE_KEY, JSON.stringify({
      readItemIds: [...preferences.readItemIds].slice(-MAX_STORED_ACTIVITY_ITEM_IDS),
      clearedItemIds: [...preferences.clearedItemIds].slice(-MAX_STORED_ACTIVITY_ITEM_IDS),
      clearedRecentThrough: preferences.clearedRecentThrough
    }));
  } catch {
    // Local storage persistence is best-effort.
  }
}

export function readLastViewedAtFromStorage(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LAST_VIEWED_AT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [id, ts] of Object.entries(parsed)) {
        if (typeof ts === "string") out[id] = ts;
      }
      return out;
    }
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
  return {};
}

export function persistLastViewedAt(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(LAST_VIEWED_AT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Local storage persistence is best-effort.
  }
}

export function readDismissedWarningsFromStorage(): DismissedWarningMap {
  try {
    const raw = window.localStorage.getItem(DISMISSED_WARNINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: DismissedWarningMap = {};
    for (const [scope, values] of Object.entries(parsed)) {
      if (typeof scope !== "string" || !Array.isArray(values)) {
        continue;
      }
      const warnings = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (warnings.length > 0) {
        out[scope] = Array.from(new Set(warnings));
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function persistDismissedWarnings(map: DismissedWarningMap): void {
  try {
    window.localStorage.setItem(DISMISSED_WARNINGS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Local storage persistence is best-effort.
  }
}

export function readAccordLauncherPreferences(): AccordLauncherPreferences {
  try {
    return parseAccordLauncherPreferencesJson(window.localStorage.getItem(ACCORD_LAUNCHER_STORAGE_KEY));
  } catch {
    return { subjects: [] };
  }
}

export function persistAccordLauncherPreferences(preferences: AccordLauncherPreferences): void {
  try {
    window.localStorage.setItem(
      ACCORD_LAUNCHER_STORAGE_KEY,
      JSON.stringify(normalizeAccordLauncherPreferences(preferences))
    );
  } catch {
    // Local storage persistence is best-effort.
  }
}

export function readInitialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function readInitialAppSidebarWidths(): InitialAppSidebarWidths {
  return readInitialAppSidebarWidthsFromStorage(window.localStorage);
}

export function persistChatSidebarWidth(width: number): void {
  persistAppSidebarWidth(window.localStorage, CHAT_SIDEBAR_WIDTH_STORAGE_KEY, width);
}

export function persistSettingsSidebarWidth(width: number): void {
  persistAppSidebarWidth(window.localStorage, SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY, width);
}

export function readInitialActivityListWidth(): number {
  return readInitialActivityListWidthFromStorage(window.localStorage);
}

export function persistActivityListWidth(width: number): void {
  persistActivityListWidthToStorage(window.localStorage, width);
}

function emptyActivityItemPreferences(): ActivityItemPreferences {
  return { readItemIds: new Set(), clearedItemIds: new Set() };
}

function storedActivityItemIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(value
    .filter((itemId): itemId is string => typeof itemId === "string" && itemId.trim().length > 0)
    .slice(-MAX_STORED_ACTIVITY_ITEM_IDS));
}

function storedTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
