import { wireHomeDock } from "../activity/activityItem.js";
import { recordRelayDebug } from "../base/bytes.js";
import { ACTIVE_CONVERSATION_KEY, PAIRED_RELOAD_KEY } from "../base/storageKeys.js";
import {
  isNearBottom, keepingReaderAtLatest, openThreadRootId, placeJumpToLatest, scrollToLatest, scrollToLatestWhenSettled,
  setJumpToLatestVisible, setOpenThreadRootId, threadSurface
} from "../chat/chatScroll.js";
import { loadEarlierMessages } from "../chat/loadEarlier.js";
import { startThinkingClock } from "../chat/messageRows.js";
import { render } from "../chat/render.js";
import { wireStreamView } from "../chat/streamView.js";
import { wireChatActionsSheet } from "../chats/chatListView.js";
import { wireChatSearch } from "../chats/chatSearch.js";
import { adoptWorkerUnread } from "../chats/chatStore.js";
import { endFocusPlacement, openChatState, selectedConversationId } from "../chats/openChat.js";
import { composerStopIds, composerStopState, syncComposerStop } from "../composer/composerStop.js";
import {
  addPendingAttachments, pendingAttachments, pickedImagesState, renderPendingAttachments, takePendingAttachments
} from "../composer/pickedImages.js";
import { activeSlashQuery, replaceSlashAtCaret, requestComposerOptionsViaRelay, skillTokenPresent } from "../composer/slashCommands.js";
import { wireImageViewer } from "../media/attachments.js";
import { avatarForMember, paintAvatar } from "../members/avatars.js";
import { activeChatRecord, wireMembersSheet } from "../members/membersSheet.js";
import { mentionOptions, mentionShortcutEdit, replaceMentionAtCaret, selectedConversationMembers } from "../members/mentions.js";
import { openNewChat, retryNewChatOffer } from "../newChat/newChatOffer.js";
import { wireNewChat } from "../newChat/newChatScreen.js";
import { pruneSentHubEntries, retireSignedChains } from "../outbox/hubOutbox.js";
import { listOutboxEntries } from "../outbox/outboxStore.js";
import { canSync, enqueueMessage } from "../outbox/sending.js";
import { listSendFailures, wireSendLog } from "../outbox/sendLog.js";
import { canStartChats, HUB_PHONE_PROTOCOL, hubClient, isHubPairing, serverPairing } from "../pairing/hubPairing.js";
import { clearOldPairing, loadPairing, readBootstrapFromLocation } from "../pairing/pairing.js";
import { ensurePushSubscription } from "../push/messageAlerts.js";
import { wireChatViewSwitch } from "../sessions/chatTitleMenu.js";
import { stopMembersFromPhone } from "../sessions/sessionsRows.js";
import {
  chatViewOf, openMemberSessionMember, sessionsMainSessionIdOf, sessionsStateState, setOpenMemberSessionId
} from "../sessions/sessionsState.js";
import { refreshHubMachines } from "../settings/machineWake.js";
import {
  afterTapLands, applyDock, applyDockAfterTap, applyDockKeepingReader, composerHasFocus, leaveOpenChat, setActivityTab,
  setHomeTab, updateComposerShape
} from "./home.js";
import { dropStoredInternalSystemRows } from "../store/timelineRows.js";
import { startSyncProgressClock } from "../sync/connectionStatus.js";
import { wireForegroundResync, wireWorkerMessages } from "../sync/foreground.js";
import { retryOutboxNow } from "../sync/outboxRetry.js";
import { attachPullToRefresh, refreshChatList, refreshOpenTimeline } from "../sync/pullToRefresh.js";
import { requestChatListViaRelay, requestTimelineViaRelay } from "../sync/serverChanges.js";
import { handOverBeforeDrawing, markHubNoticesSeen, startHubProgressPolling } from "../sync/serverReads.js";

// A notification tapped while the app was closed opens it with the chat
// named in the URL. The parameter is consumed once and removed, so a reload
// does not keep re-opening that chat.
function adoptOpenConversationFromLocation() {
  try {
    const url = new URL(globalThis.location.href);
    const open = url.searchParams.get("open");
    if (!open || !open.trim()) {
      return false;
    }
    setOpenThreadRootId(undefined);
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, open.trim());
    url.searchParams.delete("open");
    history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
    return true;
  } catch {
    return false;
  }
}

