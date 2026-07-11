import type { ChatActivityItem } from "../../shared/types";
import {
  applyChatActivityItemPreferences,
  chatActivityItemPreferencesAfterClear
} from "../../shared/chatActivity";
import type { AppState } from "./app-state";
import { persistActivityItemPreferences } from "./storage";

export function activityItemsWithStoredPreferences(
  state: AppState,
  items: ChatActivityItem[]
): ChatActivityItem[] {
  const preferences = state.activityItemPreferencesRef.current;
  return applyChatActivityItemPreferences(items, preferences);
}

export function markActivityItemRead(state: AppState, itemId: string): void {
  const normalizedId = itemId.trim();
  if (!normalizedId) return;
  const current = state.activityItemPreferencesRef.current;
  const readItemIds = new Set(current.readItemIds);
  readItemIds.delete(normalizedId);
  readItemIds.add(normalizedId);
  const next = { ...current, readItemIds };
  state.activityItemPreferencesRef.current = next;
  persistActivityItemPreferences(next);
  state.setActivityItems((items) => items.map((item) =>
    item.id === normalizedId ? { ...item, read: true } : item
  ));
  state.setSelectedActivityItem((item) =>
    item?.id === normalizedId ? { ...item, read: true } : item
  );
}

export function clearActivityItem(state: AppState, itemId: string): void {
  const normalizedId = itemId.trim();
  if (!normalizedId) return;
  const current = state.activityItemPreferencesRef.current;
  const next = chatActivityItemPreferencesAfterClear(
    current,
    state.activityItems,
    normalizedId
  );
  state.activityItemPreferencesRef.current = next;
  persistActivityItemPreferences(next);
  state.setActivityItems((items) => items.filter((item) => item.id !== normalizedId));
  state.setSelectedActivityItem((item) => item?.id === normalizedId ? undefined : item);
}
