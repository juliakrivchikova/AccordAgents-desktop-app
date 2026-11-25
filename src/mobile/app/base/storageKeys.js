export const META_STORE = "meta";
export const OUTBOX_STORE = "outbox";
export const TIMELINE_STORE = "timeline";

// Set when an old pairing was cleared and no server pairing replaced it yet,
// so the notice that says why stays until the phone pairs again.
export const OLD_PAIRING_CLEARED_KEY = "accordagents.mobile.oldPairingCleared.v1";

export const ACTIVE_CONVERSATION_KEY = "accordagents.mobile.activeConversationId.v1";
export const OPEN_THREAD_KEY = "accordagents.mobile.openThreadRootId.v1";

// W-M: which run's reply is being watched. Session-scoped like the open
// thread: a phone that reopens on its chat (one paired for that chat only;
// the others start on New chat) lands in the chat, not in a stream for a
// run that finished while you were away.
export const OPEN_STREAM_KEY = "accordagents.mobile.openStreamRunId.v1";

// Set just before the reload that follows a pairing with another server,
// read once by the launch it starts (takePairedReload).
export const PAIRED_RELOAD_KEY = "accordagents.mobile.pairedReload.v1";

export const SYNC_WAIT_KEY = "accordagents.mobile.syncWaitStartedAt.v1";
export const CHAT_LIST_KEY = "accordagents.mobile.chatList.v1";
export const TERMINAL_RUNS_KEY = "accordagents.mobile.terminalRuns.v1";

// Cards a member is waiting on, per chat, as the desktop last stated them.
// Kept so closing the app does not lose a question that is still open.
export const CONTROL_CARDS_KEY = "accordagents.mobile.controlCards.v1";

// Cards answered from this phone whose answer the desktop has not yet
// stated as applied, with the queue entry that carries the answer. Kept
// across launches: a mark that lived only in memory made a reloaded app
// show the card as never answered (the User, 2026-09-20).
export const CONTROL_CARD_SENT_KEY = "accordagents.mobile.controlCardSent.v1";

// Chats with activity this phone has not looked at yet. The dot in the list
// and the number on the app icon both read from here; the service worker
// adds to its IndexedDB mirror when a push lands while the app is closed.
export const UNREAD_KEY = "accordagents.mobile.unreadConversationIds.v1";

// Chats she started on this phone (New chat, a fork) while her server lists
// nothing in them she did not make: their moving in the list is no news.
export const OWN_CHATS_KEY = "accordagents.mobile.ownChats.v1";

export const UNREAD_META_KEY = "unreadConversations";
export const CHAT_TITLES_META_KEY = "chatTitles";

// Where the history of each chat stops on this phone: whether the desktop
// has messages before the oldest one shown, and which message to ask before.
export const TIMELINE_PAGES_KEY = "accordagents.mobile.timelinePages.v1";

// When each chat was last looked at on this phone. Activity reads a finished
// update as seen when the chat was opened after it arrived.
export const VIEWED_AT_KEY = "accordagents.mobile.viewedAt.v1";

// When the desktop's chat list last reached this phone, on its own clock.
// Activity drops an "in progress" row that reached the phone well before a
// list saying nothing runs in that chat: a run the phone never saw end.
export const CHAT_LIST_AT_KEY = "accordagents.mobile.chatListAt.v1";

// When each member message the chat list carries for Activity first reached
// this phone in its current state, on this phone's clock: what Activity
// judges "new since you looked" by for a chat whose pages it never read.
export const LIST_ACTIVITY_SEEN_KEY = "accordagents.mobile.listActivitySeen.v1";

// The status of every queue entry this phone has seen, by event id, so a
// card can say whether the answer it sent was handed over without a read.
export const outboxStatusById = new Map();