/** Whether this launch is the reload a pairing with another server made;
 *  the mark is used once. */
function takePairedReload() {
  try {
    const marked = sessionStorage.getItem(PAIRED_RELOAD_KEY) === "1";
    sessionStorage.removeItem(PAIRED_RELOAD_KEY);
    return marked;
  } catch {
    return false;
  }
}

export async function init() {
  // Before anything is drawn: a pairing made the old way is cleared, so the
  // first screen already says why this phone has to pair again.
  await clearOldPairing().catch(function () { return false; });
  // Read (and used up) whatever the launch is: a mark left behind must not
  // make a later launch count as a pairing's.
  const pairedReload = takePairedReload();
  if (pairedReload) setHomeTab("chats");
  const openedToPair = readBootstrapFromLocation(globalThis.location) || pairedReload;
  const openedToChat = adoptOpenConversationFromLocation();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(function () {
      return undefined;
    });
  }
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  const jump = document.getElementById("jump-to-latest");
  if (jump) {
    jump.addEventListener("click", function () {
      endFocusPlacement();
      scrollToLatest("smooth");
    });
  }
  const surface = threadSurface();
  if (surface) {
    surface.addEventListener("scroll", function () {
      setJumpToLatestVisible(!isNearBottom(surface));
    }, { passive: true });
    // The chat's bottom edge also moves with no scroll at all: a card
    // arriving or growing, the keyboard, the bar coming and going.
    if (jump && typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        if (jump.classList.contains("is-visible")) placeJumpToLatest(jump);
      }).observe(surface);
    }
  }
  wireChatSearch();
  wireHomeDock();
  wireMembersSheet();
  wireChatViewSwitch();
  wireChatActionsSheet();
  wireSendLog();
  wireNewChat();
  wireImageViewer();
  wireWorkerMessages();
  // Opened from a notification while the app was not running: the worker
  // cannot postMessage to a page that does not exist yet, so it says it in
  // the URL instead.
  const opening = new URLSearchParams(location.search);
  const openedToActivity = opening.get("tab") === "activity";
  if (openedToActivity) {
    leaveOpenChat();
    setHomeTab("activity");
    const list = opening.get("list");
    if (list === "pending" || list === "finished") {
      setActivityTab(list);
    }
    history.replaceState(undefined, "", location.pathname);
  }
  // A fresh start opens on New chat (the User, 2026-11-01, after Claude's
  // app), not on the chat or tab open last; its menu button opens the
  // chats. A launch that says where to go (a tapped notification, a pairing
  // code) goes there instead, and coming back to the app while it is still
  // running is not a start: it keeps its place.
  if (!openedToPair && !openedToChat && !openedToActivity && canStartChats(loadPairing())) {
    leaveOpenChat();
    setHomeTab("chats");
    void openNewChat();
  }
  wireForegroundResync();
  document.getElementById("load-earlier")?.addEventListener("click", function () {
    void loadEarlierMessages();
  });
  attachPullToRefresh(document.getElementById("chat-list"), document.getElementById("chat-list-refresh"), refreshChatList);
  attachPullToRefresh(surface, document.getElementById("timeline-refresh"), refreshOpenTimeline);
  const backToTimeline = document.getElementById("back-to-timeline");
  if (backToTimeline) {
    backToTimeline.addEventListener("click", function () {
      setOpenThreadRootId(undefined);
      setOpenMemberSessionId(undefined);
      sessionsStateState.openAccordLaunchId = undefined;
      sessionsStateState.pendingSessionsTarget = undefined;
      // Back is back, also before the screen left was drawn: the message it
      // was to land on (a member's reply its chip leads to) no longer opens
      // that member's session again once the rows are read.
      openChatState.pendingMessageFocus = undefined;
      void render();
    });
  }
  const back = document.getElementById("back-to-chats");
  if (back) {
    back.addEventListener("click", function () {
      leaveOpenChat();
      void render();
    });
  }
  if (form && input) {
    // The bar under the composer leaves while the keyboard is up and comes
    // back when it goes. Either way the chat grows or shrinks by the bar's
    // height, so a reader who was at the latest message stays there.
    input.addEventListener("focus", applyDockKeepingReader);
    input.addEventListener("blur", applyDockAfterTap);
    let mentionIndex = 0;
    const mentionMenu = document.getElementById("mention-menu");
    const mentionButton = document.getElementById("mention-button");

    function mentionValueBeforeCaret() {
      const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
      return input.value.slice(0, caret);
    }

    function closeMentionMenu() {
      if (mentionMenu) {
        mentionMenu.hidden = true;
        mentionMenu.textContent = "";
      }
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function insertMention(member) {
      const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
      const edit = replaceMentionAtCaret(input.value, member.mentionHandle, caret);
      input.value = edit.value;
      mentionIndex = 0;
      closeMentionMenu();
      input.focus();
      input.setSelectionRange(edit.caret, edit.caret);
    }

    function renderMentionMenu() {
      if (!mentionMenu) {
        return [];
      }
      // The sessions view offers no members to mention (handles go away there).
      const activeChat = activeChatRecord();
      const options = activeChat && chatViewOf(activeChat) === "sessions" ? []
        : mentionOptions(mentionValueBeforeCaret(), selectedConversationMembers());
      mentionMenu.textContent = "";
      if (options.length === 0) {
        closeMentionMenu();
        return [];
      }
      mentionIndex = Math.min(mentionIndex, options.length - 1);
      const title = document.createElement("div");
      title.className = "mobile-mention-title";
      title.textContent = "Members";
      mentionMenu.append(title);
      options.forEach(function (member, index) {
        const option = document.createElement("button");
        option.type = "button";
        option.id = "mention-option-" + index;
        option.className = "mobile-mention-option" + (index === mentionIndex ? " is-selected" : "");
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", index === mentionIndex ? "true" : "false");
        option.addEventListener("pointerdown", function (event) {
          event.preventDefault();
        });
        option.addEventListener("click", function () {
          insertMention(member);
        });
        const avatar = document.createElement("span");
        avatar.className = "mobile-mention-avatar";
        paintAvatar(avatar, avatarForMember(member), selectedConversationId());
        const copy = document.createElement("span");
        copy.className = "mobile-mention-copy";
        const name = document.createElement("strong");
        name.textContent = member.displayName;
        const role = document.createElement("span");
        role.textContent = member.roleLabel;
        copy.append(name, role);
        option.append(avatar, copy);
        mentionMenu.append(option);
      });
      mentionMenu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-activedescendant", "mention-option-" + mentionIndex);
      mentionMenu.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
      return options;
    }

    // The "/" menu. The list is the desktop's — it knows the member the
    // draft addresses, the saved prompts and the skills that member can run —
    // so each keystroke after "/" asks it, debounced, and a stale answer is
    // dropped. Picking a skill is remembered so the message carries it the
    // way the desktop composer does, as long as its token is still in the
    // text when the message goes.
    const slashMenu = document.getElementById("slash-menu");
    let slashIndex = 0;
    let slashOptions = [];
    let slashRequestSeq = 0;
    let slashDebounceTimer;
    let slashRequestKey = "";
    let selectedSkillMentions = [];

    function slashMenuOpen() {
      return Boolean(slashMenu) && !slashMenu.hidden && slashOptions.length > 0;
    }

    function closeSlashMenu() {
      clearTimeout(slashDebounceTimer);
      slashRequestSeq += 1;
      slashRequestKey = "";
      slashOptions = [];
      if (slashMenu) {
        slashMenu.hidden = true;
        slashMenu.textContent = "";
      }
      if (!mentionMenu || mentionMenu.hidden) {
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
      }
    }

    function slashOptionLabel(option) {
      if (option.kind === "command") {
        return { title: option.item.label || "/" + option.item.id, detail: option.item.description || "" };
      }
      if (option.kind === "prompt") {
        return { title: "/" + option.item.trigger, detail: option.item.label || "" };
      }
      return { title: "/" + option.item.frontmatterName, detail: option.item.description || option.item.displayName || "" };
    }

    function renderSlashMenu(state) {
      if (!slashMenu) {
        return;
      }
      slashMenu.textContent = "";
      if (slashOptions.length === 0 && state === "ready") {
        closeSlashMenu();
        return;
      }
      slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
      if (slashOptions.length === 0) {
        const note = document.createElement("div");
        note.className = "mobile-mention-title";
        note.dataset.slashState = state;
        note.textContent = state === "offline" ? "Commands need the desktop" : "Asking the desktop…";
        slashMenu.append(note);
      }
      const groups = [
        { kind: "command", title: "Commands" },
        { kind: "prompt", title: "Saved prompts" },
        { kind: "skill", title: "Skills" }
      ];
      let position = 0;
      for (const group of groups) {
        const members = slashOptions.filter(function (option) { return option.kind === group.kind; });
        if (members.length === 0) {
          continue;
        }
        const title = document.createElement("div");
        title.className = "mobile-mention-title";
        title.textContent = group.title;
        slashMenu.append(title);
        for (const option of members) {
          const index = slashOptions.indexOf(option);
          const button = document.createElement("button");
          button.type = "button";
          button.id = "slash-option-" + index;
          button.className = "mobile-mention-option mobile-slash-option" + (index === slashIndex ? " is-selected" : "");
          button.dataset.slashKind = option.kind;
          button.setAttribute("role", "option");
          button.setAttribute("aria-selected", index === slashIndex ? "true" : "false");
          button.addEventListener("pointerdown", function (event) {
            event.preventDefault();
          });
          button.addEventListener("click", function () {
            insertSlashOption(option);
          });
          const copy = document.createElement("span");
          copy.className = "mobile-mention-copy";
          const label = slashOptionLabel(option);
          const name = document.createElement("strong");
          name.textContent = label.title;
          const detail = document.createElement("span");
          detail.textContent = label.detail;
          copy.append(name, detail);
          button.append(copy);
          slashMenu.append(button);
          position += 1;
        }
      }
      slashMenu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (position > 0) {
        input.setAttribute("aria-activedescendant", "slash-option-" + slashIndex);
        slashMenu.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
      }
    }

    function insertSlashOption(option) {
      const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
      let insertion;
      if (option.kind === "command") {
        insertion = "/" + option.item.id + " ";
      } else if (option.kind === "prompt") {
        insertion = String(option.item.body || "").trim();
      } else {
        insertion = "/" + option.item.frontmatterName + " ";
        if (!selectedSkillMentions.some(function (mention) { return mention.skillId === option.item.skillId; })) {
          selectedSkillMentions.push(option.item);
        }
      }
      const edit = replaceSlashAtCaret(input.value, insertion, caret);
      input.value = edit.value;
      slashIndex = 0;
      closeSlashMenu();
      input.focus();
      input.setSelectionRange(edit.caret, edit.caret);
    }

    function updateSlashMenu() {
      const before = mentionValueBeforeCaret();
      const query = activeSlashQuery(before);
      if (query === undefined) {
        clearTimeout(slashDebounceTimer);
        slashRequestKey = "";
        if (slashMenu && !slashMenu.hidden) {
          closeSlashMenu();
        }
        return;
      }
      // A caret moving inside the same draft is not a new question.
      const requestKey = selectedConversationId() + "\0" + before;
      if (requestKey === slashRequestKey) {
        return;
      }
      slashRequestKey = requestKey;
      clearTimeout(slashDebounceTimer);
      const pairing = loadPairing();
      const conversationId = selectedConversationId();
      if (!pairing || !canSync(pairing) || !conversationId) {
        slashOptions = [];
        renderSlashMenu("offline");
        return;
      }
      renderSlashMenu("loading");
      const seq = ++slashRequestSeq;
      const content = input.value;
      slashDebounceTimer = setTimeout(function () {
        requestComposerOptionsViaRelay(pairing, conversationId, query, content).then(function (result) {
          if (seq !== slashRequestSeq || activeSlashQuery(mentionValueBeforeCaret()) !== query) {
            return;
          }
          slashOptions = [].concat(
            result.commands.map(function (item) { return { kind: "command", item }; }),
            result.prompts.map(function (item) { return { kind: "prompt", item }; }),
            result.skills.filter(function (item) {
              return item && item.capabilityState === "invocable" && !item.ambiguous;
            }).map(function (item) { return { kind: "skill", item }; })
          );
          renderSlashMenu("ready");
        }).catch(function () {
          if (seq === slashRequestSeq) {
            slashOptions = [];
            renderSlashMenu("offline");
          }
        });
      }, 120);
    }

    // The skills a message carries are the ones still named in it: deleting
    // the "/name" token drops the skill, as it does on the desktop.
    function takeSkillMentions(content) {
      const carried = selectedSkillMentions.filter(function (mention) {
        return skillTokenPresent(content, mention.frontmatterName);
      });
      selectedSkillMentions = [];
      return carried;
    }

    input.addEventListener("input", function () {
      mentionIndex = 0;
      renderMentionMenu();
      slashIndex = 0;
      updateSlashMenu();
    });
    document.addEventListener("selectionchange", function () {
      if (document.activeElement === input && mentionMenu && !mentionMenu.hidden) {
        renderMentionMenu();
      }
      if (document.activeElement === input && slashMenu && !slashMenu.hidden) {
        updateSlashMenu();
      }
    });
    // Every control in the composer row needs this, not just the mention one.
    // A tap on a button moves focus off the textarea, iOS puts the keyboard
    // away, and the click only lands afterwards — so the first tap looks like
    // it just closed the keyboard and did nothing.
    function keepFieldFocusedOnTap(element) {
      if (!element) {
        return;
      }
      element.addEventListener("pointerdown", function (event) {
        if (document.activeElement === input) {
          event.preventDefault();
        }
      });
    }

    if (mentionButton) {
      keepFieldFocusedOnTap(mentionButton);
      mentionButton.addEventListener("click", function () {
        const edit = mentionShortcutEdit(input.value, input.selectionStart, input.selectionEnd);
        input.value = edit.value;
        input.focus();
        input.setSelectionRange(edit.caret, edit.caret);
        mentionIndex = 0;
        renderMentionMenu();
      });
    }
    const attachButton = document.getElementById("attach-button");
    const imageInput = document.getElementById("composer-image-input");
    keepFieldFocusedOnTap(attachButton);
    keepFieldFocusedOnTap(document.getElementById("send-button"));
    if (attachButton && imageInput) {
      attachButton.addEventListener("click", function () {
        imageInput.click();
      });
      imageInput.addEventListener("change", async function () {
        pickedImagesState.attachmentsPreparing += 1;
        syncComposerStop(composerStopState);
        let rejected = [];
        try {
          rejected = await addPendingAttachments(imageInput.files);
        } finally {
          pickedImagesState.attachmentsPreparing -= 1;
        }
        // Clearing lets the same file be picked again after removing it.
        imageInput.value = "";
        renderPendingAttachments();
        if (rejected.length > 0) {
          const state = document.getElementById("connection-state");
          if (state) {
            state.textContent = "Not attached: " + rejected.join("; ");
          }
        }
      });
    }
    input.addEventListener("keydown", function (event) {
      if (slashMenuOpen()) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          slashIndex = (slashIndex + 1) % slashOptions.length;
          renderSlashMenu("ready");
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          slashIndex = (slashIndex - 1 + slashOptions.length) % slashOptions.length;
          renderSlashMenu("ready");
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          insertSlashOption(slashOptions[slashIndex] || slashOptions[0]);
          return;
        }
      }
      if (event.key === "Escape" && slashMenu && !slashMenu.hidden) {
        closeSlashMenu();
        return;
      }
      const options = mentionOptions(mentionValueBeforeCaret(), selectedConversationMembers());
      if (options.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        mentionIndex = (mentionIndex + 1) % options.length;
        renderMentionMenu();
        return;
      }
      if (options.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        mentionIndex = (mentionIndex - 1 + options.length) % options.length;
        renderMentionMenu();
        return;
      }
      if (options.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        insertMention(options[mentionIndex] || options[0]);
        return;
      }
      if (event.key === "Escape") {
        closeMentionMenu();
      }
    });
    input.addEventListener("blur", function () {
      setTimeout(closeMentionMenu, 0);
      setTimeout(closeSlashMenu, 0);
    });
    // One tap, one send. The form's submit event is not enough on the phone:
    // the send button keeps the field focused so the keyboard does not shove
    // the layout mid-tap, and a tap that changes nothing on screen can be
    // dropped before it becomes a click -- which is how a tap came to only
    // put the keyboard away, leaving the message sitting there (the User,
    // 2026-09-21). The button therefore sends on pointerup as well, and
    // submitComposer makes the two paths one send: it empties the field and
    // takes the pictures before its first wait, so the second path finds
    // nothing. A flag held across the whole send did that too, and more: it
    // also dropped the next message typed while the first was still going
    // out over a slow connection, with nothing on screen to say so.
    const sendComposer = function () {
      endFocusPlacement();
      return submitComposer();
    };
    input.addEventListener("focus", updateComposerShape);
    input.addEventListener("blur", function () {
      afterTapLands(updateComposerShape);
    });
    input.addEventListener("input", updateComposerShape);
    input.addEventListener("input", function () { syncComposerStop(composerStopState); });
    updateComposerShape();
    const sendButton = document.getElementById("send-button");
    if (sendButton) {
      sendButton.addEventListener("pointerup", function (event) {
        event.preventDefault();
        // Nothing written while the session runs: Stop, not Send.
        if (sendButton.dataset.mode === "stop" && composerStopState) {
          void stopMembersFromPhone(composerStopIds.slice());
          return;
        }
        if (sendButton.dataset.mode === "stopping") return;
        void sendComposer();
      });
    }
    // Stop beside Send: the run stops, what is written stays to be sent.
    const sideStop = document.getElementById("composer-stop-button");
    if (sideStop) {
      keepFieldFocusedOnTap(sideStop);
      sideStop.addEventListener("click", function (event) {
        event.preventDefault();
        if (sideStop.disabled || !composerStopState || composerStopIds.length === 0) return;
        sideStop.disabled = true;
        void stopMembersFromPhone(composerStopIds.slice());
      });
    }
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      void sendComposer();
    });
    async function submitComposer() {
      const content = input.value.trim();
      const conversationId = selectedConversationId();
      // A picture on its own is a message.
      if ((!content && pendingAttachments.length === 0) || !conversationId) {
        return;
      }
      input.value = "";
      // The message is gone, so the keyboard has nothing left to do: it goes
      // down and gives the screen back, instead of sitting over the reply
      // the User just asked for. The composer goes back to one line with it
      // once the tap on Send has landed.
      input.blur();
      afterTapLands(updateComposerShape);
      closeSlashMenu();
      const attachments = takePendingAttachments();
      const skillMentions = takeSkillMentions(content);
      // A reply written with a thread open belongs to that thread. Without
      // this the desktop had nothing to place it by and put it in the main
      // timeline, where the User -- still looking at the thread -- could not
      // see her own message at all (the User, 2026-09-21).
      const threadRootId = openThreadRootId();
      // Written in a member's session: to that member only, no fallback
      // (the desktop's targetParticipantIds).
      const activeChat = activeChatRecord();
      const sessionMember = openMemberSessionMember(activeChat);
      // The sessions view's main composer writes to the main session, whatever
      // @ text it holds: members are reached in their own sessions there.
      const sessionsMain = !sessionMember && !threadRootId ? sessionsMainSessionIdOf(activeChat) : undefined;
      const targetParticipantIds = sessionMember ? [sessionMember.id] : sessionsMain ? [sessionsMain] : undefined;
      const carriesExtras = attachments.length > 0 || skillMentions.length > 0 || Boolean(threadRootId) || Boolean(targetParticipantIds);
      await enqueueMessage({
        content,
        conversationId,
        ...(threadRootId ? { threadRootId } : {}),
        ...(carriesExtras
          ? {
            payload: {
              content,
              ...(threadRootId ? { threadRootId } : {}),
              ...(targetParticipantIds ? { targetParticipantIds } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(skillMentions.length > 0 ? { skillMentions } : {})
            }
          }
          : {})
      });
      // The message goes out at once: drawing it is not what it waits on.
      const flushing = retryOutboxNow();
      await handOverBeforeDrawing(flushing);
      await render();
      // Sending is a deliberate action, so following it is expected.
      scrollToLatestWhenSettled("auto");
      const flushResult = await flushing;
      await render(flushResult.status);
    }
  }
  // Cached rows are visible before synchronization finishes. Their controls
  // and elapsed time must work throughout those network waits.
  wireStreamView();
  startThinkingClock();
  startSyncProgressClock();
  // Internal system rows stored before the desktop stopped sending them
  // would otherwise sit in the timeline forever: nothing ever asks the phone
  // to drop a row it once received.
  await dropStoredInternalSystemRows().catch(function () { return 0; });
  // What the queue holds, so a card can say whether its answer went out and
  // the periodic retry knows there is something to offer.
  await listOutboxEntries().catch(function () { return []; });
  // What the send log holds, for the header's way to it and Settings.
  await listSendFailures();
  await render();
  // What a push-woken worker counted while the app was closed, folded in
  // before the lists paint again; the icon number follows.
  await adoptWorkerUnread().catch(function () { return undefined; });
  // The phone talks to the User's server and to nothing else: no desktop
  // and no machine is addressed from here.
  const pairing = loadPairing();
  if (isHubPairing(pairing)) {
    await initHubSession(pairing);
  }
}

