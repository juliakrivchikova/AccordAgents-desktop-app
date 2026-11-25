import { deviceIdForPublicKey, hubCertificateCrypto } from "../services/hubAuth";
import { verifyHubPhoneEnrollment } from "../../shared/hubProtocol";
import { machineSigningKey } from "../../shared/machineLink";
import { hubPhones } from "./chatServices";
import type { DesktopApp } from "./desktopApp";

/** How often the server's roster is read for phones that paired: every
 *  minute, and every few seconds while an invite this desktop made waits to
 *  be used (the User is pairing a phone right now). */
const HUB_PHONE_ROSTER_EVERY_MS = 60_000;

export const HUB_PHONE_ROSTER_PAIRING_MS = 5_000;

/** The devices on the User's server. */
export function createHubRoster(desktopApp: DesktopApp): void {
  /** When each device last read the server's feed, as the server says; asked
   *  at most once a minute (the inactive-machine question reads it). */
  desktopApp.hubFeedReadsCache = { at: 0 };
}

/**
 * A phone that pairs with one of this desktop's invites is on the server's
 * roster from that moment (the server checked the invite's token). This
 * desktop learns it from there, not from anything the phone writes: it checks
 * that the invite is its own (signed with its key) and the acceptance the
 * phone's (signed with the phone's key, inside the invite's window), and from
 * then on names the phone itself, on the server's roster and on every
 * machine. A phone whose invite this desktop revoked is not admitted, and the
 * next roster it publishes takes it off. Returns how many were admitted.
 */
async function admitEnrolledPhones(desktopApp: DesktopApp): Promise<number> {
  const client = desktopApp.hubClient;
  if (!client) return 0;
  const roster = await client.roster();
  const identity = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
  const trusted = await desktopApp.settingsService.listTrustedDevices().catch(() => []);
  let admittedCount = 0;
  for (const record of roster.enrollments ?? []) {
    const onRoster = roster.devices.find((device) => device.deviceId === record.deviceId && device.role === "phone");
    if (!onRoster || onRoster.inviteId !== record.invite?.inviteId) continue;
    // Read again every time the roster is: what is known already changes
    // nothing, and nobody is told again.
    const known = trusted.find((device) => device.deviceId === record.deviceId);
    if (known && known.inviteId === record.invite.inviteId && known.publicKeyDerBase64 === record.enrollment?.publicKeyDerBase64) continue;
    if (!verifyHubPhoneEnrollment(record, { issuerDeviceId: identity.originId, issuerPublicKeyDerBase64: identity.publicKeyDerBase64, ...hubCertificateCrypto }) ||
        record.enrollment.deviceId !== record.deviceId || onRoster.publicKeyDerBase64 !== record.enrollment.publicKeyDerBase64) {
      void desktopApp.debugLogService.write("hub.phone.enrollment-refused", { deviceId: record.deviceId, inviteId: record.invite?.inviteId ?? "" });
      continue;
    }
    const admitted = await desktopApp.settingsService.admitInvitedPhone({
      deviceId: record.enrollment.deviceId,
      publicKeyDerBase64: record.enrollment.publicKeyDerBase64,
      role: "phone",
      name: record.enrollment.name || record.invite.name || "Phone",
      addedAt: record.enrollment.enrolledAt,
      inviteId: record.invite.inviteId,
      phoneScope: record.invite.scope
    });
    void desktopApp.debugLogService.write("hub.phone.admitted", { deviceId: record.enrollment.deviceId, inviteId: record.invite.inviteId, admitted });
    if (admitted) {
      admittedCount += 1;
      desktopApp.usageMilestones?.reach("phone_paired");
    }
  }
  if (admittedCount > 0) {
    publishHubRoster(desktopApp);
    desktopApp.hubPhonePublisher.phonesChanged();
    desktopApp.hubPhonePublisher.scheduleCatalog(0);
    desktopApp.hubPhonePublisher.publishWakeKeys();
  }
  return admittedCount;
}

export function scheduleEnrolledPhones(desktopApp: DesktopApp, delayMs: number): void {
  if (desktopApp.hubPhoneRosterTimer) clearTimeout(desktopApp.hubPhoneRosterTimer);
  desktopApp.hubPhoneRosterTimer = setTimeout(() => {
    desktopApp.hubPhoneRosterTimer = undefined;
    void (async () => {
      if (desktopApp.hubClient) {
        await admitEnrolledPhones(desktopApp).catch((error: unknown) => {
          void desktopApp.debugLogService.write("hub.phone.roster-read-error", { message: error instanceof Error ? error.message : String(error) });
        });
      }
      const invites = await desktopApp.settingsService.listPhoneInvites().catch(() => []);
      const pairing = invites.some((invite) => invite.state === "pending" && Date.parse(invite.expiresAt) > Date.now());
      scheduleEnrolledPhones(desktopApp, pairing ? HUB_PHONE_ROSTER_PAIRING_MS : HUB_PHONE_ROSTER_EVERY_MS);
    })();
  }, Math.max(0, delayMs));
  desktopApp.hubPhoneRosterTimer.unref?.();
}

