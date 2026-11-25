import { canSync } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { hubPhoneGet } from "../sync/serverReads.js";

// Which picture a member shows is decided by the same code the desktop
// runs (bundled as mobile-shared.js from src/shared/chatAvatarCatalog.ts):
// the member's `avatarId` and provider, never a guess from the handle. A
// member the phone has no record for gets what the desktop gives an unknown
// author — the provider glyph its name suggests, or initials.
const CHAT_ASSISTANT_DISPLAY_NAME = "Chat Assistant";

export function mobileSharedRules() {
  return globalThis.AccordMobileShared;
}

function avatarAssetUrl(assetId) {
  const shared = mobileSharedRules();
  if (!shared || !assetId) {
    return undefined;
  }
  if (assetId === shared.CHAT_ASSISTANT_AVATAR_ASSET_ID) {
    return "assets/accordagents-mark.png";
  }
  const entry = shared.chatAvatarCatalogEntry(assetId);
  return entry ? "assets/avatars/" + shared.chatAvatarAssetFileName(entry) : undefined;
}

function normalizeMemberHandle(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function memberForLabel(members, label) {
  const wanted = normalizeMemberHandle(label);
  if (!wanted) {
    return undefined;
  }
  return (members || []).find(function (member) {
    return normalizeMemberHandle(member.handle) === wanted ||
      normalizeMemberHandle(member.mentionHandle) === wanted ||
      normalizeMemberHandle(member.displayName) === wanted;
  });
}

// Without the shared bundle (an old cached shell) the phone can still name
// the member: initials on a plain disc, the same stand-in the desktop uses
// while a picture is missing.
function initialsAvatar(label) {
  const text = String(label || "").trim() || "Agent";
  return { glyphKind: "generic", label: text, mediaMode: "glyph", initials: text.replace(/^@/, "").charAt(0).toUpperCase() || "?" };
}

// Which picture a member shows depends only on what is read here, and
// every row asks again on every redraw; worked out once per member state.
const memberAvatarCache = new Map();

export function avatarForMember(member) {
  const shared = mobileSharedRules();
  const label = member.displayName || "@" + member.handle;
  if (!shared) {
    return initialsAvatar(label);
  }
  const key = [member.id, member.handle, member.kind, member.avatarId, label, member.isAssistant === true].map(function (part) {
    return part === undefined ? "" : String(part);
  }).join("\u0000");
  const known = memberAvatarCache.get(key);
  if (known) return { ...known };
  if (memberAvatarCache.size > 500) memberAvatarCache.clear();
  const resolved = resolveMemberAvatar(shared, member, label);
  memberAvatarCache.set(key, resolved);
  return { ...resolved };
}

function resolveMemberAvatar(shared, member, label) {
  // A member the list only knows by handle (an older chat list) has no
  // provider to pick a default from; its name is all there is to go on.
  if (member.kind !== "claude-code" && member.kind !== "codex-cli" && member.kind !== "gemini-cli") {
    return shared.resolveChatAvatarByName(label);
  }
  return shared.resolveChatParticipantAvatar(
    { id: member.id, handle: member.handle, kind: member.kind, avatarId: member.avatarId },
    label,
    // The desktop says which member is the assistant; a list from an older
    // desktop is recognised by the name it gave.
    { isAssistant: member.isAssistant === true || label === CHAT_ASSISTANT_DISPLAY_NAME }
  );
}

export function avatarForLabel(members, label) {
  const member = memberForLabel(members, label);
  if (member) {
    return avatarForMember(member);
  }
  const shared = mobileSharedRules();
  const text = String(label || "").trim() || "Agent";
  return shared ? shared.resolveChatAvatarByName(text) : initialsAvatar(text);
}

/** What the frame will show, for change detection: repainting on every
 *  render would restart the image load. */
export function avatarSignature(resolved) {
  return [resolved.glyphKind, resolved.mediaMode, resolved.assetId || "", resolved.customAvatarId || "", resolved.initials || ""].join("\0");
}

export function clearAvatarKindClasses(avatar) {
  for (const className of [...avatar.classList]) {
    if (className.startsWith("avatar-") && className !== "avatar-icon") {
      avatar.classList.remove(className);
    }
  }
}

// One frame contract, the desktop's: the element is the disc, sized by its
// own class; the picture inside is either a glyph (75%, contained) or a
// photo (100%, covering). Nothing per member or per surface beyond that.
export function paintAvatar(avatar, resolved, conversationId) {
  const signature = avatarSignature(resolved);
  if (avatar.dataset.avatarSignature === signature) {
    // A drawn avatar still waiting for its bytes is asked for again on a
    // repaint (once the retry pause has passed): a missed answer must not
    // leave initials on a row that is patched in place for the session.
    if (resolved.customAvatarId && avatar.dataset.avatarLoaded !== "1") {
      loadCustomAvatarInto(avatar, conversationId, resolved.customAvatarId, signature);
    }
    return;
  }
  avatar.dataset.avatarSignature = signature;
  delete avatar.dataset.avatarLoaded;
  delete avatar.dataset.avatarCustomId;
  avatar.textContent = "";
  avatar.removeAttribute("style");
  clearAvatarKindClasses(avatar);
  avatar.classList.add("avatar-icon", "avatar-" + resolved.glyphKind);
  avatar.setAttribute("aria-label", resolved.label || "");
  if (resolved.customAvatarId) {
    // Initials stand in until the bytes arrive; a drawn avatar that cannot be
    // fetched (no desktop reachable) stays initials, as on the desktop
    // before its bytes load.
    const initials = document.createElement("span");
    initials.className = "avatar-media avatar-media-glyph";
    initials.textContent = resolved.initials || "?";
    avatar.classList.remove("avatar-custom");
    avatar.classList.add("avatar-generic");
    avatar.append(initials);
    loadCustomAvatarInto(avatar, conversationId, resolved.customAvatarId, signature);
    return;
  }
  const assetUrl = avatarAssetUrl(resolved.assetId);
  if (assetUrl) {
    avatar.append(avatarImage(assetUrl, resolved.mediaMode));
    avatar.dataset.avatarLoaded = "1";
    return;
  }
  const initials = document.createElement("span");
  initials.className = "avatar-media avatar-media-glyph";
  initials.textContent = resolved.initials || "?";
  avatar.append(initials);
  avatar.dataset.avatarLoaded = "1";
}

function avatarImage(src, mediaMode) {
  const img = document.createElement("img");
  img.className = "avatar-media avatar-media-" + mediaMode;
  img.src = src;
  img.alt = "";
  img.decoding = "async";
  // Eighty message rows and a week of Activity rows are built at once;
  // only the discs on screen need their picture now.
  img.loading = "lazy";
  return img;
}

// Drawn avatars live as files on the desktop; the member record names the
// id and the bytes come once per session, like a picture in a message.
// Bounded like the picture cache: a drawn avatar can be megabytes.
const customAvatarDataUrls = new Map();

const customAvatarFetches = new Map();
const customAvatarRetryAfter = new Map();
const CUSTOM_AVATAR_CACHE_MAX_ENTRIES = 24;

// A server that cannot be reached answers nothing for the request's whole
// wait; asking again on every repaint would keep a request in flight for
// the session.
const CUSTOM_AVATAR_RETRY_PAUSE_MS = 60 * 1000;

function rememberCustomAvatar(avatarId, result) {
  if (customAvatarDataUrls.size >= CUSTOM_AVATAR_CACHE_MAX_ENTRIES) {
    const oldest = customAvatarDataUrls.keys().next();
    if (!oldest.done) {
      customAvatarDataUrls.delete(oldest.value);
    }
  }
  customAvatarDataUrls.set(avatarId, result);
}

function loadCustomAvatarInto(avatar, conversationId, customId, signature) {
  const avatarId = "custom:" + customId;
  const cached = customAvatarDataUrls.get(avatarId);
  if (cached) {
    applyCustomAvatar(avatar, cached, signature);
    return;
  }
  avatar.dataset.avatarCustomId = customId;
  if (!customAvatarFetches.has(avatarId)) {
    if ((customAvatarRetryAfter.get(avatarId) || 0) > Date.now()) {
      return;
    }
    const pairing = loadPairing();
    customAvatarFetches.set(avatarId, (async function () {
      if (!pairing || !canSync(pairing) || !conversationId) {
        return "retry";
      }
      const payload = await hubPhoneGet("/v1/phone/avatar", { conversationId: conversationId, avatarId: avatarId });
      if (payload && payload.type === "mobile.avatar" && typeof payload.dataBase64 === "string") {
        return "data:" + (typeof payload.mimeType === "string" ? payload.mimeType : "image/png") + ";base64," + payload.dataBase64;
      }
      // "unavailable" and "too-large" are answers: initials stay, and the
      // id is not asked for again this session.
      return payload && typeof payload.reason === "string" ? "unavailable" : "retry";
    })().catch(function () {
      return "retry";
    }).then(function (result) {
      if (result !== "retry") {
        rememberCustomAvatar(avatarId, result);
      }
      if (result !== "retry" && !result.startsWith("data:")) {
        // Answered "no" — not asked again while the answer is remembered.
        customAvatarRetryAfter.set(avatarId, Date.now() + CUSTOM_AVATAR_RETRY_PAUSE_MS);
      } else if (result === "retry") {
        customAvatarRetryAfter.set(avatarId, Date.now() + CUSTOM_AVATAR_RETRY_PAUSE_MS);
      }
      customAvatarFetches.delete(avatarId);
      // Every disc on screen that shows this member gets the picture: a row
      // painted while the server was unreachable is patched in place and
      // would otherwise keep its initials for the session.
      for (const node of document.querySelectorAll('[data-avatar-custom-id="' + CSS.escape(customId) + '"]')) {
        applyCustomAvatar(node, result, node.dataset.avatarSignature);
      }
      return result;
    }));
  }
  customAvatarFetches.get(avatarId).then(function (result) {
    if (avatar.isConnected && avatar.dataset.avatarSignature === signature) {
      applyCustomAvatar(avatar, result, signature);
    }
  });
}

function applyCustomAvatar(avatar, result, signature) {
  if (typeof result !== "string" || !result.startsWith("data:")) {
    return;
  }
  if (avatar.dataset.avatarSignature !== signature || avatar.dataset.avatarLoaded === "1") {
    return;
  }
  avatar.textContent = "";
  avatar.classList.remove("avatar-generic");
  avatar.classList.add("avatar-custom");
  avatar.append(avatarImage(result, "photo"));
  avatar.dataset.avatarLoaded = "1";
}
