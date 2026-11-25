import { randomBytes, randomUUID } from "node:crypto";
import { signHubText } from "../services/hubAuth";
import { HUB_PHONE_PROTOCOL_VERSION, hubPhoneInviteSigningText, type HubPhoneInvite } from "../../shared/hubProtocol";
import { HUB_PHONE_ROSTER_PAIRING_MS, scheduleEnrolledPhones } from "./hubRoster";
import { sha256Hex } from "./machineRequests";
import type { DesktopApp } from "./desktopApp";

/** How long a phone pairing code may wait to be scanned. */
const PHONE_INVITE_TTL_MS = 10 * 60_000;

/**
 * A one-time code for a phone: the desktop signs an invite with its own key,
 * registers it with the User's server, and shows the address of the server,
 * the token and the server's id as a QR code. The phone pairs with the server
 * itself, so the desktop may be closed by then.
 */
export async function createPhoneInvite(desktopApp: DesktopApp, request: import("../../shared/types").CreatePhoneInviteRequest): Promise<import("../../shared/types").CreatePhoneInviteResult> {
  const hub = await desktopApp.settingsService.getHubConfig().catch(() => undefined);
  if (!hub || !desktopApp.hubClient) throw new Error("Set up your server first (Your server, above): the phone connects through it.");
  const health = await desktopApp.hubClient.health();
  if (!Number.isSafeInteger(health.protocol) || health.protocol < HUB_PHONE_PROTOCOL_VERSION) {
    throw new Error("Your server runs an older program. Update it from Settings → Your server, then pair the phone.");
  }
  if (!desktopApp.hubOwnerConfirmed) throw new Error("Your server has not confirmed this computer yet. Try again in a moment.");
  const identity = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
  const token = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  const invite: HubPhoneInvite = {
    version: 1,
    inviteId: `invite-${randomUUID()}`,
    hubId: health.hubId,
    issuerDeviceId: identity.originId,
    tokenHash: sha256Hex(token),
    // A phone reads and writes every chat, as the desktop does: the server's
    // order carries no per-chat fences, so a one-chat phone is not offered.
    scope: { scope: "device" },
    name: "Phone",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + PHONE_INVITE_TTL_MS).toISOString()
  };
  await desktopApp.hubClient.putPhoneInvite(invite, signHubText(identity, hubPhoneInviteSigningText(invite)));
  await desktopApp.settingsService.savePhoneInvite({ inviteId: invite.inviteId, issuedAt: invite.issuedAt, expiresAt: invite.expiresAt });
  const settings = await desktopApp.settingsService.getPublicSettings();
  const origin = request.staticOriginUrl?.trim() || settings.mobileControl.defaults.staticOriginUrl;
  if (!origin) throw new Error("The phone app's address is not set.");
  const pwaUrl = new URL(origin);
  pwaUrl.searchParams.set("pair", "server");
  // All three only in the fragment: the phone's app site never sees them.
  pwaUrl.hash = new URLSearchParams({ hub: hub.url, t: token, id: health.hubId }).toString();
  void desktopApp.debugLogService.write("hub.phone.invite-created", { inviteId: invite.inviteId, scope: invite.scope.scope });
  // The phone pairs with the server, not here: its roster is read often
  // while the code waits to be used, so the phone is named here soon after.
  scheduleEnrolledPhones(desktopApp, HUB_PHONE_ROSTER_PAIRING_MS);
  return { inviteId: invite.inviteId, expiresAt: invite.expiresAt, pwaUrl: pwaUrl.toString(), qrPayload: pwaUrl.toString() };
}