/**
 * Tells the hub which devices are the User's: this desktop and every machine
 * whose key it knows. The hub admits nobody else, so a machine set up here
 * can reach it before its first hello. Coalesced: a change during a publish
 * is sent once more after it.
 */
export function publishHubRoster(desktopApp: DesktopApp): void {
  if (!desktopApp.hubClient) return;
  if (desktopApp.hubRosterPublish) {
    desktopApp.hubRosterAgain = true;
    return;
  }
  const client = desktopApp.hubClient;
  if (desktopApp.hubRosterRetry) clearTimeout(desktopApp.hubRosterRetry);
  desktopApp.hubRosterRetry = undefined;
  desktopApp.hubRosterPublish = (async () => {
    const identity = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
    const machines = (await desktopApp.settingsService.listMachines()).flatMap((machine) => {
      const publicKeyDerBase64 = machineSigningKey(machine);
      // An entry whose id does not derive from its key would make the hub
      // refuse the whole list: it is left out, and said so.
      if (!machine.deviceId || !publicKeyDerBase64) return [];
      if (deviceIdForPublicKey(publicKeyDerBase64) !== machine.deviceId) {
        void desktopApp.debugLogService.write("hub.roster.inconsistent-machine", { machineId: machine.id });
        return [];
      }
      return [{ deviceId: machine.deviceId, publicKeyDerBase64, role: "machine" as const, name: machine.name, machineId: machine.id }];
    });
    // The phones paired with the server, as their invites allowed; and the
    // invites this desktop has settled, so a phone it removed stays out.
    const phones = (await hubPhones(desktopApp)).map((phone) => ({
      deviceId: phone.deviceId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone" as const, name: phone.name,
      scope: phone.phoneScope!, inviteId: phone.inviteId!
    }));
    await client.setRoster([
      { deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, role: "desktop", name: "This computer" },
      ...machines,
      ...phones
    ], await desktopApp.settingsService.resolvedPhoneInviteIds());
    desktopApp.hubRosterRetryMs = 5_000;
    desktopApp.hubOwnerConfirmed = true;
    void desktopApp.debugLogService.write("hub.roster.published", { machines: machines.length, phones: phones.length });
    // The machines it names read their settings from the server.
    void desktopApp.machineLinkService?.syncSettings().catch((error: unknown) => {
      void desktopApp.debugLogService.write("machine-link.settings.sync-error", { message: error instanceof Error ? error.message : String(error) });
    });
    desktopApp.hubPhonePublisher.scheduleCatalog();
    desktopApp.hubPhonePublisher.publishWakeKeys();
    desktopApp.hubMemberRulesPublisher.publish();
  })().catch((error: unknown) => {
    // A machine set up while the hub was away would be refused by it: the
    // list goes up again until the hub has it.
    void desktopApp.debugLogService.write("hub.roster.error", { message: error instanceof Error ? error.message : String(error), retryMs: desktopApp.hubRosterRetryMs });
    desktopApp.hubRosterRetry = setTimeout(() => { desktopApp.hubRosterRetry = undefined; publishHubRoster(desktopApp); }, desktopApp.hubRosterRetryMs);
    desktopApp.hubRosterRetry.unref?.();
    desktopApp.hubRosterRetryMs = Math.min(5 * 60_000, desktopApp.hubRosterRetryMs * 2);
  }).finally(() => {
    desktopApp.hubRosterPublish = undefined;
    if (desktopApp.hubRosterAgain) {
      desktopApp.hubRosterAgain = false;
      publishHubRoster(desktopApp);
    }
  });
}

export async function hubFeedReads(desktopApp: DesktopApp): Promise<Map<string, string> | undefined> {
  const client = desktopApp.hubClient;
  if (!client || !desktopApp.hubOwnerConfirmed) return undefined;
  if (Date.now() - desktopApp.hubFeedReadsCache.at < 60_000) return desktopApp.hubFeedReadsCache.value;
  const roster = await client.roster().catch(() => undefined);
  desktopApp.hubFeedReadsCache = { at: Date.now(), value: roster?.feedReads ? new Map(roster.feedReads.map((read) => [read.deviceId, read.readAt])) : desktopApp.hubFeedReadsCache.value };
  return desktopApp.hubFeedReadsCache.value;
}

/**
 * Plain lines for Settings → Your server about this computer's link to it:
 * what it wrote and has not got to the server yet, and why the last attempt
 * failed (the server keeps every failed attempt's reason, Д12).
 */
export async function hubLinkNotices(desktopApp: DesktopApp): Promise<string[]> {
  const status = await desktopApp.serverChatLink.status().catch(() => undefined);
  if (!status) return [];
  const lines: string[] = [];
  if (!status.ready) lines.push("This computer is still moving its chats to your server; new messages wait for it.");
  if (status.queued > 0 && (status.unreachableSince !== undefined || !status.ready)) {
    lines.push(`${status.queued} change${status.queued === 1 ? "" : "s"} from this computer ${status.queued === 1 ? "is" : "are"} waiting to reach your server.`);
  }
  if (status.lastError && status.unreachableSince !== undefined) lines.push(`Last attempt: ${status.lastError}`);
  return lines;
}
