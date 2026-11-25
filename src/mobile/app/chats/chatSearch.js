import { chatGroupsState } from "./chatGroups.js";
import { renderChatList } from "./chatListView.js";

/** The chat search closed and emptied; the list is redrawn by the caller. */
export function closeChatSearch() {
  const box = document.getElementById("chat-search");
  const input = document.getElementById("chat-search-input");
  if (box) box.hidden = true;
  document.getElementById("chat-search-toggle")?.setAttribute("aria-expanded", "false");
  const phone = document.querySelector(".mobile-phone");
  if (phone) phone.dataset.searching = "0";
  if (input) input.value = "";
  chatGroupsState.chatSearchQuery = "";
}

export function wireChatSearch() {
  const toggle = document.getElementById("chat-search-toggle");
  const box = document.getElementById("chat-search");
  const input = document.getElementById("chat-search-input");
  const close = document.getElementById("chat-search-close");
  if (!toggle || !box || !input) {
    return;
  }
  function setOpen(open) {
    if (!open) {
      closeChatSearch();
      renderChatList();
      return;
    }
    box.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    // The bar steps aside while searching: with the keyboard up it would sit
    // on top of the results.
    const phone = document.querySelector(".mobile-phone");
    if (phone) phone.dataset.searching = "1";
    input.focus();
  }
  // The search button is in the Chats header (the User, 2026-11-01), so
  // the list it searches is already on screen.
  toggle.addEventListener("click", function () {
    setOpen(box.hidden);
  });
  close?.addEventListener("click", function () {
    setOpen(false);
  });
  input.addEventListener("input", function () {
    chatGroupsState.chatSearchQuery = input.value;
    renderChatList();
  });
  input.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      setOpen(false);
    }
    if (event.key === "Enter") {
      input.blur();
    }
  });
}
