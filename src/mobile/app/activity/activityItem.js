import { activityRowAvatar, activityRowWho, activityViewState } from "./activityView.js";
import { cardSentText, controlCardAnswering, controlCardErrors, isCardLocked } from "../cards/cardAnswers.js";
import { controlCardElement } from "../cards/controlCard.js";
import { formatClockTime } from "../chat/messageRows.js";
import { render } from "../chat/render.js";
import { loadChats } from "../chats/chatStore.js";
import { openConversation } from "../chats/openChat.js";
import { homeTab, showScreen, switchHomeTab } from "../shell/home.js";
import { requestToPromise } from "../store/database.js";
import { listTimelineEntries, withTimeline } from "../store/timelineRows.js";
import { displayedMessageText, renderMessageContent } from "../text/messageText.js";

let activityItemRenderToken = 0;

export function getTimelineEntry(entryId) {
  return withTimeline("readonly", function (store) {
    return requestToPromise(store.get(entryId));
  });
}

/** The message a choice belongs to: stored under the chat's id and its own,
 *  so it is read directly rather than by reading the whole store. */
async function findChoiceMessage(conversationId, sourceMessageId) {
  if (!sourceMessageId) return undefined;
  const direct = await getTimelineEntry(conversationId + ":" + sourceMessageId).catch(function () { return undefined; });
  if (direct) return direct;
  const entries = await listTimelineEntries(conversationId).catch(function () { return []; });
  const stored = entries.find(function (entry) {
    return entry.messageId === sourceMessageId || entry.sourceId === sourceMessageId;
  });
  if (stored) return stored;
  // A chat this phone never read: the server's list carries the message
  // that asks (up to the length Activity reads), so the question is shown
  // with it there too.
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  return chat && Array.isArray(chat.activity) ? chat.activity.find(function (row) {
    return row.messageId === sourceMessageId;
  }) : undefined;
}

/** A choice opened from Activity: the message it belongs to and the whole
 *  card, answered exactly as it is in the chat. */
export async function renderActivityItem(row) {
  const view = document.getElementById("activity-item");
  const body = document.getElementById("activity-item-body");
  if (!view || !body) return;
  if (!row) {
    activityItemRenderToken += 1;
    if (!view.hidden) {
      view.hidden = true;
      body.replaceChildren();
      delete body.dataset.signature;
    }
    return;
  }
  const card = row.card;
  const titleNode = document.getElementById("activity-item-title");
  const subNode = document.getElementById("activity-item-sub");
  if (titleNode) titleNode.textContent = row.chatTitle;
  if (subNode) subNode.textContent = "Waiting for you" + (activityRowWho(row) ? " · asked by " + activityRowWho(row) : "");
  view.hidden = false;
  view.dataset.conversationId = row.conversationId;
  const signature = JSON.stringify([card, isCardLocked(card.id), cardSentText(card.id), controlCardAnswering.has(card.id), controlCardErrors.get(card.id) || ""]);
  if (body.dataset.signature === signature) return;
  body.dataset.signature = signature;
  const token = ++activityItemRenderToken;
  const source = await findChoiceMessage(row.conversationId, card.sourceMessageId);
  // A later draw (the answer being sent, say) owns the view now.
  if (token !== activityItemRenderToken || activityViewState.openActivityCardId !== card.id) return;
  body.replaceChildren();
  if (source && source.content) {
    const message = document.createElement("div");
    message.className = "act-item-message";
    const head = document.createElement("div");
    head.className = "act-item-message-head";
    head.append(activityRowAvatar(row.conversationId, source.participantLabel || row.handle));
    const who = document.createElement("span");
    who.className = "message-handle";
    who.textContent = activityRowWho({ conversationId: row.conversationId, handle: source.participantLabel || row.handle }) || "";
    const when = document.createElement("span");
    when.className = "message-status";
    when.textContent = formatClockTime(source.createdAt);
    head.append(who, when);
    const content = document.createElement("div");
    content.className = "message-content markdown-text";
    renderMessageContent(content, displayedMessageText(source.content));
    message.append(head, content);
    body.append(message);
  }
  body.append(controlCardElement(card));
}

/** Leaves the opened choice at once, so its old content is not what shows
 *  when Activity comes back. */
export function closeActivityItem() {
  activityViewState.openActivityCardId = undefined;
  activityItemRenderToken += 1;
  const view = document.getElementById("activity-item");
  const body = document.getElementById("activity-item-body");
  if (view) view.hidden = true;
  if (body) {
    body.replaceChildren();
    delete body.dataset.signature;
  }
}

export function wireHomeDock() {
  for (const tab of document.querySelectorAll("[data-home-tab]")) {
    tab.addEventListener("click", function () {
      const name = tab.dataset.homeTab;
      if (name === homeTab() && name === "activity") {
        // Tapping the tab you are on goes back to the top of its list.
        const list = document.getElementById("activity-list");
        if (list) list.scrollTop = 0;
      }
      void switchHomeTab(name);
    });
  }
  const back = document.getElementById("activity-item-back");
  back?.addEventListener("click", function () {
    closeActivityItem();
    showScreen("activity");
    void render();
  });
  const open = document.getElementById("activity-item-open");
  open?.addEventListener("click", function () {
    const view = document.getElementById("activity-item");
    const conversationId = view && view.dataset.conversationId;
    closeActivityItem();
    if (conversationId) void openConversation(conversationId);
  });
}
