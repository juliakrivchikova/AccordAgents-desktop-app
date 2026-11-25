import { isAcceptableHubUrl } from "../../../../shared/hubProtocol";
import { isHubServerAddress, type HubLinkConfig } from "../../../../shared/hubSetup";

export function hubSettingField(value: unknown): { hub?: HubLinkConfig } {
  const hub = normalizeHubSetting(value);
  return hub ? { hub } : {};
}

/** The hub this desktop syncs with, as read back from disk. */
function normalizeHubSetting(value: unknown): HubLinkConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const hub = value as { url?: unknown; hubId?: unknown; hubKey?: unknown; server?: unknown };
  if (typeof hub.url !== "string" || !isAcceptableHubUrl(hub.url)) return undefined;
  let server: import("../../../../shared/hubSetup").HubServerRecord | undefined;
  if (hub.server && typeof hub.server === "object") {
    const record = hub.server as Record<string, unknown>;
    // Only a record setup could have written: its fields go into SSH commands.
    if (isHubServerAddress(record)) {
      server = {
        version: 1, region: record.region as string, instanceName: record.instanceName as string, ip: record.ip as string, user: record.user as string,
        ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
        ...(typeof record.installedVersion === "string" ? { installedVersion: record.installedVersion } : {})
      };
    }
  }
  return { url: hub.url, ...(typeof hub.hubId === "string" && hub.hubId ? { hubId: hub.hubId } : {}),
    ...(typeof hub.hubKey === "string" && hub.hubKey ? { hubKey: hub.hubKey } : {}), ...(server ? { server } : {}) };
}

/** A phone invite this desktop made, and what became of it. */
export interface StoredHubPhoneInvite {
  inviteId: string;
  issuedAt: string;
  expiresAt: string;
  state: "pending" | "enrolled" | "revoked";
  /** The phone that enrolled with it. */
  deviceId?: string;
  settledAt?: string;
}

/** Settled invites this desktop remembers (the newest). */
const HUB_PHONE_INVITES_KEPT = 200;

/** The phone invites kept: every revoked one (each keeps its phone out for
 *  good), and the newest others. */
export function keptPhoneInvites(invites: StoredHubPhoneInvite[]): StoredHubPhoneInvite[] {
  const revoked = invites.filter((invite) => invite.state === "revoked");
  const others = invites.filter((invite) => invite.state !== "revoked").slice(-HUB_PHONE_INVITES_KEPT);
  return [...revoked, ...others];
}

export function isStoredHubPhoneInvite(value: unknown): value is StoredHubPhoneInvite {
  const invite = value as Partial<StoredHubPhoneInvite> | undefined;
  return Boolean(invite && typeof invite.inviteId === "string" && invite.inviteId && typeof invite.issuedAt === "string" &&
    typeof invite.expiresAt === "string" && (invite.state === "pending" || invite.state === "enrolled" || invite.state === "revoked") &&
    (invite.deviceId === undefined || typeof invite.deviceId === "string"));
}
