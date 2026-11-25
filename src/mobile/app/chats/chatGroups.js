export const chatGroupsState = {
  // The search filters what the phone already holds: title, who wrote last
  // and what they wrote. It never asks the desktop.
  chatSearchQuery: ""
};

// Which projects are folded in the chat list. Persisted: the phone reopens
// the app many times a day, and a second project that takes a long scroll to
// reach every time was the complaint. The desktop folds its project groups
// the same way, with the same chevron.
const COLLAPSED_CHAT_GROUPS_KEY = "accordagents.mobile.collapsedChatGroups.v1";

export function loadCollapsedChatGroups() {
  try {
    const raw = localStorage.getItem(COLLAPSED_CHAT_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(function (name) { return typeof name === "string"; }) : [];
  } catch {
    return [];
  }
}

export function toggleChatGroupCollapsed(name) {
  const current = loadCollapsedChatGroups();
  const next = current.indexOf(name) >= 0
    ? current.filter(function (item) { return item !== name; })
    : current.concat([name]);
  try {
    localStorage.setItem(COLLAPSED_CHAT_GROUPS_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the fold is lost with the tap, not the app.
  }
}

export function groupedChats(chats) {
  const groups = [];
  const groupByName = new Map();
  for (const chat of chats) {
    const name = chat.group || "AccordAgents";
    let group = groupByName.get(name);
    if (!group) {
      group = { name, items: [] };
      groupByName.set(name, group);
      groups.push(group);
    }
    group.items.push(chat);
  }
  return groups;
}

export function chatMatchesQuery(chat, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [chat.title, chat.who, chat.snippet, chat.group].some(function (field) {
    return typeof field === "string" && field.toLowerCase().includes(needle);
  });
}

export function filterChatsByQuery(chats, query) {
  return chats.filter(function (chat) {
    return chatMatchesQuery(chat, query);
  });
}
