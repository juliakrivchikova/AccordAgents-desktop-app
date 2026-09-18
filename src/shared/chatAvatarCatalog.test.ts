import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_AVATAR_CATALOG,
  defaultChatAvatarId,
  mapChatAvatarIdToKind,
  normalizedChatAvatarId,
  resolveChatAvatarByName,
  resolveChatParticipantAvatar
} from "./chatAvatarCatalog";

test("every catalog entry names a provider, a picture and a media mode", () => {
  const ids = new Set<string>();
  for (const entry of CHAT_AVATAR_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate avatar id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(["codex-cli", "claude-code", "gemini-cli"].includes(entry.kind), entry.id);
    assert.match(entry.assetFile, /\.(png|svg)$/, entry.id);
    assert.ok(entry.mediaMode === "glyph" || entry.mediaMode === "photo", entry.id);
    if (entry.mediaMode === "glyph") {
      assert.ok(entry.glyphKind, `${entry.id}: a glyph needs a disc kind`);
    }
  }
});

test("a member without a chosen avatar gets the same hashed default everywhere", () => {
  // The seed is the member id (or handle), so the phone, given the same
  // record, lands on the same picture as the desktop.
  const first = defaultChatAvatarId("claude-code", "participant-1");
  assert.equal(defaultChatAvatarId("claude-code", "participant-1"), first);
  assert.equal(defaultChatAvatarId("claude-code", "PARTICIPANT-1 "), first, "seed is case- and space-insensitive");
  assert.notEqual(defaultChatAvatarId("claude-code", "claude-logo"), "claude-logo", "logos are never a hashed default");
  assert.equal(defaultChatAvatarId("gemini-cli", "anything"), "gemini-logo");
  const resolved = resolveChatParticipantAvatar({ id: "participant-1", handle: "claude", kind: "claude-code" }, "@claude");
  assert.equal(resolved.assetId, first);
  assert.equal(resolved.mediaMode, "photo");
});

test("a chosen avatar resolves to its own picture, a logo to a glyph on its brand disc", () => {
  const logo = resolveChatParticipantAvatar({ id: "p", handle: "claude", kind: "claude-code", avatarId: "claude-logo" }, "@claude");
  assert.deepEqual(logo, { glyphKind: "anthropic", label: "@claude", mediaMode: "glyph", assetId: "claude-logo" });
  const cat = resolveChatParticipantAvatar({ id: "p", handle: "drew", kind: "codex-cli", avatarId: "codex-cat" }, "@drew");
  assert.deepEqual(cat, { glyphKind: "custom", label: "@drew", mediaMode: "photo", assetId: "codex-cat" });
  // An avatar of another provider is mapped to this provider's default, as the
  // desktop does when a provider changes under a member.
  const crossed = resolveChatParticipantAvatar({ id: "p", handle: "drew", kind: "codex-cli", avatarId: "claude-cat" }, "@drew");
  assert.equal(crossed.assetId, normalizedChatAvatarId("codex-cli", "claude-cat", "p"));
  assert.equal(mapChatAvatarIdToKind("codex-cli", "claude-cat"), "codex-cat");
});

test("a drawn avatar is named by id with initials to stand in, and the assistant shows the app mark", () => {
  const drawn = resolveChatParticipantAvatar({ id: "p", handle: "gera", kind: "codex-cli", avatarId: "custom:abc-123" }, "@gera");
  assert.deepEqual(drawn, { glyphKind: "custom", label: "@gera", mediaMode: "photo", customAvatarId: "abc-123", initials: "G" });
  const assistant = resolveChatParticipantAvatar({ id: "p", handle: "admin", kind: "codex-cli" }, "Chat Assistant", { isAssistant: true });
  assert.deepEqual(assistant, { glyphKind: "custom", label: "Chat Assistant", mediaMode: "glyph", assetId: "accordagents-mark" });
});

test("an author with no member record gets the provider glyph its name suggests, else initials", () => {
  assert.equal(resolveChatAvatarByName("@claude-reviewer").assetId, "claude-logo");
  assert.equal(resolveChatAvatarByName("@drew-codex-engineer").assetId, "codex-logo");
  assert.equal(resolveChatAvatarByName("@gemini-bot").assetId, "gemini-logo");
  assert.deepEqual(resolveChatAvatarByName("@taylor"), { glyphKind: "generic", label: "@taylor", mediaMode: "glyph", initials: "T" });
});