/** A phone paired with the User's server: what it owes goes out, the chats
 *  are read from the server, and it is rung by the server. */
export async function initHubSession(pairing) {
  const client = hubClient();
  if (client) {
    void client.health().then(function (health) {
      if (!(Number(health && health.protocol) >= HUB_PHONE_PROTOCOL)) {
        serverPairing.hubPairingState = { status: "outdated", message: "Update AccordAgents on your computer: its server runs an older program than this app." };
        return render();
      }
      return undefined;
    }).catch(function () { return undefined; });
  }
  // A queue written the old way becomes operations before anything goes.
  await retireSignedChains().catch(function (error) {
    recordRelayDebug({ event: "queue-retire-failed", message: String(error && error.message || error) });
  });
  const flushResult = await retryOutboxNow().catch(function () { return { status: "unreachable" }; });
  try {
    await requestChatListViaRelay(pairing);
    await render("synced");
    // The server answered: New chat, if it is still up without its offer
    // because the first read found no connection, reads it now.
    retryNewChatOffer();
    const conversationId = selectedConversationId();
    if (conversationId) {
      await requestTimelineViaRelay(pairing, conversationId);
      await render("synced");
    }
  } catch (error) {
    await render(error && error.unavailable ? "unreachable" : flushResult.status);
  }
  void ensurePushSubscription().catch(function () { return undefined; });
  startHubProgressPolling();
  void refreshHubMachines();
  void markHubNoticesSeen();
  void pruneSentHubEntries().catch(function () { return undefined; });
}

