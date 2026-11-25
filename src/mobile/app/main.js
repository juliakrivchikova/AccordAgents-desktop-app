import { CHAT_LIST_KEY } from "./base/storageKeys.js";
import { isCardLocked, isCardSent } from "./cards/cardAnswers.js";
import { loadEarlierMessages } from "./chat/loadEarlier.js";
import { formatClockTime, isCancellableMobileRow, messageStatusLabel, reconcileMessageRows, updateMessageRow } from "./chat/messageRows.js";
import { startUrgentAlertClock, tickUrgentAlertCountdowns } from "./chat/urgentAlerts.js";
import { chatMatchesQuery, filterChatsByQuery } from "./chats/chatGroups.js";
import {
  adoptWorkerUnread, forgetCachedChatList, loadUnreadConversationIds, markConversationRead, markConversationsUnread
} from "./chats/chatStore.js";
import { addPendingAttachments, preparePickedImage, takePendingAttachments } from "./composer/pickedImages.js";
import {
  activeSlashQuery, replaceActiveSlashQuery, replaceSlashAtCaret, requestComposerOptionsViaRelay, skillTokenPresent
} from "./composer/slashCommands.js";
import { closeImageViewer, openImageViewer, timelineAttachmentsFromEvent } from "./media/attachments.js";
import { closeMembersSheet, openMembersSheet } from "./members/membersSheet.js";
import {
  activeMentionQuery, mentionOptions, mentionShortcutEdit, replaceActiveMention, replaceMentionAtCaret
} from "./members/mentions.js";
import { flushOutboxToServer, resolvePhoneDelivery } from "./outbox/hubOutbox.js";
import { listOutboxEntries } from "./outbox/outboxStore.js";
import { createOutboxEvent, enqueueMessage, enqueueTurnStop, serverOwesEntry, stopRunFromPhone } from "./outbox/sending.js";
import { closeSendLog, listSendFailures, openSendLog } from "./outbox/sendLog.js";
import { forgetHubIdentity, HUB_PAIRING_KEY, loadHubPairing, pairWithServer, serverPairing } from "./pairing/hubPairing.js";
import { loadPairing, readBootstrapFromLocation } from "./pairing/pairing.js";
import { enableMessageAlerts, ensurePushSubscription, reconnectMessageAlerts } from "./push/messageAlerts.js";
import { init, trackUsableHeight } from "./shell/launch.js";
import { saveTimelinePage, timelinePageFor } from "./store/timelinePages.js";
import { dedupeTimelineEntries, listTimelineEntries, timelineEntryDedupeKey, timelineRenderRowKey } from "./store/timelineRows.js";
import { handleRelayChatListPayload, reconcilePendingControlCards } from "./sync/chatListPayload.js";
import { connectionStatusText } from "./sync/connectionStatus.js";
import { openActivityFromNotification, resyncAfterForeground } from "./sync/foreground.js";
import { flushOutbox, retryOutboxNow, retryPendingOutbox } from "./sync/outboxRetry.js";
import { refreshChatList, refreshOpenTimeline } from "./sync/pullToRefresh.js";
import { requestChatListViaRelay, requestTimelineViaRelay } from "./sync/serverChanges.js";
import { whileLookingForMessages } from "./sync/syncBanner.js";
import { handleRelayTimelinePayload } from "./sync/timelinePayload.js";
import { renderMessageContent } from "./text/messageText.js";

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", function (event) {
    if (!event || event.key === null || event.key === CHAT_LIST_KEY) {
      forgetCachedChatList();
    }
    // Another tab paired this phone again: its key is read afresh.
    if (!event || event.key === null || event.key === HUB_PAIRING_KEY) {
      forgetHubIdentity();
      serverPairing.hubClientCache = undefined;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && document.querySelector("[data-urgent-alert-countdown]")) {
      tickUrgentAlertCountdowns();
      startUrgentAlertClock();
    }
  });
}

globalThis.AccordAgentsMobile = {
  // W-K's harness drives the real user path — permission prompt, subscribe,
  // POST, render — rather than a stand-in for it.
  enableMessageAlerts,
  ensurePushSubscription,
  whileLookingForMessages,
  reconnectMessageAlerts,
  createOutboxEvent,
  enqueueMessage,
  enqueueTurnStop,
  stopRunFromPhone,
  flushOutbox,
  retryOutboxNow,
  listSendFailures,
  openSendLog,
  closeSendLog,
  handleRelayChatListPayload,
  handleRelayTimelinePayload,
  reconcilePendingControlCards,
  retryPendingOutbox,
  isCardSent,
  isCardLocked,
  serverOwesEntry,
  activeMentionQuery,
  mentionOptions,
  replaceActiveMention,
  mentionShortcutEdit,
  replaceMentionAtCaret,
  isCancellableMobileRow,
  requestChatListViaRelay,
  requestTimelineViaRelay,
  readBootstrapFromLocation,
  pairWithServer,
  flushOutboxToServer,
  resolvePhoneDelivery,
  loadHubPairing,
  listOutboxEntries,
  listTimelineEntries,
  dedupeTimelineEntries,
  reconcileMessageRows,
  timelineEntryDedupeKey,
  timelineRenderRowKey,
  updateMessageRow,
  loadPairing,
  connectionStatusText,
  renderMessageContent,
  timelineAttachmentsFromEvent,
  addPendingAttachments,
  takePendingAttachments,
  preparePickedImage,
  chatMatchesQuery,
  filterChatsByQuery,
  formatClockTime,
  messageStatusLabel,
  activeSlashQuery,
  replaceActiveSlashQuery,
  replaceSlashAtCaret,
  skillTokenPresent,
  requestComposerOptionsViaRelay,
  loadUnreadConversationIds,
  markConversationsUnread,
  markConversationRead,
  adoptWorkerUnread,
  resyncAfterForeground,
  loadEarlierMessages,
  timelinePageFor,
  saveTimelinePage,
  refreshChatList,
  refreshOpenTimeline,
  openImageViewer,
  closeImageViewer,
  openMembersSheet,
  closeMembersSheet,
  openActivityFromNotification
};

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () {
    trackUsableHeight();
    init().catch(function (error) {
      const state = document.getElementById("connection-state");
      if (state) {
        state.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  });
}
