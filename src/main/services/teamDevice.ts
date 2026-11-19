import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Whether this installation is one of the team's own: a build that is not an
 * official release, or a computer marked by hand. What a team device reports
 * carries `team_device: true`, and its sessions go to their own environment,
 * so the numbers about real people can leave it out. Nothing else changes:
 * the same consent, the same records.
 *
 * Marking a computer, with no setting to show for it: an empty file named
 * `team-device` in the app's data folder, or `ACCORDAGENTS_TEAM_DEVICE=1`.
 */
export const TEAM_DEVICE_MARKER = "team-device";
export const TEAM_DEVICE_ENV = "ACCORDAGENTS_TEAM_DEVICE";
/** Written into the app by the packaging step (forge.config.ts): whether the
 *  build was made from its own release tag. */
export const BUILD_INFO_FILE = path.join("dist", "main", "build-info.json");
/** Where a team device's sessions go instead of `production` or `beta`.
 *  Sessions carry no tags, so release health can only leave them out by
 *  their environment. */
export const TEAM_DEVICE_SESSION_ENVIRONMENT = "team";

// What a release is numbered: 1.11.8 or 1.11.9-beta.3. Anything else, such
// as 1.11.8-discussion.1, is a build of our own.
const OFFICIAL_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

export function officialReleaseVersion(version: string): boolean {
  return OFFICIAL_VERSION_PATTERN.test(version);
}

export function teamDeviceForcedOn(env: NodeJS.ProcessEnv): boolean {
  const value = env[TEAM_DEVICE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function teamDeviceMarked(userDataDir: string): boolean {
  try {
    statSync(path.join(userDataDir, TEAM_DEVICE_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the packaged app was built from its release tag. Unknown (no
 * stamp, or one that cannot be read) counts as a release: a wrong guess then
 * miscounts one of our builds, never every real installation.
 */
export function readBuiltFromReleaseTag(appPath: string): boolean | undefined {
  try {
    const stamp = JSON.parse(readFileSync(path.join(appPath, BUILD_INFO_FILE), "utf8")) as { fromReleaseTag?: unknown };
    return typeof stamp?.fromReleaseTag === "boolean" ? stamp.fromReleaseTag : undefined;
  } catch {
    return undefined;
  }
}

export interface TeamDeviceFacts {
  isPackaged: boolean;
  version: string;
  fromReleaseTag?: boolean;
  marked: boolean;
  forcedOn: boolean;
}

export function teamDeviceFrom(facts: TeamDeviceFacts): boolean {
  return facts.forcedOn
    || facts.marked
    || !facts.isPackaged
    || !officialReleaseVersion(facts.version)
    || facts.fromReleaseTag === false;
}

export interface TeamDeviceSources {
  userDataDir: string;
  appPath: string;
  isPackaged: boolean;
  version: string;
  env?: NodeJS.ProcessEnv;
}

/** Read once at launch, before reports start. */
export function readTeamDevice(sources: TeamDeviceSources): boolean {
  return teamDeviceFrom({
    isPackaged: sources.isPackaged,
    version: sources.version,
    fromReleaseTag: sources.isPackaged ? readBuiltFromReleaseTag(sources.appPath) : undefined,
    marked: teamDeviceMarked(sources.userDataDir),
    forcedOn: teamDeviceForcedOn(sources.env ?? process.env)
  });
}

type EnvelopeItem = [{ type?: string } | undefined, unknown];

/**
 * Moves a team device's sessions out of `production` and `beta` on their way
 * out. Builds that are not packaged already report as `development` and stay
 * there. Error reports and usage signals keep their environment.
 */
export function moveTeamDeviceSessions(items: ReadonlyArray<EnvelopeItem>): void {
  for (const [header, payload] of items) {
    if (header?.type !== "session" && header?.type !== "sessions") continue;
    const attrs = (payload as { attrs?: { environment?: unknown } } | undefined)?.attrs;
    if (!attrs || typeof attrs !== "object") continue;
    if (attrs.environment === "production" || attrs.environment === "beta") {
      attrs.environment = TEAM_DEVICE_SESSION_ENVIRONMENT;
    }
  }
}
