// The rules the phone must apply exactly as the desktop does, bundled for the
// static PWA shell by scripts/build-mobile-shell.mjs (global
// `AccordMobileShared`). The phone runs no TypeScript of its own; before this
// bundle it re-implemented these rules by hand and drifted — avatars guessed
// from the handle, internal system messages shown as chat bubbles.
export {
  CHAT_ASSISTANT_AVATAR_ASSET_ID,
  chatAvatarAssetFileName,
  chatAvatarCatalogEntry,
  resolveChatAvatarByName,
  resolveChatParticipantAvatar
} from "./chatAvatarCatalog";
// The per-message half of the desktop's timeline rule. The other half — an
// inferred member-request carrier is hidden only while its trigger is in the
// conversation — needs the message list, which a machine's delta does not
// carry; the desktop applies the whole rule before it projects for the phone.
export { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
// What a member's message shows and what is control text: the `User choice:`
// block becomes a card, so the bubble must not print it as well. One rule for
// the desktop bubble and the phone's.
export { stripChatControlBlocks } from "./chatControlBlocks";
// Who a message is for, by the rules the desktop resolves a typed message
// with: the phone resolves its own message the same way, over what it showed
// the User, and the message carries the result to every member's home.
export { CHAT_DELIVERY_POLICY_OPTIONS, resolveChatDeliveryTargets } from "./chatDeliveryPolicy";
// `/goal` from the phone: the same parse and objective the desktop's composer
// makes, carried on the message.
export { nativeGoalObjective, parseNativeGoalCommand } from "./nativeGoalCommand";
// A new chat from the phone, made as the computer's New chat makes it: its
// members from what the computer prepared, its first system line and its
// title (the User, 2026-10-29).
export { newChatIntro, newChatParticipants, newChatTitle } from "./newChat";
