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
