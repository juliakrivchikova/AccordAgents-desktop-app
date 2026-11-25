import { URGENT_ALERT_SERVER_WRITER } from "../../shared/urgentAlerts";

/** Bookkeeping the server keeps on every message it holds: the message's
 *  place in the server's order, and the device that wrote it (the only one
 *  that may change it). Whatever a device sends for these is replaced. */
export const SERVER_MESSAGE_KEYS = ["serverSeq", "serverWriter"] as const;

/** The writer of the messages the server writes itself (an urgent alert's
 *  card, shared/urgentAlerts.ts): no device has this id, so every device
 *  takes such a message from the feed as another's, and none may change it. */
export const HUB_SERVER_WRITER = URGENT_ALERT_SERVER_WRITER;

/** Where the server keeps the User's rules for members (HubMemberRules). */
export const HUB_MEMBER_RULES_DOCUMENT = "member-rules";

/** Chats kept in memory between operations, by their messages: a chat of
 *  hundreds of messages is not read again for every change. */
export const CACHE_MESSAGE_LIMIT = 6_000;
