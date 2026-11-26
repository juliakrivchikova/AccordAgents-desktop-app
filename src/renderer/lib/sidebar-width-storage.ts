import {
  CHAT_SIDEBAR_WIDTH_STORAGE_KEY,
  LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY
} from "../app/constants";
import {
  DEFAULT_NAVIGATION_PANE_WIDTH,
  normalizeAppSidebarWidth
} from "./sidebar-sizing";

const LEGACY_APP_SIDEBAR_DEFAULT = 266;

export interface SidebarWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface InitialAppSidebarWidths {
  chats: number;
  settings: number;
}

export function readInitialAppSidebarWidths(storage: SidebarWidthStorage): InitialAppSidebarWidths {
  const chatWidth = readStoredValue(storage, CHAT_SIDEBAR_WIDTH_STORAGE_KEY);
  const settingsWidth = readStoredValue(storage, SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY);
  if (chatWidth !== null || settingsWidth !== null) {
    return {
      chats: normalizeCurrentAppSidebarWidth(chatWidth),
      settings: normalizeCurrentAppSidebarWidth(settingsWidth)
    };
  }

  const legacyWidth = finiteStoredNumber(readStoredValue(storage, LEGACY_SIDEBAR_WIDTH_STORAGE_KEY));
  if (legacyWidth === undefined || legacyWidth === LEGACY_APP_SIDEBAR_DEFAULT) {
    return defaultAppSidebarWidths();
  }

  const migratedWidth = normalizeAppSidebarWidth(legacyWidth);
  writeStoredValue(storage, CHAT_SIDEBAR_WIDTH_STORAGE_KEY, migratedWidth);
  writeStoredValue(storage, SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY, migratedWidth);
  return { chats: migratedWidth, settings: migratedWidth };
}

export function persistAppSidebarWidth(
  storage: SidebarWidthStorage,
  storageKey: typeof CHAT_SIDEBAR_WIDTH_STORAGE_KEY | typeof SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY,
  width: number
): void {
  writeStoredValue(storage, storageKey, normalizeAppSidebarWidth(width));
}

function defaultAppSidebarWidths(): InitialAppSidebarWidths {
  return {
    chats: DEFAULT_NAVIGATION_PANE_WIDTH,
    settings: DEFAULT_NAVIGATION_PANE_WIDTH
  };
}

function normalizeCurrentAppSidebarWidth(value: string | null): number {
  return value === null ? DEFAULT_NAVIGATION_PANE_WIDTH : normalizeAppSidebarWidth(value);
}

function finiteStoredNumber(value: string | null): number | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return undefined;
  }
  const numericValue = Number(normalizedValue);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function readStoredValue(storage: SidebarWidthStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(storage: SidebarWidthStorage, key: string, width: number): void {
  try {
    storage.setItem(key, String(width));
  } catch {
    // Local storage persistence is best-effort.
  }
}
