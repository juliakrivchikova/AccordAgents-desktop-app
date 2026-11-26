import path from "node:path";
import { app } from "electron";
import { desktopUserDataDirOverride } from "../platform";
import { startCrashReporting } from "../services/crashReporting";
import { usageProfileUsedBefore } from "../services/usageMilestones";
import { discardCrashReportData, discardCrashReportDataOfOlderRules, loadOrCreateCrashReportInstallId, readCrashReportsEnabled } from "../services/crashReportPreferences";
import { readTeamDevice } from "../services/teamDevice";
import type { DesktopApp } from "./desktopApp";

/** The profile the app runs in, before anything reads or writes it. */
export function prepareProfile(desktopApp: DesktopApp): void {
  desktopApp.userDataDirOverride = desktopUserDataDirOverride();

  if (desktopApp.userDataDirOverride) {
    app.setPath("userData", desktopApp.userDataDirOverride);
  }

  // Whether this profile was used by an earlier launch (its chat database is
  // there), read before anything of this launch writes to it: an installation
  // first seen by the usage signals is new only when it was not.
  desktopApp.profileUsedBeforeLaunch = usageProfileUsedBefore(app.getPath("userData"));

  // One of the team's own installations: a build that is not a release, or a
  // computer marked by hand. Read once, like the choice itself.
  desktopApp.teamDevice = readTeamDevice({
    userDataDir: app.getPath("userData"),
    defaultUserDataDir: path.join(app.getPath("appData"), app.getName()),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    version: app.getVersion()
  });

  // Once the profile directory is final and before the app is ready: the SDK
  // registers the scheme the window reports through and starts the native
  // crash handler, and neither can happen later.
  desktopApp.crashReportingStart = readCrashReportsEnabled(app.getPath("userData"))
    ? startCrashReportingUnderCurrentRules(desktopApp.teamDevice)
    : discardCrashReportDataAtLaunch();
}

/** What an older build kept for later goes first: the SDK resends its queue
 *  as stored, past the rules that would remove fields from it. */
function startCrashReportingUnderCurrentRules(teamDevice: boolean): ReturnType<typeof startCrashReporting> {
  try {
    discardCrashReportDataOfOlderRules(app.getPath("userData"));
  } catch (error) {
    return { active: false, error: error instanceof Error ? error.message : String(error) };
  }
  return startCrashReporting(loadOrCreateCrashReportInstallId(app.getPath("userData")), { teamDevice });
}

function discardCrashReportDataAtLaunch(): { active: false; error?: string } {
  try {
    discardCrashReportData(app.getPath("userData"));
    return { active: false };
  } catch (error) {
    return { active: false, error: error instanceof Error ? error.message : String(error) };
  }
}
