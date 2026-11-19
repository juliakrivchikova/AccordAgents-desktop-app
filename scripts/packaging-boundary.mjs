import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

/** Written by the packaging step (forge.config.ts): whether the build was
 *  made from its own release tag. The app reads it from the same place
 *  (src/main/services/teamDevice.ts). */
export const BUILD_INFO_ENTRY = "dist/main/build-info.json";
// What a release is numbered; the app counts any other version as one of
// the team's builds (OFFICIAL_VERSION_PATTERN in teamDevice.ts).
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

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

function readArchiveJson(asarPath, entry) {
  try {
    // The archive is searched with the system's separator.
    return JSON.parse(extractFile(asarPath, entry.split("/").join(path.sep)).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function readBuildInfo(asarPath) {
  return readArchiveJson(asarPath, BUILD_INFO_ENTRY);
}

/** Whether the checkout's HEAD is the commit the tag `v<version>` names.
 *  Throws when git cannot tell. */
export function headHasReleaseTag(rootDir, version) {
  const git = (args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = git(["rev-parse", "HEAD"]);
  try {
    return git(["rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`]) === head;
  } catch {
    return false;
  }
}

// The app counts a build that is not stamped as made from its release tag, or
// whose version is not a release number, as one of the team's, and leaves it
// out of the numbers about real people. A release that lost its stamp would
// leave out every installation of it.
export function verifyReleaseBuildInfo(asarPath, tagName) {
  if (!existsSync(asarPath)) {
    throw new Error(`The app built for ${tagName} was not found at ${asarPath}.`);
  }
  const version = readArchiveJson(asarPath, "package.json")?.version;
  if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`The app built for ${tagName} has version ${version}, which the app does not count as a release; every installation of it would report as a team device.`);
  }
  if (readBuildInfo(asarPath)?.fromReleaseTag !== true) {
    throw new Error(`The app built for ${tagName} is not stamped as built from its release tag (${BUILD_INFO_ENTRY}); every installation of it would report as a team device.`);
  }
}
