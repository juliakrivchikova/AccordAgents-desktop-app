import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { app } from "electron";
import { HubClient } from "../services/hubClient";
import { compareVersions } from "../../shared/machineInstall";
import { publishHubRoster, scheduleEnrolledPhones } from "./hubRoster";
import type { DesktopApp } from "./desktopApp";

const HUB_PROGRAM_UPDATE_DELAY_MS = 60_000;
export const HUB_PROGRAM_UPDATE_RETRY_MS = 30 * 60_000;
const HUB_PROGRAM_UPDATE_MAX_TRIES = 3;

/** The link to the User's server, and its own program. */
export function createHubLink(desktopApp: DesktopApp): void {
  desktopApp.hubProgramUpdateTries = new Map<string, number>();

  /** The update made before the app's window opens is running. */
  desktopApp.hubProgramUpdatingBeforeOpening = false;
}

export async function startHubLink(desktopApp: DesktopApp): Promise<void> {
  const config = await desktopApp.settingsService.getHubConfig();
  if (!config) return;
  desktopApp.hubOwnerConfirmed = false;
  const identity = () => desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
  desktopApp.hubClient = new HubClient({
    url: config.url, identity,
    // The server this computer set up proves it is that one before the
    // roster, invites or start keys go to it.
    // Settings that cannot be read fail the check (nothing is sent), never pass it.
    expect: async () => {
      const current = await desktopApp.settingsService.getHubConfig();
      return current ? { hubId: current.hubId, hubKey: current.hubKey } : undefined;
    }
  });
  // Another server (or the first): every machine's settings are put there.
  desktopApp.machineLinkService?.resetPublishedSettings();
  const blobClient = desktopApp.hubClient;
  // A picture the User sent from the phone is read from the server.
  desktopApp.chatService.setHubBlobReader((reference) => blobClient.downloadBytes(reference));
  // A member's session moving to a cloud machine goes up from here.
  desktopApp.chatService.setHubBlobWriter((bytes) => blobClient.uploadBytes(bytes));
  desktopApp.hubPhonePublisher.reset();
  desktopApp.hubMemberRulesPublisher.reset();
  publishHubRoster(desktopApp);
  // Phones that paired while this desktop was away are on the server's
  // roster: learned now, and the roster is read again from then on.
  scheduleEnrolledPhones(desktopApp, 0);
  void desktopApp.debugLogService.write("hub.link.started", { url: config.url });
  scheduleHubProgramUpdate(desktopApp);
}

export function scheduleHubProgramUpdate(desktopApp: DesktopApp, delayMs = HUB_PROGRAM_UPDATE_DELAY_MS, options: { replace?: boolean } = {}): void {
  if (desktopApp.hubProgramUpdateTimer && options.replace) {
    clearTimeout(desktopApp.hubProgramUpdateTimer);
    desktopApp.hubProgramUpdateTimer = undefined;
  }
  if (desktopApp.hubProgramUpdateTimer) return;
  desktopApp.hubProgramUpdateTimer = setTimeout(() => {
    desktopApp.hubProgramUpdateTimer = undefined;
    void updateHubProgramIfBehind(desktopApp);
  }, delayMs);
  desktopApp.hubProgramUpdateTimer.unref?.();
}

/** The update the User's server's program is due, if any: only the installed
 *  app updates it by itself (a build run from a checkout, or pointed at a
 *  test server, never puts its program there), only a server this desktop
 *  set up (it holds the key to it) and syncs with, and only when its program
 *  is older than this desktop. */
export async function hubProgramUpdateDue(desktopApp: DesktopApp): Promise<{ from: string; to: string } | undefined> {
  if (!app.isPackaged || process.env.ACCORDAGENTS_HUB_URL?.trim()) return undefined;
  const config = await desktopApp.settingsService.getHubConfig().catch(() => undefined);
  const installed = config?.server?.installedVersion;
  const desktop = app.getVersion();
  if (!config?.server || !installed || compareVersions(desktop, installed) <= 0) return undefined;
  try {
    if (new URL(config.url).hostname !== config.server.ip) return undefined;
  } catch {
    return undefined;
  }
  return { from: installed, to: desktop };
}

/** Whether this start may update the server before opening: the first one
 *  for this desktop version. Noted before it is tried, so a start that is
 *  killed midway does not try again on every start. */
export async function claimServerUpdateBeforeOpening(version: string): Promise<boolean> {
  const file = path.join(app.getPath("userData"), "hub", "update-before-opening.json");
  try {
    const noted = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
    if (noted.version === version) return false;
  } catch {
    // Never tried, or unreadable: tried now.
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version, at: new Date().toISOString() }));
  return true;
}

async function updateHubProgramIfBehind(desktopApp: DesktopApp): Promise<void> {
  const due = await hubProgramUpdateDue(desktopApp);
  if (!due) return;
  const desktop = due.to;
  if (desktopApp.hubProgramUpdatingBeforeOpening) {
    scheduleHubProgramUpdate(desktopApp, 5 * 60_000);
    return;
  }
  // The server has just confirmed this desktop is its owner (only the owner
  // sets its devices): a desktop that is not cannot replace its program.
  if (!desktopApp.hubOwnerConfirmed) {
    // Not confirmed yet (the server away, this desktop offline): asked again.
    scheduleHubProgramUpdate(desktopApp, 5 * 60_000);
    return;
  }
  // Updating stops the server for a few seconds: not while a member works.
  const busy = desktopApp.chatService.liveRunIds().length > 0
    || desktopApp.machineInstallerService.hasActiveOperations()
    || (await desktopApp.machineLinkService?.anyMachineBusy().catch(() => true)) === true;
  if (busy) {
    scheduleHubProgramUpdate(desktopApp, 5 * 60_000);
    return;
  }
  const tries = desktopApp.hubProgramUpdateTries.get(desktop) ?? 0;
  if (tries >= HUB_PROGRAM_UPDATE_MAX_TRIES) return;
  desktopApp.hubProgramUpdateTries.set(desktop, tries + 1);
  void desktopApp.debugLogService.write("hub.program-update.start", { from: due.from, to: desktop, attempt: tries + 1 });
  try {
    const state = await desktopApp.hubInstaller.install({});
    void desktopApp.debugLogService.write("hub.program-update.finished", { status: state.status, message: state.message ?? "" });
    if (state.status !== "ready") scheduleHubProgramUpdate(desktopApp, HUB_PROGRAM_UPDATE_RETRY_MS);
  } catch (error) {
    void desktopApp.debugLogService.write("hub.program-update.error", { message: error instanceof Error ? error.message : String(error) });
    scheduleHubProgramUpdate(desktopApp, HUB_PROGRAM_UPDATE_RETRY_MS);
  }
}
