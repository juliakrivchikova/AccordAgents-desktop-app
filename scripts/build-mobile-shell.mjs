import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const source = path.join(repoRoot, "src/mobile");
const target = path.join(repoRoot, "dist/mobile");
const assetTarget = path.join(target, "assets");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
// One crypto implementation for native devices and the offline PWA.
await build({ entryPoints: [path.join(repoRoot, "src/shared/machineChannelKey.ts")],
  outfile: path.join(target, "mobile-machine-sealing.js"), bundle: true,
  format: "iife", globalName: "AccordMachineSealing", platform: "browser", target: "es2022" });
await mkdir(assetTarget, { recursive: true });
await cp(
  path.join(repoRoot, "src/renderer/assets/accordagents-mark.png"),
  path.join(assetTarget, "accordagents-mark.png")
);
// QR decoder for in-app pairing. Copied rather than bundled because the mobile
// shell ships as plain static files with no build step.
await cp(
  path.join(repoRoot, "node_modules/jsqr/dist/jsQR.js"),
  path.join(target, "jsqr.js")
);