// iOS reports a height at first paint that is taller than what you can
// actually see, so the composer starts half off the bottom of the screen —
// and the page is deliberately unscrollable now, so nothing brings it back
// until the keyboard opens and closes and forces a re-measure. Measure the
// usable height ourselves instead of letting CSS inherit that first value.
// Tracking visualViewport also means the composer rides above the keyboard
// rather than sitting behind it.
export function trackUsableHeight() {
  const viewport = typeof window !== "undefined" ? window.visualViewport : null;
  let lastHeight = 0;
  let lastWidth = 0;
  function apply() {
    const width = window.innerWidth;
    // Never measure while the composer is focused: on iOS the keyboard is
    // covering part of the screen and every frame of its animation reports a
    // different height, so resizing on each one made the whole screen jump
    // the moment the input was tapped. A width change is a rotation, which
    // the keyboard cannot cause, so that one is honoured either way.
    if (composerHasFocus() && width === lastWidth) {
      return;
    }
    const height = viewport ? viewport.height : window.innerHeight;
    if (height <= 0 || (height === lastHeight && width === lastWidth)) {
      return;
    }
    lastHeight = height;
    lastWidth = width;
    // A reader sitting at the latest message stays there across a rotation.
    keepingReaderAtLatest(function () {
      document.documentElement.style.setProperty("--app-h", height + "px");
    });
  }
  // A single sample can land mid-animation — the keyboard sliding away, a
  // rotation still turning — and then stick, because nothing would come
  // along to correct it. Sample across the whole animation instead.
  function remeasure() {
    apply();
    applyDock();
    [150, 350, 600, 900].forEach(function (delay) {
      setTimeout(apply, delay);
    });
  }
  remeasure();
  // The height iOS reports at first paint is too tall; the real one only
  // exists after the first frame.
  requestAnimationFrame(apply);
  window.addEventListener("resize", remeasure);
  window.addEventListener("orientationchange", remeasure);
  // Coming back from the background is the other moment the height can be
  // stale with no resize to announce it.
  window.addEventListener("pageshow", remeasure);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      remeasure();
    }
  });
  // Not in the middle of the tap that moved the focus: the height taken
  // with the keyboard still up and the bar coming back would both move the
  // button under the finger before its release.
  document.addEventListener("focusout", function () {
    afterTapLands(remeasure);
  });
}
