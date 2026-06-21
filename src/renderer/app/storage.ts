import {
  DISMISSED_WARNINGS_STORAGE_KEY,
  LAST_VIEWED_AT_STORAGE_KEY,
  SIDEBAR_COLLAPSED_STORAGE_KEY
} from "./constants";

export type DismissedWarningMap = Record<string, string[]>;

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

export function readInitialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
