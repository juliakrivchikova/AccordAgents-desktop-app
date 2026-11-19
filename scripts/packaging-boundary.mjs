import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { extractFile, listPackage } from "@electron/asar";

/** Written by the packaging step (forge.config.ts): whether the build was
 *  made from its own release tag. */
export const BUILD_INFO_ENTRY = "dist/main/build-info.json";

export function verifyRuntimeArchive(asarPath) {
  // On Windows the asar lists its entries with backslashes.
  const files = listPackage(asarPath, {}).map((file) => file.replaceAll("\\", "/"));
  const unexpected = files.filter((file) => !/^\/(?:package\.json$|(?:dist|node_modules)(?:\/|$))/.test(file));
  if (unexpected.length > 0) {
    throw new Error(`App archive contains non-runtime files: ${unexpected.slice(0, 10).join(", ")}`);
  }
  for (const required of ["/package.json", "/dist/main/main/launcher.js", "/dist/main/preload/index.js", "/dist/renderer/index.html"]) {
    if (!files.includes(required)) {
      throw new Error(`App archive is missing ${required}`);
    }
  }
  return files;
}

export function verifyUpdaterZip(zipPath) {
  // Squirrel buffers the response in CFData; crossing 1 GiB grows it to 2 GiB
  // and crashes the installed Electron allocator before it can finish updating.
  if (statSync(zipPath).size >= 1024 ** 3) {
    throw new Error("Updater ZIP must be smaller than 1 GiB; refusing an update that can crash installed apps.");
  }
}

export function readBuildInfo(asarPath) {
  try {
    return JSON.parse(extractFile(asarPath, BUILD_INFO_ENTRY).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Whether the checkout's HEAD carries the tag `v<version>`. */
export function headHasReleaseTag(rootDir, version) {
  const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: rootDir, encoding: "utf8" });
  return tags.split(/\r?\n/).includes(`v${version}`);
}

// The app counts a build that is not stamped as made from its release tag as
// one of the team's, and leaves it out of the numbers about real people. A
// release that lost its stamp would leave out every installation of it.
export function verifyReleaseBuildInfo(asarPath, tagName) {
  if (readBuildInfo(asarPath)?.fromReleaseTag !== true) {
    throw new Error(`The app built for ${tagName} is not stamped as built from its release tag (${BUILD_INFO_ENTRY}); every installation of it would report as a team device.`);
  }
}
