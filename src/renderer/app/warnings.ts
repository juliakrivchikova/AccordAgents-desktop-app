import type { Conversation } from "../../shared/types";
import { displayNoticeText } from "../components/review/review-conversation-data";
import { GLOBAL_WARNING_DISMISS_SCOPE } from "./constants";
import type { DismissedWarningMap } from "./storage";

export interface WarningNoticeEntry {
  key: string;
  text: string;
}

export function warningDismissScope(conversation: Conversation | undefined): string {
  return conversation?.id ?? GLOBAL_WARNING_DISMISS_SCOPE;
}

export function warningNoticeEntries(warnings: string[], dismissedKeys: Set<string>): WarningNoticeEntry[] {
  const seen = new Set<string>();
  const entries: WarningNoticeEntry[] = [];
  for (const warning of warnings) {
    const text = displayNoticeText(warning);
    if (!text || seen.has(text) || dismissedKeys.has(text)) {
      continue;
    }
    seen.add(text);
    entries.push({ key: text, text });
  }
  return entries;
}

export function addDismissedWarningKeys(current: DismissedWarningMap, scope: string, keys: string[]): DismissedWarningMap {
  const additions = keys.filter(Boolean);
  if (additions.length === 0) {
    return current;
  }
  const existing = current[scope] ?? [];
  const merged = Array.from(new Set([...existing, ...additions]));
  if (merged.length === existing.length) {
    return current;
  }
  return { ...current, [scope]: merged };
}
