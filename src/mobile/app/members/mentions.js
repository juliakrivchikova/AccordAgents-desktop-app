import { loadChats } from "../chats/chatStore.js";
import { selectedConversationId } from "../chats/openChat.js";

export function normalizeMobileMember(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const handle = typeof value.handle === "string" ? value.handle.trim().replace(/^@/, "") : "";
  if (!handle) {
    return undefined;
  }
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id : handle,
    handle,
    mentionHandle: typeof value.mentionHandle === "string" && value.mentionHandle.trim()
      ? value.mentionHandle.trim().replace(/^@/, "")
      : handle,
    displayName: typeof value.displayName === "string" && value.displayName.trim()
      ? value.displayName.trim()
      : "@" + handle,
    roleLabel: typeof value.roleLabel === "string" ? value.roleLabel.trim() : "",
    kind: typeof value.kind === "string" ? value.kind : "",
    avatarId: typeof value.avatarId === "string" ? value.avatarId : undefined,
    isAssistant: value.isAssistant === true,
    // The member's role: how the phone tells the chat's main session (the
    // member every message without an addressee goes to) and a draft's
    // administrator. Dropping it sent a message to nobody.
    ...(typeof value.roleConfigId === "string" && value.roleConfigId ? { roleConfigId: value.roleConfigId } : {}),
    // The title its delegation gave it: its name in the sessions view
    // (shared sessionsMemberTitle), however much of the chat is loaded.
    ...(typeof value.taskTitle === "string" && value.taskTitle.trim() ? { taskTitle: value.taskTitle } : {}),
    // Where this member actually runs, and what that machine needs to run
    // it. Present only for members that live on a machine.
    homeMachineId: typeof value.homeMachineId === "string" ? value.homeMachineId : undefined,
    homeMachineName: typeof value.homeMachineName === "string" && value.homeMachineName.trim()
      ? value.homeMachineName.trim()
      : undefined,
    // A Cloud run member whose machine is not chosen yet.
    cloudRun: Boolean(value.cloudRun) || Boolean(value.participant && value.participant.cloudRun),
    participant: value.participant && typeof value.participant === "object" ? value.participant : undefined
  };
}

export function activeMentionQuery(value) {
  const match = String(value || "").match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match ? match[1] : undefined;
}

export function mentionOptions(value, members) {
  const query = activeMentionQuery(value);
  if (query === undefined) {
    return [];
  }
  const normalizedQuery = query.toLowerCase();
  return (Array.isArray(members) ? members : []).filter(function (member) {
    return member.handle.toLowerCase().includes(normalizedQuery) ||
      member.displayName.toLowerCase().includes(normalizedQuery);
  });
}

export function replaceActiveMention(value, handle) {
  const source = String(value || "");
  const match = source.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return source + (source.endsWith(" ") || !source ? "" : " ") + "@" + handle + " ";
  }
  const prefix = source.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return prefix + leadingSpace + "@" + handle + " ";
}

export function mentionShortcutEdit(value, selectionStart, selectionEnd) {
  const source = String(value || "");
  const rawStart = Number.isFinite(selectionStart) ? selectionStart : source.length;
  const rawEnd = Number.isFinite(selectionEnd) ? selectionEnd : rawStart;
  const start = Math.max(0, Math.min(source.length, Math.min(rawStart, rawEnd)));
  const end = Math.max(start, Math.min(source.length, Math.max(rawStart, rawEnd)));
  const before = source.slice(0, start);
  const trigger = before && !/\s$/.test(before) ? " @" : "@";
  return {
    value: before + trigger + source.slice(end),
    caret: before.length + trigger.length
  };
}

export function replaceMentionAtCaret(value, handle, caret) {
  const source = String(value || "");
  const position = Number.isFinite(caret)
    ? Math.max(0, Math.min(source.length, caret))
    : source.length;
  const replacedBefore = replaceActiveMention(source.slice(0, position), handle);
  const after = source.slice(position);
  const suffix = replacedBefore.endsWith(" ") && after.startsWith(" ")
    ? after.slice(1)
    : after;
  return {
    value: replacedBefore + suffix,
    caret: replacedBefore.length
  };
}

export function selectedConversationMembers() {
  return conversationMembers(selectedConversationId());
}

export function conversationMembers(conversationId) {
  const chat = loadChats().find(function (item) {
    return item.id === conversationId;
  });
  return chat ? chatMembers(chat) : [];
}

export function chatMembers(chat) {
  if (Array.isArray(chat.members) && chat.members.length > 0) {
    return chat.members;
  }
  return (chat.participants || []).map(function (handle) {
    return normalizeMobileMember({ handle });
  }).filter(Boolean);
}
