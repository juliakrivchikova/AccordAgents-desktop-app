// The rules the phone must apply exactly as the desktop does, bundled for the
// static PWA shell by scripts/build-mobile-shell.mjs (global
// `AccordMobileShared`). The phone runs no TypeScript of its own; before this
// bundle it re-implemented these rules by hand and drifted — avatars guessed
// from the handle, internal system messages shown as chat bubbles.
export {
  CHAT_ASSISTANT_AVATAR_ASSET_ID,
  CHAT_AVATAR_CATALOG,
  chatAvatarCatalogEntry,
  chatAvatarInitials,
  resolveChatAvatarByName,
  resolveChatParticipantAvatar
} from "./chatAvatarCatalog";
export { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
