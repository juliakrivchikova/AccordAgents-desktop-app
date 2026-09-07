import { statSync } from "node:fs";
import { listPackage } from "@electron/asar";

export function verifyRuntimeArchive(asarPath) {
  const files = listPackage(asarPath, {});
  const unexpected = files.filter((file) => !/^\/(?:package\.json$|(?:dist|node_modules)(?:\/|$))/.test(file));
  if (unexpected.length > 0) {
    throw new Error(`App archive contains non-runtime files: ${unexpected.slice(0, 10).join(", ")}`);
  }
  for (const required of ["/package.json", "/dist/main/main/launcher.js", "/dist/main/preload/index.js", "/dist/renderer/index.html"]) {
    if (!files.includes(required)) {
      throw new Error(`App archive is missing ${required}`);
    }
  }
}

export function verifyUpdaterZip(zipPath) {
  // Squirrel buffers the response in CFData; crossing 1 GiB grows it to 2 GiB
  // and crashes the installed Electron allocator before it can finish updating.
  if (statSync(zipPath).size >= 1024 ** 3) {
    throw new Error("Updater ZIP must be smaller than 1 GiB; refusing an update that can crash installed apps.");
  }
}
