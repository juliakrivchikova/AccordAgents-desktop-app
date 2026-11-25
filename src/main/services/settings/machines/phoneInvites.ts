import { createHash } from "node:crypto";
import { isTrustedDeviceRecord, trustedDeviceIdMatchesKey, type TrustedDeviceRecord } from "../../../../shared/machineTrust";
import { HUB_PHONE_INVITE_MAX_LIFETIME_MS } from "../../../../shared/hubProtocol";
import { keptPhoneInvites, type StoredHubPhoneInvite } from "./hubSetting";
import { removeDeviceTrust } from "./storedMachines";
import type { SettingsModules } from "../modules";

/** Invites that let a phone in. */
export class PhoneInvites {
  constructor(private readonly settings: Pick<SettingsModules, "settingsStore" | "trustedDevices">) {}

  /** A phone invite this desktop just registered with its server. */
  savePhoneInvite(invite: Omit<StoredHubPhoneInvite, "state">): Promise<void> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
      const kept = (stored.hubPhoneInvites ?? []).filter((entry) => entry.inviteId !== invite.inviteId);
      kept.push({ ...invite, state: "pending" });
      // The settled ones are what the server and the machines are told; an
      // unused one that expired is of no use to anyone.
      const now = Date.now();
      stored.hubPhoneInvites = keptPhoneInvites(kept
        .filter((entry) => entry.state !== "pending" || Date.parse(entry.expiresAt) > now - HUB_PHONE_INVITE_MAX_LIFETIME_MS));
      await this.settings.settingsStore.writeStored(stored, true);
    });
  }

  /**
   * A phone that enrolled with one of this desktop's invites (its certificate
   * already checked against this desktop's key). Trusted unless the invite
   * was revoked: then it stays out, whatever it shows again.
   */
  admitInvitedPhone(record: TrustedDeviceRecord & { inviteId: string }): Promise<boolean> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      if (!isTrustedDeviceRecord(record) || !trustedDeviceIdMatchesKey(record, bytes => createHash("sha256").update(bytes).digest("hex"))) {
        throw new Error("The phone's identity does not match its signing key.");
      }
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Trusted devices could not be read; the stored list was left untouched.");
      const invites = stored.hubPhoneInvites ?? [];
      const invite = invites.find((entry) => entry.inviteId === record.inviteId);
      if (invite?.state === "revoked") return false;
      // A phone removed here comes back only through an invite this desktop
      // knows; an old certificate it no longer has a record of does not.
      if (!invite && stored.machineDeviceRevocations?.[record.deviceId]) return false;
      if (invite?.state === "enrolled" && invite.deviceId && invite.deviceId !== record.deviceId) return false;
      const settledAt = new Date().toISOString();
      const next: StoredHubPhoneInvite = invite
        ? { ...invite, state: "enrolled", deviceId: record.deviceId, settledAt }
        : { inviteId: record.inviteId, issuedAt: record.addedAt, expiresAt: record.addedAt, state: "enrolled", deviceId: record.deviceId, settledAt };
      // A phone paired again replaces its own old entry: the code it paired
      // with before is settled, and no longer names it, so revoking that old
      // code later cannot take the phone off.
      const others = invites.filter((entry) => entry.inviteId !== record.inviteId).map((entry): StoredHubPhoneInvite => {
        if (entry.deviceId !== record.deviceId) return entry;
        const { deviceId: _replaced, ...rest } = entry;
        return { ...rest, state: "revoked", settledAt };
      });
      stored.hubPhoneInvites = keptPhoneInvites([...others, next]);
      const records = (stored.trustedDevices ?? []).filter((entry) => entry.deviceId !== record.deviceId);
      records.push({ ...record });
      stored.trustedDevices = records;
      // A device removed before is trusted again only through a new invite,
      // which this is.
      if (stored.machineDeviceRevocations?.[record.deviceId]) {
        const { [record.deviceId]: _removed, ...rest } = stored.machineDeviceRevocations;
        stored.machineDeviceRevocations = rest;
      }
      await this.settings.settingsStore.writeStored(stored, true);
      return true;
    });
  }

  /** Revokes an invite: unused, it can no longer be used; used, its phone
   *  is removed. Returns the phone removed, if any. */
  revokePhoneInvite(inviteId: string): Promise<string | undefined> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
      const invite = (stored.hubPhoneInvites ?? []).find((entry) => entry.inviteId === inviteId);
      if (!invite) return undefined;
      const deviceId = invite.deviceId;
      if (deviceId) removeDeviceTrust(stored, deviceId);
      stored.hubPhoneInvites = (stored.hubPhoneInvites ?? []).map((entry) =>
        entry.inviteId === inviteId ? { ...entry, state: "revoked" as const, settledAt: new Date().toISOString() } : entry);
      await this.settings.settingsStore.writeStored(stored, true);
      return deviceId;
    });
  }

  async listPhoneInvites(): Promise<StoredHubPhoneInvite[]> {
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Settings could not be read.");
    return (stored.hubPhoneInvites ?? []).map((invite) => ({ ...invite }));
  }

  /** The invites the server and the machines are told are settled. */
  async resolvedPhoneInviteIds(): Promise<string[]> {
    return (await this.listPhoneInvites()).filter((invite) => invite.state !== "pending").map((invite) => invite.inviteId);
  }
}
