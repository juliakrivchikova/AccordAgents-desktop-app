import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const source = path.join(repoRoot, "src/mobile");
const target = path.join(repoRoot, "dist/mobile");
const assetTarget = path.join(target, "assets");
const rendererAssets = path.join(repoRoot, "src/renderer/assets");

await rm(target, { recursive: true, force: true });
// Everything but the app's own modules and styles, which go into one file each.
const appSource = path.join(source, "app");
const styleSource = path.join(source, "styles");
await cp(source, target, { recursive: true, filter: (from) => from !== appSource && from !== styleSource });
// The phone app itself: one file on the phone, one module per subject here.
await build({ entryPoints: [path.join(appSource, "main.js")],
  outfile: path.join(target, "mobile-app.js"), bundle: true,
  format: "iife", platform: "browser", target: "es2022", charset: "utf8" });
// Its styles, in the order they override each other.
const styles = [
  "base", "chats", "chat-header", "messages", "artifact-notes", "accord", "finished-notes", "message-text", "composer",
  "waiting", "pairing", "stream-view", "control-cards", "choice-cards", "chat-search", "refresh", "members-sheet",
  "new-chat", "new-chat-options", "send-log", "images", "folded-cards", "dock", "activity", "settings", "urgent-alerts",
  "sessions-view", "member-session", "provider-logos", "title-menu", "members-sheet-fork", "sessions-accord",
  "sessions-progress", "sessions-working", "cards-kept"
];
const styleTexts = await Promise.all(styles.map((name) => readFile(path.join(styleSource, `${name}.css`), "utf8")));
await writeFile(path.join(target, "mobile-app.css"), styleTexts.join("\n"));
// How the phone and its service worker talk to the User's server: signed
// requests, its own signed events, bodies by hash. The same bytes every other
// device signs, from the same module the tests check against the desktop's.
await build({ entryPoints: [path.join(repoRoot, "src/shared/hubDeviceClient.ts")],
  outfile: path.join(target, "mobile-hub-client.js"), bundle: true,
  format: "iife", globalName: "AccordHubClient", platform: "browser", target: "es2022" });
// The rules the phone must share with the desktop verbatim: which avatar a
// member shows, which messages are internal and stay off the timeline.
await build({ entryPoints: [path.join(repoRoot, "src/shared/mobileSharedRules.ts")],
  outfile: path.join(target, "mobile-shared.js"), bundle: true,
  format: "iife", globalName: "AccordMobileShared", platform: "browser", target: "es2022" });
await mkdir(assetTarget, { recursive: true });
await cp(
  path.join(rendererAssets, "accordagents-mark.png"),
  path.join(assetTarget, "accordagents-mark.png")
);
// The providers' logo tiles the sessions view marks members with (the
// desktop's ProviderIcon pictures; Codex's mark is drawn inline).
const providerTarget = path.join(assetTarget, "providers");
await mkdir(providerTarget, { recursive: true });
await cp(path.join(rendererAssets, "claude-avatar.png"), path.join(providerTarget, "claude.png"));
await cp(path.join(rendererAssets, "antigravity-logo.png"), path.join(providerTarget, "antigravity.png"));
// Every built-in avatar the desktop can show, copied under its catalog id so
// the phone resolves `assetId` -> file without a list of its own. The catalog
// is read from the same module the desktop ships, bundled as ESM in memory:
// nothing temporary is written into the directory that gets deployed.
const catalogBundle = await build({ entryPoints: [path.join(repoRoot, "src/shared/chatAvatarCatalog.ts")],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false });
const { CHAT_AVATAR_CATALOG, chatAvatarAssetFileName } = await import(
  "data:text/javascript;base64," + Buffer.from(catalogBundle.outputFiles[0].text, "utf8").toString("base64")
);
const avatarTarget = path.join(assetTarget, "avatars");
await mkdir(avatarTarget, { recursive: true });
for (const entry of CHAT_AVATAR_CATALOG) {
  await cp(path.join(rendererAssets, entry.assetFile), path.join(avatarTarget, chatAvatarAssetFileName(entry)));
}
// QR decoder for in-app pairing. Copied rather than bundled: it is a file of
// its own on the phone.
await cp(
  path.join(repoRoot, "node_modules/jsqr/dist/jsQR.js"),
  path.join(target, "jsqr.js")
);
