export const PROBE_TIMEOUT_MS = 40_000;
export const SHORT_TIMEOUT_MS = 60_000;
export const TRANSFER_TIMEOUT_MS = 20 * 60_000;
export const DEPENDENCIES_TIMEOUT_MS = 15 * 60_000;
export const DRAIN_TIMEOUT_MS = 5 * 60_000;
export const CONNECT_TIMEOUT_MS = 3 * 60_000;

/** Importing every chat on the User's data (hundreds of chats, tens of MB)
 *  is a one-time write of a few minutes at most. */
export const MINIMUM_NODE_MAJOR = 20;
