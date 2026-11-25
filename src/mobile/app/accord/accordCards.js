import { sessionsMemberByHandle } from "./accordDock.js";
import { lineIcon } from "../activity/activityData.js";
import { sessionsViewTextFor } from "../cards/cardText.js";
import { messageStatusLabel } from "../chat/messageRows.js";
import { selectedConversationId } from "../chats/openChat.js";
import { avatarForLabel, avatarSignature, mobileSharedRules, paintAvatar } from "../members/avatars.js";
import { conversationMembers } from "../members/mentions.js";
import { sessionsStateState } from "../sessions/sessionsState.js";
import { providerLogoElement } from "../sessions/sessionsStatus.js";
import { SVG_NS } from "../shell/home.js";

/** A message that starts an Accord — the User's own, or one the chat's
 *  main session wrote (app_chat_start_accord) — read by the desktop's own
 *  rule (accordLaunchCard.ts); anything else stays a bubble. */
export function accordLaunchCardForEntry(entry) {
  if (!entry || entry.scaffolding) return undefined;
  if (entry.author !== "you" && !(entry.author === "agent" && entry.accordLaunchByMainSession)) return undefined;
  const shared = mobileSharedRules();
  if (shared && typeof shared.accordLaunchCardForMessage === "function") {
    return shared.accordLaunchCardForMessage({
      role: entry.author === "you" ? "user" : "participant",
      content: entry.content,
      metadata: {
        ...(Array.isArray(entry.attachments) && entry.attachments.length > 0 ? { imageAttachments: entry.attachments } : {}),
        ...(entry.accordLaunchByMainSession ? { accordLaunchByMainSession: true } : {})
      }
    });
  }
  // Pictures are never on a launch the app wrote, and the card would hide them.
  if (entry.author !== "you" || (Array.isArray(entry.attachments) && entry.attachments.length > 0)) return undefined;
  return shared && typeof shared.parseAccordLaunchCard === "function"
    ? shared.parseAccordLaunchCard(entry.content)
    : undefined;
}

// The desktop's Start Accord glyph: a merge whose three branches keep their
// own colors (styles/accord.css), so the icon ignores currentColor.
const ACCORD_ICON_PATHS = [
  ["m8 6 4-4 4 4", "top"],
  ["M12 2v10.3", "top"],
  ["M12 12.3a4 4 0 0 1-1.172 2.872L4 22", "left"],
  ["m20 22-5-5", "right"]
];

export function accordIcon(size) {
  const svg = lineIcon([], size);
  svg.setAttribute("stroke-width", "2.4");
  for (const [d, branch] of ACCORD_ICON_PATHS) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "accord-icon-" + branch);
    svg.append(path);
  }
  return svg;
}

/** What the card's member avatars show, so the row is redrawn when the
 *  member list arrives after it or a member's picture changes. */
export function accordLaunchAvatarSignature(entry, card) {
  const members = conversationMembers(entry.conversationId || selectedConversationId());
  return [card.facilitator].concat(card.members).map(function (handle) {
    return avatarSignature(avatarForLabel(members, "@" + handle));
  }).join("|");
}

function accordMemberElement(entry, handle) {
  const wrap = document.createElement("span");
  wrap.className = "accord-launch-member";
  const name = document.createElement("span");
  name.className = "accord-launch-handle";
  name.textContent = "@" + handle;
  // The sessions view names a member by its logo and task, no avatar or
  // handle; the main session by its logo alone, as on the desktop.
  if (entry.presentation === "sessions") {
    const member = sessionsMemberByHandle(handle);
    const main = sessionsStateState.sessionsMentionScope && String(handle).toLowerCase() === sessionsStateState.sessionsMentionScope.mainHandle;
    const mainKind = main && sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.mainMember ? sessionsStateState.lastSessionsState.mainMember.kind : "";
    name.textContent = member ? member.title : main ? "" : handle;
    wrap.append(providerLogoElement(member ? member.kind : mainKind || "", "is-chip"));
    if (name.textContent) wrap.append(name);
    return wrap;
  }
  const avatar = document.createElement("span");
  avatar.className = "message-avatar accord-launch-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const conversationId = entry.conversationId || selectedConversationId();
  paintAvatar(avatar, avatarForLabel(conversationMembers(conversationId), "@" + handle), conversationId);
  wrap.append(avatar, name);
  return wrap;
}

