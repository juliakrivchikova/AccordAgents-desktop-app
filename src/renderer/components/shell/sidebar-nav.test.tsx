import assert from "node:assert/strict";
import test from "node:test";
import { act as domAct } from "react";
import { createRoot } from "react-dom/client";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationSummary } from "../../../shared/types";
import {
  chatSearchShortcutAria,
  chatSearchShortcutLabel,
  isChatSearchShortcut,
  useChatSearchShortcut,
  type ShortcutKeyEvent
} from "../../app/chat-search-shortcut";
import { Sidebar, type SidebarProps } from "./sidebar";

function key(overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent {
  return { key: "k", code: "KeyK", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

test("search opens with Command-K on macOS and Ctrl-K elsewhere, on any keyboard layout", () => {
  assert.equal(isChatSearchShortcut(key({ metaKey: true }), true), true);
  assert.equal(isChatSearchShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isChatSearchShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isChatSearchShortcut(key({ metaKey: true }), false), false);
  assert.equal(isChatSearchShortcut(key({ key: "K", metaKey: true }), true), true);
  // A Russian layout reports its own letter for the physical K key.
  assert.equal(isChatSearchShortcut(key({ key: "л", metaKey: true }), true), true);
  assert.equal(isChatSearchShortcut(key({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(isChatSearchShortcut(key({ metaKey: true, altKey: true }), true), false);
  assert.equal(isChatSearchShortcut(key({ key: "j", code: "KeyJ", metaKey: true }), true), false);
  assert.equal(isChatSearchShortcut(key({}), true), false);
  // On Dvorak the physical K key types "t": Command-T must not open search.
  assert.equal(isChatSearchShortcut(key({ key: "t", code: "KeyK", metaKey: true }), true), false);
  assert.equal(isChatSearchShortcut(key({ metaKey: true, ctrlKey: true }), true), false);
  assert.equal(isChatSearchShortcut(key({ metaKey: true, ctrlKey: true }), false), false);
  // A synthetic keydown can arrive without a key at all.
  assert.equal(isChatSearchShortcut(key({ key: undefined as unknown as string, code: "", metaKey: true }), true), false);
  assert.equal(chatSearchShortcutLabel(true), "⌘K");
  assert.equal(chatSearchShortcutLabel(false), "Ctrl K");
  assert.equal(chatSearchShortcutAria(true), "Meta+K");
  assert.equal(chatSearchShortcutAria(false), "Control+K");
});

test("the sidebar leads with search, New chat and Activity, and keeps Settings at the bottom", () => {
  const calls: string[] = [];
  const renderer = renderSidebar({
    activityUnreadCount: 3,
    onOpenSearch: () => calls.push("search"),
    onNewSession: () => calls.push("new"),
    onOpenActivity: () => calls.push("activity"),
    onOpenSettings: () => calls.push("settings")
  });

  const order = renderer.root
    .findAll((node) => typeof node.type === "string" && typeof node.props["data-testid"] === "string")
    .map((node) => node.props["data-testid"] as string)
    .filter((id) => ["chat-search-trigger", "new-chat", "sidebar-activity", "project-group", "sidebar-settings"].includes(id));
  assert.deepEqual(order, ["chat-search-trigger", "new-chat", "sidebar-activity", "project-group", "sidebar-settings"]);

  const search = byTestId(renderer, "chat-search-trigger");
  assert.equal(search.props["aria-label"], "Search chats");
  assert.equal(search.props["aria-keyshortcuts"], "Meta+K");
  assert.equal(textOf(byTestId(renderer, "chat-search-shortcut")), "⌘K");

  const activity = byTestId(renderer, "sidebar-activity");
  assert.equal(activity.props["aria-label"], "Activity, 3 unread");
  assert.equal(textOf(byTestId(renderer, "sidebar-activity-badge")), "3");

  search.props.onClick();
  byTestId(renderer, "new-chat").props.onClick();
  activity.props.onClick();
  byTestId(renderer, "sidebar-settings").props.onClick();
  assert.deepEqual(calls, ["search", "new", "activity", "settings"]);
});

test("Activity has no badge when nothing is unread, and Windows shows Ctrl K", () => {
  const renderer = renderSidebar({ activityUnreadCount: 0, macShortcuts: false });
  const activity = byTestId(renderer, "sidebar-activity");
  assert.equal(activity.props["aria-label"], undefined);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "sidebar-activity-badge" }).length, 0);
  assert.equal(textOf(byTestId(renderer, "chat-search-shortcut")), "Ctrl K");
});

test("the Activity badge caps large counts and New chat is disabled while busy", () => {
  const renderer = renderSidebar({ activityUnreadCount: 250, busy: true });
  assert.equal(textOf(byTestId(renderer, "sidebar-activity-badge")), "99+");
  assert.equal(byTestId(renderer, "new-chat").props.disabled, true);
});

test("the global shortcut opens search once, and not over another dialog or after unmount", async () => {
  // jsdom reports a non-Mac platform, so the shortcut is Ctrl+K here.
  let opened = 0;
  function Harness(): null {
    useChatSearchShortcut(() => { opened += 1; });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const press = (init: KeyboardEventInit): KeyboardEvent => {
    const event = new window.KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  };
  try {
    await domAct(async () => { root.render(<Harness />); });
    const first = press({});
    assert.equal(opened, 1);
    assert.equal(first.defaultPrevented, true);
    press({ repeat: true });
    assert.equal(opened, 1);
    const handled = new window.KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    assert.equal(opened, 1);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    const overDialog = press({});
    assert.equal(opened, 1);
    assert.equal(overDialog.defaultPrevented, false);
    dialog.remove();
    await domAct(async () => { root.unmount(); });
    press({});
    assert.equal(opened, 1);
  } finally {
    container.remove();
  }
});

function renderSidebar(overrides: Partial<SidebarProps>): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <Sidebar
        projectGroups={[{
          key: "repo",
          label: "shop-web",
          repoPath: "/tmp/shop-web",
          updatedAt: "2026-09-24T00:00:00.000Z",
          sessions: [summary("chat-1", "Checkout retry flow")]
        }]}
        macShortcuts
        onOpenSearch={() => undefined}
        onOpenActivity={() => undefined}
        onOpenSettings={() => undefined}
        onSelect={() => undefined}
        onNewSession={() => undefined}
        onNewProjectSession={() => undefined}
        {...overrides}
      />
    );
  });
  assert.ok(renderer);
  return renderer;
}

function byTestId(renderer: ReactTestRenderer, testId: string): ReactTestInstance {
  return renderer.root.find((node) => typeof node.type === "string" && node.props["data-testid"] === testId);
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    kind: "chat",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z"
  } as ConversationSummary;
}
