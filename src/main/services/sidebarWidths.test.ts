import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_LIST_WIDTH_STORAGE_KEY,
  CHAT_SIDEBAR_WIDTH_STORAGE_KEY,
  LEGACY_ACTIVITY_LIST_WIDTH_STORAGE_KEY,
  LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY
} from "../../renderer/app/constants";
import {
  persistActivityListWidth,
  persistAppSidebarWidth,
  readInitialActivityListWidth,
  readInitialAppSidebarWidths,
  type SidebarWidthStorage
} from "../../renderer/lib/sidebar-width-storage";
import { DEFAULT_NAVIGATION_PANE_WIDTH } from "../../renderer/lib/sidebar-sizing";

class MemoryStorage implements SidebarWidthStorage {
  private readonly values = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("fresh sidebar storage uses the canonical default without writing overrides", () => {
  const storage = new MemoryStorage();

  assert.deepEqual(readInitialAppSidebarWidths(storage), {
    chats: DEFAULT_NAVIGATION_PANE_WIDTH,
    settings: DEFAULT_NAVIGATION_PANE_WIDTH
  });
  assert.equal(readInitialActivityListWidth(storage), DEFAULT_NAVIGATION_PANE_WIDTH);
  assert.equal(storage.getItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY), null);
  assert.equal(storage.getItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY), null);
  assert.equal(storage.getItem(ACTIVITY_LIST_WIDTH_STORAGE_KEY), null);
});

test("legacy defaults and invalid values reset without creating v2 overrides", () => {
  for (const entries of [
    {
      [LEGACY_SIDEBAR_WIDTH_STORAGE_KEY]: "266",
      [LEGACY_ACTIVITY_LIST_WIDTH_STORAGE_KEY]: "400"
    },
    {
      [LEGACY_SIDEBAR_WIDTH_STORAGE_KEY]: "invalid",
      [LEGACY_ACTIVITY_LIST_WIDTH_STORAGE_KEY]: "invalid"
    },
    {
      [LEGACY_SIDEBAR_WIDTH_STORAGE_KEY]: "",
      [LEGACY_ACTIVITY_LIST_WIDTH_STORAGE_KEY]: "   "
    }
  ]) {
    const storage = new MemoryStorage(entries);

    assert.deepEqual(readInitialAppSidebarWidths(storage), {
      chats: DEFAULT_NAVIGATION_PANE_WIDTH,
      settings: DEFAULT_NAVIGATION_PANE_WIDTH
    });
    assert.equal(readInitialActivityListWidth(storage), DEFAULT_NAVIGATION_PANE_WIDTH);
    assert.equal(storage.getItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY), null);
    assert.equal(storage.getItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY), null);
    assert.equal(storage.getItem(ACTIVITY_LIST_WIDTH_STORAGE_KEY), null);
  }
});

test("non-default legacy widths migrate once into independent v2 keys", () => {
  const storage = new MemoryStorage({
    [LEGACY_SIDEBAR_WIDTH_STORAGE_KEY]: "351.6",
    [LEGACY_ACTIVITY_LIST_WIDTH_STORAGE_KEY]: "451.6"
  });

  assert.deepEqual(readInitialAppSidebarWidths(storage), { chats: 352, settings: 352 });
  assert.equal(readInitialActivityListWidth(storage), 452);
  assert.equal(storage.getItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY), "352");
  assert.equal(storage.getItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY), "352");
  assert.equal(storage.getItem(ACTIVITY_LIST_WIDTH_STORAGE_KEY), "452");
});

test("an existing v2 key prevents legacy values from bleeding into a missing sibling key", () => {
  const storage = new MemoryStorage({
    [LEGACY_SIDEBAR_WIDTH_STORAGE_KEY]: "380",
    [CHAT_SIDEBAR_WIDTH_STORAGE_KEY]: "340"
  });

  assert.deepEqual(readInitialAppSidebarWidths(storage), {
    chats: 340,
    settings: DEFAULT_NAVIGATION_PANE_WIDTH
  });
  assert.equal(storage.getItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY), null);
});

test("per-view writes remain isolated and survive re-read", () => {
  const storage = new MemoryStorage();

  persistAppSidebarWidth(storage, CHAT_SIDEBAR_WIDTH_STORAGE_KEY, 344);
  persistAppSidebarWidth(storage, SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY, 376);
  persistActivityListWidth(storage, 448);

  assert.deepEqual(readInitialAppSidebarWidths(storage), { chats: 344, settings: 376 });
  assert.equal(readInitialActivityListWidth(storage), 448);
  assert.equal(storage.getItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY), "344");
  assert.equal(storage.getItem(SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY), "376");
  assert.equal(storage.getItem(ACTIVITY_LIST_WIDTH_STORAGE_KEY), "448");
});

test("an intentional Activity reset persists the canonical width", () => {
  const storage = new MemoryStorage();

  persistActivityListWidth(storage, DEFAULT_NAVIGATION_PANE_WIDTH);

  assert.equal(storage.getItem(ACTIVITY_LIST_WIDTH_STORAGE_KEY), "320");
  assert.equal(readInitialActivityListWidth(storage), DEFAULT_NAVIGATION_PANE_WIDTH);
});