/** The Accord launch as the desktop shows it: the artifact note's card
 *  with the Start Accord icon, the subject as its title, and who leads it
 *  and who is in it. The row keeps the message's own status (its time, or
 *  why the server refused it) and its replies' chip. */
export function accordLaunchCardElement(entry, card) {
  const shared = mobileSharedRules();
  const parts = shared.accordLaunchTitleAndBody(card.subject);
  const wrap = document.createElement("div");
  wrap.className = "artifact-note-card accord-launch-card";
  const icon = document.createElement("span");
  icon.className = "artifact-note-icon accord-launch-icon";
  icon.append(accordIcon(22));
  const text = document.createElement("div");
  text.className = "artifact-note-text";
  const title = document.createElement("div");
  title.className = "artifact-note-title";
  title.textContent = parts.title;
  const meta = document.createElement("div");
  meta.className = "artifact-note-meta accord-launch-meta";
  const kind = document.createElement("span");
  kind.className = "accord-launch-kind";
  kind.textContent = "Accord";
  const led = document.createElement("span");
  led.append(document.createTextNode("led by "), accordMemberElement(entry, card.facilitator));
  const withMembers = document.createElement("span");
  withMembers.className = "accord-launch-with";
  withMembers.append(document.createTextNode("with "));
  card.members.forEach(function (handle, index) {
    if (index > 0) withMembers.append(document.createTextNode(", "));
    withMembers.append(accordMemberElement(entry, handle));
  });
  const status = document.createElement("span");
  status.className = "message-status";
  status.textContent = messageStatusLabel(entry);
  meta.append(kind, led, withMembers, status);
  text.append(title, meta);
  if (parts.body) {
    const body = document.createElement("div");
    body.className = "artifact-note-body accord-launch-body";
    body.textContent = parts.body;
    text.append(body);
  }
  wrap.append(icon, text);
  return wrap;
}

export function accordStageElement(entry, stage) {
  const item = document.createElement("li");
  item.className = "accord-progress-stage is-" + stage.state;
  const mark = document.createElement("span");
  mark.className = "accord-progress-mark is-" + stage.state;
  mark.setAttribute("aria-hidden", "true");
  if (stage.state === "done") mark.append(lineIcon(["M20 6 9 17l-5-5"], 12));
  const text = document.createElement("div");
  text.className = "accord-progress-stage-text";
  const name = document.createElement("span");
  name.className = "accord-progress-label";
  name.textContent = stage.label;
  text.append(name);
  const detail = sessionsViewTextFor(entry && entry.conversationId, stage.detail);
  if (detail) {
    const line = document.createElement("span");
    line.className = "accord-progress-detail";
    line.textContent = detail;
    text.append(line);
  }
  if (stage.members.length > 0) {
    const list = document.createElement("span");
    list.className = "accord-progress-members";
    for (const member of stage.members) list.append(accordProgressMemberElement(entry, member));
    text.append(list);
  }
  item.append(mark, text);
  return item;
}

function accordProgressMemberElement(entry, member) {
  const chip = accordMemberElement(entry, member.handle);
  chip.classList.add("accord-progress-member");
  if (member.given) chip.classList.add("is-given");
  else if (member.waiting) chip.classList.add("is-waiting");
  if (member.given) {
    const check = lineIcon(["M20 6 9 17l-5-5"], 12);
    check.classList.add("accord-progress-member-check");
    chip.append(check);
  }
  return chip;
}
