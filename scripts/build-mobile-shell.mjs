import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const source = path.join(repoRoot, "src/mobile");
const target = path.join(repoRoot, "dist/mobile");
const assetTarget = path.join(target, "assets");
const rendererAssets = path.join(repoRoot, "src/renderer/assets");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
// One crypto implementation for native devices and the offline PWA.
await build({ entryPoints: [path.join(repoRoot, "src/shared/machineChannelKey.ts")],
  outfile: path.join(target, "mobile-machine-sealing.js"), bundle: true,
  format: "iife", globalName: "AccordMachineSealing", platform: "browser", target: "es2022" });
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
// Every built-in avatar the desktop can show, copied under its catalog id so
// the phone resolves `assetId` -> file without a list of its own. The catalog
// is read from the same module the desktop ships, bundled once as ESM here.
const catalogModulePath = path.join(target, "mobile-avatar-catalog.tmp.mjs");
const catalogBundle = await build({ entryPoints: [path.join(repoRoot, "src/shared/chatAvatarCatalog.ts")],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false });
await writeFile(catalogModulePath, catalogBundle.outputFiles[0].text);
const { CHAT_AVATAR_CATALOG } = await import(pathToFileURL(catalogModulePath).href);
await rm(catalogModulePath, { force: true });
const avatarTarget = path.join(assetTarget, "avatars");
await mkdir(avatarTarget, { recursive: true });
for (const entry of CHAT_AVATAR_CATALOG) {
  await cp(path.join(rendererAssets, entry.assetFile), path.join(avatarTarget, `${entry.id}${path.extname(entry.assetFile)}`));
}
// QR decoder for in-app pairing. Copied rather than bundled because the mobile
// shell ships as plain static files with no build step.
await cp(
  path.join(repoRoot, "node_modules/jsqr/dist/jsQR.js"),
  path.join(target, "jsqr.js")
);
